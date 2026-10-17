import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { decrypt } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { createEndpoint, emit, type WebhookEventType } from "@/lib/services/events";
import {
  deliveryStats24h,
  endpointHealth,
  rotateEndpointSecret,
  setEndpointActive,
  updateEndpoint,
} from "@/lib/services/webhooks-admin";
import { dispatchDue, type Resolve } from "@/lib/webhooks/dispatch";
import { signPayload, verifySignature } from "@/lib/webhooks/sign";
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
const sec = (date: Date) => Math.floor(date.getTime() / 1000);
const publicDns: Resolve = async () => [{ address: "93.184.216.34" }];
const sendStatus = (status: number): typeof fetch =>
  (async () => new Response(status === 204 ? null : "ok", { status })) as typeof fetch;

const epRow = async (id: string) =>
  (await d.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)))[0];

async function makeEndpoint(merchantId: string, events: WebhookEventType[] = ["charge.paid"]) {
  return createEndpoint(merchantId, { url: "https://loja.example.com/hooks/vantri", events });
}

// Insere `n` entregas com um status fixo direto no banco (created_at padrão now, ordem por id).
async function seedDeliveries(endpointId: string, status: "pending" | "delivered" | "failed", n: number) {
  if (!n) return;
  await d.insert(webhookDeliveries).values(
    Array.from({ length: n }, (_, i) => ({
      endpointId,
      eventId: `evt_${status}_${i}`,
      eventType: "charge.paid",
      payload: {},
      status,
    })),
  );
}

it("updateEndpoint rejects http:// and private IP (reusing webhookUrlProblem)", async () => {
  const m = await newMerchant(d, 1);
  const ep = await makeEndpoint(m);
  for (const url of ["http://loja.example.com/h", "https://10.0.0.5/h", "https://169.254.169.254/x", "não é url"]) {
    await expect(updateEndpoint(m, ep.id, { url }), url).rejects.toMatchObject({ code: "invalid_request" });
  }
  // A URL original ficou intacta (nada foi gravado).
  expect((await epRow(ep.id)).url).toBe("https://loja.example.com/hooks/vantri");

  // URL pública nova passa; eventos são deduplicados; o segredo não muda.
  const before = (await epRow(ep.id)).secretEnc;
  await updateEndpoint(m, ep.id, {
    url: "https://nova.example.com/h",
    events: ["payout.completed", "payout.completed", "charge.paid"],
    description: "Produção",
  });
  const after = await epRow(ep.id);
  expect(after).toMatchObject({ url: "https://nova.example.com/h", description: "Produção" });
  expect(after.events).toEqual(["payout.completed", "charge.paid"]);
  expect(after.secretEnc).toBe(before);

  // Eventos vazios ou desconhecidos são recusados.
  await expect(updateEndpoint(m, ep.id, { events: [] })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    updateEndpoint(m, ep.id, { events: ["charge.refunded"] as unknown as WebhookEventType[] }),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

it("updateEndpoint of other merchant → not_found (IDOR); invalid id → not_found", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const ep = await makeEndpoint(m);
  await expect(updateEndpoint(other, ep.id, { url: "https://x.example.com/h" })).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(updateEndpoint(m, "nao-e-uuid", { url: "https://x.example.com/h" })).rejects.toMatchObject({
    code: "not_found",
  });
  // O endpoint do dono não mudou.
  expect((await epRow(ep.id)).url).toBe("https://loja.example.com/hooks/vantri");
});

it("setEndpointActive toggles; disable stops deliveries, enable resumes; other merchant → not_found", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const ep = await makeEndpoint(m);

  await setEndpointActive(m, ep.id, false);
  expect((await epRow(ep.id)).active).toBe(false);
  // Desligado: emit não enfileira nada.
  await d.transaction((tx) => emit(tx, m, "charge.paid", { id: "ch_1" }));
  expect(await d.$count(webhookDeliveries)).toBe(0);

  await setEndpointActive(m, ep.id, true);
  expect((await epRow(ep.id)).active).toBe(true);
  await d.transaction((tx) => emit(tx, m, "charge.paid", { id: "ch_2" }));
  expect(await d.$count(webhookDeliveries)).toBe(1);

  await expect(setEndpointActive(other, ep.id, false)).rejects.toMatchObject({ code: "not_found" });
  await expect(setEndpointActive(m, "nao-e-uuid", false)).rejects.toMatchObject({ code: "not_found" });
  expect((await epRow(ep.id)).active).toBe(true);
});

it("rotateEndpointSecret changes stored secret, returns a new one once, and old signatures stop verifying", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const ep = await makeEndpoint(m);
  const oldSecret = ep.secret;

  const { secret } = await rotateEndpointSecret(m, ep.id);
  expect(secret).toMatch(/^whsec_[0-9A-Za-z]{32}$/);
  expect(secret).not.toBe(oldSecret);

  const stored = (await epRow(ep.id)).secretEnc;
  expect(stored).not.toContain(secret); // guardado cifrado
  expect(decrypt(stored)).toBe(secret); // e é o novo

  // Assinatura feita com o segredo antigo não confere mais; com o novo, confere.
  const body = JSON.stringify({ id: "evt_1", type: "charge.paid" });
  const t = sec(T0);
  expect(verifySignature(oldSecret, body, signPayload(oldSecret, body, t), t)).toBe(true); // o antigo em si ainda é válido isoladamente
  expect(verifySignature(secret, body, signPayload(oldSecret, body, t), t)).toBe(false); // mas não contra o novo
  expect(verifySignature(secret, body, signPayload(secret, body, t), t)).toBe(true);

  // Girar de novo troca outra vez.
  const { secret: third } = await rotateEndpointSecret(m, ep.id);
  expect(third).not.toBe(secret);
  expect(decrypt((await epRow(ep.id)).secretEnc)).toBe(third);

  // Outro lojista / id inválido → not_found, sem girar nada.
  const sealed = (await epRow(ep.id)).secretEnc;
  await expect(rotateEndpointSecret(other, ep.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(rotateEndpointSecret(m, "nao-e-uuid")).rejects.toMatchObject({ code: "not_found" });
  expect((await epRow(ep.id)).secretEnc).toBe(sealed);
});

it("endpointHealth bands: 95%→healthy, 85%→unstable, 50%→failing, none→nodata; pending excluded; other merchant invisible", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const healthy = await makeEndpoint(m); // 19 delivered + 1 failed = 0.95
  const unstable = await makeEndpoint(m); // 17 delivered + 3 failed = 0.85
  const failing = await makeEndpoint(m); // 1 delivered + 1 failed = 0.50
  const empty = await makeEndpoint(m); // sem entregas

  await seedDeliveries(healthy.id, "delivered", 19);
  await seedDeliveries(healthy.id, "failed", 1);
  await seedDeliveries(healthy.id, "pending", 5); // pendentes não contam
  await seedDeliveries(unstable.id, "delivered", 17);
  await seedDeliveries(unstable.id, "failed", 3);
  await seedDeliveries(failing.id, "delivered", 1);
  await seedDeliveries(failing.id, "failed", 1);
  // Endpoint de outro lojista com entregas: não pode aparecer no mapa do primeiro.
  const alien = await makeEndpoint(other);
  await seedDeliveries(alien.id, "delivered", 10);

  const health = await endpointHealth(m);
  expect(health.has(alien.id)).toBe(false);
  expect([...health.keys()].sort()).toEqual([healthy.id, unstable.id, failing.id, empty.id].sort());
  expect(health.get(healthy.id)).toMatchObject({ rate: 0.95, sample: 20, band: "healthy" });
  expect(health.get(unstable.id)).toMatchObject({ rate: 0.85, sample: 20, band: "unstable" });
  expect(health.get(failing.id)).toMatchObject({ rate: 0.5, sample: 2, band: "failing" });
  expect(health.get(empty.id)).toMatchObject({ sample: 0, band: "nodata" });
});

it("endpointHealth looks only at the last 100 deliveries per endpoint", async () => {
  const m = await newMerchant(d, 1);
  const ep = await makeEndpoint(m);
  // 100 recentes entregues + 1 antiga falhada: a antiga cai fora da janela → 100% saudável.
  await seedDeliveries(ep.id, "delivered", 100);
  // A falha mais velha: created_at antes das demais, então fica fora das 100 mais novas.
  await d.insert(webhookDeliveries).values({
    endpointId: ep.id,
    eventId: "evt_velha",
    eventType: "charge.paid",
    payload: {},
    status: "failed",
    createdAt: new Date("2000-01-01T00:00:00.000Z"),
  });

  const health = await endpointHealth(m);
  expect(health.get(ep.id)).toMatchObject({ sample: 100, band: "healthy", rate: 1 });
});

it("deliveryStats24h counts within 24h only, per merchant, with avg latency over delivered rows", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const ep = await makeEndpoint(m);
  const alien = await makeEndpoint(other);

  const now = new Date("2026-10-16T12:00:00.000Z");
  const within = (deltaMs: number) => new Date(now.getTime() - deltaMs);

  // Dentro da janela: 2 entregues (latências 100ms e 300ms → média 200), 1 falhada, 1 pendente.
  await d.insert(webhookDeliveries).values([
    {
      endpointId: ep.id,
      eventId: "evt_d1",
      eventType: "charge.paid",
      payload: {},
      status: "delivered",
      createdAt: within(3_600_000),
      deliveredAt: new Date(within(3_600_000).getTime() + 100),
    },
    {
      endpointId: ep.id,
      eventId: "evt_d2",
      eventType: "charge.paid",
      payload: {},
      status: "delivered",
      createdAt: within(1_800_000),
      deliveredAt: new Date(within(1_800_000).getTime() + 300),
    },
    { endpointId: ep.id, eventId: "evt_f1", eventType: "charge.paid", payload: {}, status: "failed", createdAt: within(7_200_000) },
    { endpointId: ep.id, eventId: "evt_p1", eventType: "charge.paid", payload: {}, status: "pending", createdAt: within(60_000) },
    // Fora da janela (25 h atrás): não entra.
    {
      endpointId: ep.id,
      eventId: "evt_old",
      eventType: "charge.paid",
      payload: {},
      status: "delivered",
      createdAt: within(25 * 3_600_000),
      deliveredAt: new Date(within(25 * 3_600_000).getTime() + 50),
    },
    // De outro lojista, dentro da janela: não entra.
    { endpointId: alien.id, eventId: "evt_x", eventType: "charge.paid", payload: {}, status: "delivered", createdAt: within(60_000), deliveredAt: within(0) },
  ]);

  const stats = await deliveryStats24h(m, now);
  expect(stats).toEqual({ delivered: 2, failed: 1, pending: 1, avgLatencyMs: 200 });

  // Lojista sem entregas: zeros e latência null.
  const empty = await newMerchant(d, 3);
  expect(await deliveryStats24h(empty, now)).toEqual({ delivered: 0, failed: 0, pending: 0, avgLatencyMs: null });
});

it("updateEndpoint with an internal URL is rejected even end-to-end (dispatch would also block)", async () => {
  // Reforço do Review Focus 3: a edição re-roda o guard. Confirma via o guard + via o envio.
  const m = await newMerchant(d, 1);
  const ep = await makeEndpoint(m);
  await expect(updateEndpoint(m, ep.id, { url: "https://intranet/h" })).rejects.toMatchObject({
    code: "invalid_request",
  });
  // Mesmo se uma URL interna entrasse direto no banco, o envio a barraria (defesa em profundidade).
  await d
    .update(webhookEndpoints)
    .set({ url: "https://10.0.0.5/h" })
    .where(and(eq(webhookEndpoints.id, ep.id), eq(webhookEndpoints.merchantId, m)));
  await d.transaction((tx) => emit(tx, m, "charge.paid", { id: "ch_1" }));
  await d.update(webhookDeliveries).set({ nextAttemptAt: T0 });
  expect(await dispatchDue(50, T0, sendStatus(200), publicDns)).toEqual({ delivered: 0, failed: 1 });
});
