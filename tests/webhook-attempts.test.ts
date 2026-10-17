import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { webhookAttempts, webhookDeliveries } from "@/lib/db/schema";
import {
  createEndpoint,
  emit,
  listDeliveryAttempts,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@/lib/services/events";
import { getDeliveryForMerchant, listDeliveries, listEndpoints, sendTestDelivery } from "@/lib/webhooks/attempts";
import { dispatchDue, type Resolve } from "@/lib/webhooks/dispatch";
import { verifySignature } from "@/lib/webhooks/sign";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

const T0 = new Date("2026-10-16T12:00:00.000Z");

// DNS falso: os testes nunca saem para a rede.
const publicDns: Resolve = async () => [{ address: "93.184.216.34" }];
const netError = (code: string, message: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

// Resposta com corpo controlável (para o teste do snippet).
function sendBody(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}
function sendStatus(...responses: Array<number | Error>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (typeof r !== "number") throw r;
    return new Response(r === 204 ? null : "ok", { status: r });
  }) as typeof fetch;
}

async function setup(events: WebhookEventType[] = ["charge.paid"]) {
  const merchantId = await newMerchant(d, 1);
  const ep = await createEndpoint(merchantId, { url: "https://loja.example.com/hooks/vantri", events });
  await d.transaction((tx) => emit(tx, merchantId, "charge.paid", { id: "ch_1", amount: 14990 }));
  await d.update(webhookDeliveries).set({ nextAttemptAt: T0 });
  const [delivery] = await d.select().from(webhookDeliveries);
  return { merchantId, ep, delivery };
}

const attemptsOf = (deliveryId: string) =>
  d.select().from(webhookAttempts).where(eq(webhookAttempts.deliveryId, deliveryId)).orderBy(asc(webhookAttempts.n));

it("each dispatch writes one webhook_attempts row with n, latency and 2xx code", async () => {
  const { delivery } = await setup();
  expect(await dispatchDue(50, T0, sendStatus(204), publicDns)).toEqual({ delivered: 1, failed: 0 });

  const rows = await attemptsOf(delivery.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ deliveryId: delivery.id, n: 1, statusCode: 204, error: null });
  expect(rows[0].latencyMs).toBeTypeOf("number");
  expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
});

it("a failing send records the generic category and increments n", async () => {
  const { delivery } = await setup();
  // 1ª falha: conexão recusada; 2ª: resposta 500.
  let now = T0;
  expect(await dispatchDue(50, now, sendStatus(netError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.9:443")), publicDns)).toEqual({
    delivered: 0,
    failed: 1,
  });
  now = (await d.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)))[0].nextAttemptAt;
  expect(await dispatchDue(50, now, sendStatus(500), publicDns)).toEqual({ delivered: 0, failed: 1 });

  const rows = await attemptsOf(delivery.id);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ n: 1, statusCode: null, error: "conexão recusada" });
  expect(rows[1]).toMatchObject({ n: 2, statusCode: 500, error: "resposta HTTP 500" });
  // A categoria nunca traz o IP/porta crus.
  expect(rows[0].error).not.toContain("10.0.0.9");
});

it("a blocked address records an attempt with the generic category, never the raw IP", async () => {
  const { delivery } = await setup();
  const toInternal: Resolve = async () => [{ address: "10.0.0.5" }];
  expect(await dispatchDue(50, T0, sendStatus(200), toInternal)).toEqual({ delivered: 0, failed: 1 });

  const rows = await attemptsOf(delivery.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ n: 1, statusCode: null, error: "endereço bloqueado" });
  expect(rows[0].responseSnippet).toBeNull();
});

it("response_snippet is capped at 1KB, strips control chars and never contains the secret", async () => {
  const { ep, delivery } = await setup();
  const big = `início\u0000\u0007\n${"x".repeat(5000)}${ep.secret}`;
  expect(await dispatchDue(50, T0, sendBody(500, big), publicDns)).toEqual({ delivered: 0, failed: 1 });

  const [a] = await attemptsOf(delivery.id);
  expect(a.responseSnippet).not.toBeNull();
  expect(a.responseSnippet!.length).toBeLessThanOrEqual(1024);
  // O segredo fica depois dos 5000 chars → cortado fora dos 1024.
  expect(a.responseSnippet).not.toContain(ep.secret);
  // Controles de C0 removidos (resta o texto legível).
  expect(a.responseSnippet).toMatch(/^início/);
  expect(a.responseSnippet).not.toMatch(/[\u0000-\u0008]/);
});

it("listDeliveryAttempts: só o dono lê; outro lojista e id inválido não veem nada", async () => {
  const { merchantId, delivery } = await setup();
  const other = await newMerchant(d, 2);
  // Duas tentativas gravadas (uma falha, um sucesso).
  let now = T0;
  await dispatchDue(50, now, sendStatus(500), publicDns);
  now = (await d.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)))[0].nextAttemptAt;
  await dispatchDue(50, now, sendStatus(204), publicDns);

  const mine = await listDeliveryAttempts(merchantId, delivery.id);
  expect(mine).toHaveLength(2);
  expect(mine.map((a) => a.n)).toEqual([1, 2]);
  expect(mine[1]).toMatchObject({ statusCode: 204, error: null });

  // Lojista de outro dono → vazio (IDOR). id inválido → vazio.
  expect(await listDeliveryAttempts(other, delivery.id)).toEqual([]);
  expect(await listDeliveryAttempts(merchantId, "nao-e-uuid")).toEqual([]);
});

it("endpoint de outro lojista nunca aparece: join passa pelo merchant", async () => {
  const { delivery } = await setup();
  const other = await newMerchant(d, 2);
  // Cria uma entrega do OUTRO lojista com uma tentativa; pedir a do primeiro não traz a do segundo.
  const ep2 = await createEndpoint(other, { url: "https://b.example.com/h", events: ["charge.paid"] });
  const [dl2] = await d
    .insert(webhookDeliveries)
    .values({ endpointId: ep2.id, eventId: "evt_2", eventType: "charge.paid", payload: {}, status: "failed" })
    .returning();
  await d.insert(webhookAttempts).values({ deliveryId: dl2.id, n: 1, statusCode: 500, latencyMs: 1 });

  expect(await listDeliveryAttempts(other, delivery.id)).toEqual([]);
  expect((await listDeliveryAttempts(other, dl2.id)).map((a) => a.n)).toEqual([1]);
});

// ---- Testar envio, inspetor (lista/detalhe) e endpoints públicos (lib/webhooks/attempts.ts) ----

const URL_A = "https://loja.example.com/hooks/vantri";
const toInternal: Resolve = async () => [{ address: "10.0.0.5" }];

it("sendTestDelivery to a private-IP endpoint is blocked: same sendOne guard, send never called", async () => {
  const m = await newMerchant(d, 1);
  const ep = await createEndpoint(m, { url: URL_A, events: ["charge.paid"] });
  await createEndpoint(m, { url: "https://outra.example.com/h", events: ["charge.paid"] }); // irmão: não recebe nada
  const send = vi.fn<typeof fetch>(sendStatus(204));

  expect(await sendTestDelivery(ep.id, m, send, toInternal)).toEqual({
    delivered: false,
    statusCode: null,
    error: "endereço bloqueado",
  });
  expect(send).not.toHaveBeenCalled();

  // Uma entrega só, do endpoint testado, com o payload de teste e a tentativa com a categoria (nunca o IP).
  const rows = await d.select().from(webhookDeliveries);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ endpointId: ep.id, eventType: "webhook.test", status: "failed", attempts: 1 });
  expect(rows[0].payload).toMatchObject({ type: "webhook.test", data: { test: true } });
  expect((rows[0].payload as { id: string }).id).toMatch(/^evt_test_[0-9A-Za-z]{20}$/);
  expect(await attemptsOf(rows[0].id)).toMatchObject([{ n: 1, statusCode: null, error: "endereço bloqueado" }]);

  // Estado final: o dispatcher nunca pega o teste depois (não reenvia sozinho).
  expect(await dispatchDue(50, new Date(Date.now() + 2 * 86_400_000), send, publicDns)).toEqual({ delivered: 0, failed: 0 });
  expect(send).not.toHaveBeenCalled();
});

it("sendTestDelivery delivers a signed POST via sendOne and records it; webhook.test is not subscribable", async () => {
  const m = await newMerchant(d, 1);
  const ep = await createEndpoint(m, { url: URL_A, events: ["charge.paid"] });
  const send = vi.fn<typeof fetch>(sendBody(200, "recebido"));

  expect(await sendTestDelivery(ep.id, m, send, publicDns)).toEqual({ delivered: true, statusCode: 200, error: null });
  expect(send).toHaveBeenCalledTimes(1);
  const [url, init] = send.mock.calls[0];
  expect(url).toBe(URL_A);
  const body = String(init!.body);
  expect(JSON.parse(body)).toMatchObject({ type: "webhook.test", data: { test: true } });
  const sig = (init!.headers as Record<string, string>)["X-Vantri-Signature"];
  expect(verifySignature(ep.secret, body, sig, Math.floor(Date.now() / 1000))).toBe(true);

  const [row] = await d.select().from(webhookDeliveries);
  expect(row).toMatchObject({ status: "delivered", attempts: 1, lastStatusCode: 200, lastError: null });
  expect(row.deliveredAt).not.toBeNull();
  expect(await attemptsOf(row.id)).toMatchObject([{ n: 1, statusCode: 200, error: null, responseSnippet: "recebido" }]);

  // Tipo interno: fora do catálogo e recusado na criação.
  expect(WEBHOOK_EVENT_TYPES).not.toContain("webhook.test");
  await expect(
    createEndpoint(m, { url: URL_A, events: ["webhook.test" as WebhookEventType] }),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

it("sendTestDelivery of other merchant's endpoint → not_found; nothing sent or recorded", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const ep = await createEndpoint(m, { url: URL_A, events: ["charge.paid"] });
  const send = vi.fn<typeof fetch>(sendStatus(204));

  await expect(sendTestDelivery(ep.id, other, send, publicDns)).rejects.toMatchObject({ code: "not_found" });
  await expect(sendTestDelivery("nao-e-uuid", m, send, publicDns)).rejects.toMatchObject({ code: "not_found" });
  expect(send).not.toHaveBeenCalled();
  expect(await d.$count(webhookDeliveries)).toBe(0);
});

it("getDeliveryForMerchant: owner gets delivery + endpoint + attempts by n; other merchant/unknown/invalid → null", async () => {
  const { merchantId, delivery } = await setup();
  const other = await newMerchant(d, 2);
  await dispatchDue(50, T0, sendStatus(500), publicDns);
  const retryAt = (await d.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)))[0].nextAttemptAt;
  await dispatchDue(50, retryAt, sendStatus(204), publicDns);

  const got = await getDeliveryForMerchant(merchantId, delivery.id);
  expect(got).toMatchObject({
    delivery: { id: delivery.id, status: "delivered", attempts: 2, payload: { type: "charge.paid" } },
    endpoint: { url: URL_A, description: null },
  });
  expect(got!.attempts.map((a) => [a.n, a.statusCode])).toEqual([
    [1, 500],
    [2, 204],
  ]);
  expect(Object.keys(got!.endpoint).sort()).toEqual(["description", "url"]); // nunca o segredo

  expect(await getDeliveryForMerchant(other, delivery.id)).toBeNull();
  expect(await getDeliveryForMerchant(merchantId, "00000000-0000-4000-8000-000000000000")).toBeNull();
  expect(await getDeliveryForMerchant(merchantId, "nao-e-uuid")).toBeNull();
});

it("listDeliveries term finds a delivery by its payload id (or transaction id) across periods, merchant-scoped", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const ep = await createEndpoint(m, { url: URL_A, events: ["charge.paid"] });
  const alien = await createEndpoint(other, { url: "https://b.example.com/h", events: ["charge.paid"] });
  const oldPayload = {
    id: "evt_antigo_0123456789",
    type: "charge.paid",
    data: { id: "ch_antiga_00001", end_to_end_id: "E12345678202501011200abcdefghijk" },
  };
  const row = (endpointId: string, payload: { id: string }, createdAt: Date) => ({
    endpointId,
    eventId: payload.id,
    eventType: "charge.paid",
    payload,
    status: "delivered" as const,
    createdAt,
  });
  const [old] = await d
    .insert(webhookDeliveries)
    .values(row(ep.id, oldPayload, new Date("2025-01-01T12:00:00Z")))
    .returning();
  // A lista mostra a latência da ÚLTIMA tentativa (maior n).
  await d.insert(webhookAttempts).values([
    { deliveryId: old.id, n: 2, statusCode: 204, latencyMs: 222 },
    { deliveryId: old.id, n: 1, statusCode: 500, latencyMs: 111 },
  ]);
  await d.insert(webhookDeliveries).values([
    row(ep.id, { id: "evt_recente_0123456789" }, T0),
    row(alien.id, oldPayload, T0), // mesmo identificador em outro lojista: não pode vazar
  ]);

  // Período que não cobre 2025: com termo, o período é ignorado e a antiga aparece (só a do lojista).
  const ids = async (f: Parameters<typeof listDeliveries>[1]) => (await listDeliveries(m, f)).data.map((r) => r.id);
  expect(await ids({ from: "2026-10-01", to: "2026-10-31", term: "evt_antigo_0123456789" })).toEqual([old.id]);
  expect(await ids({ from: "2026-10-01", to: "2026-10-31" })).not.toContain(old.id);
  // Identificador da transação (data.id / E2E) também acha.
  expect(await ids({ term: "ch_antiga_00001" })).toEqual([old.id]);
  expect(await ids({ term: "  E12345678202501011200abcdefghijk " })).toEqual([old.id]);

  const [first] = (await listDeliveries(m, { term: "evt_antigo_0123456789" })).data;
  expect(first).toMatchObject({ url: URL_A, endpointDescription: null, latencyMs: 222 });
  expect(first).not.toHaveProperty("payload");

  // Termo curto pede o identificador completo; termo vazio = sem busca.
  await expect(listDeliveries(m, { term: "evt_ant" })).rejects.toMatchObject({ code: "invalid_request" });
  expect(await ids({ term: "" })).toHaveLength(2);
});

it("listDeliveries paginates newest first, filters by endpoint/status/Brasília day; foreign cursor → empty page", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const a = await createEndpoint(m, { url: URL_A, events: ["charge.paid"] });
  const b = await createEndpoint(m, { url: "https://b.example.com/h", events: ["charge.paid"] });
  const alien = await createEndpoint(other, { url: "https://c.example.com/h", events: ["charge.paid"] });
  // at[2] = 12/10 23:30 em Brasília (já 13/10 em UTC): o dia é o de Brasília.
  const at = ["2026-10-10T15:00:00Z", "2026-10-11T15:00:00Z", "2026-10-13T02:30:00Z", "2026-10-13T15:00:00Z", "2026-10-14T15:00:00Z"];
  const ids: string[] = [];
  for (const [i, ts] of at.entries()) {
    const [r] = await d
      .insert(webhookDeliveries)
      .values({
        endpointId: i % 2 ? b.id : a.id,
        eventId: `evt_${i}`,
        eventType: "charge.paid",
        payload: { id: `evt_${i}` },
        status: i === 4 ? "failed" : "delivered",
        createdAt: new Date(ts),
      })
      .returning();
    ids.push(r.id);
  }
  const [foreign] = await d
    .insert(webhookDeliveries)
    .values({ endpointId: alien.id, eventId: "evt_x", eventType: "charge.paid", payload: {}, status: "delivered", createdAt: new Date(at[2]) })
    .returning();

  // Páginas de 2, mais nova primeiro, sem repetir e sem a entrega do outro lojista.
  const p1 = await listDeliveries(m, { limit: 2 });
  const p2 = await listDeliveries(m, { limit: 2, cursor: p1.nextCursor! });
  const p3 = await listDeliveries(m, { limit: 2, cursor: p2.nextCursor! });
  expect([p1, p2, p3].map((p) => p.data.map((r) => r.id))).toEqual([[ids[4], ids[3]], [ids[2], ids[1]], [ids[0]]]);
  expect(p3.nextCursor).toBeNull();

  const only = async (f: Parameters<typeof listDeliveries>[1]) => (await listDeliveries(m, f)).data.map((r) => r.id);
  expect(await only({ endpointId: b.id })).toEqual([ids[3], ids[1]]);
  expect(await only({ status: "failed" })).toEqual([ids[4]]);
  expect(await only({ from: "2026-10-11", to: "2026-10-12" })).toEqual([ids[2], ids[1]]); // `to` inclusivo
  // Endpoint ou cursor de outro lojista → nada.
  expect(await only({ endpointId: alien.id })).toEqual([]);
  expect(await only({ cursor: foreign.id })).toEqual([]);
  // Entrada inválida → invalid_request.
  await expect(listDeliveries(m, { from: "2026-10-12", to: "2026-10-11" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(listDeliveries(m, { cursor: "nao-e-uuid" })).rejects.toMatchObject({ code: "invalid_request" });
});

it("listEndpoints returns only the merchant's endpoints with public fields (never the secret)", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const a = await createEndpoint(m, { url: URL_A, events: ["charge.paid"] });
  const b = await createEndpoint(m, { url: "https://b.example.com/h", events: ["payout.completed"] });
  await createEndpoint(other, { url: "https://c.example.com/h", events: ["charge.paid"] });

  const list = await listEndpoints(m);
  expect(list.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  for (const e of list) expect(Object.keys(e).sort()).toEqual(["active", "createdAt", "description", "events", "id", "url"]);
  expect(JSON.stringify(list)).not.toContain(a.secret);
});
