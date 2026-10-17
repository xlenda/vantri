import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { webhookAttempts, webhookDeliveries } from "@/lib/db/schema";
import { createEndpoint, emit, listDeliveryAttempts, type WebhookEventType } from "@/lib/services/events";
import { dispatchDue, type Resolve } from "@/lib/webhooks/dispatch";
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
