import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { decrypt } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { createEndpoint, emit, resendDelivery, type WebhookEventType } from "@/lib/services/events";
import { dispatchDue, RETRY_DELAYS_SEC, type Resolve } from "@/lib/webhooks/dispatch";
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

type Sent = { url: string; init: RequestInit };
function stub(...responses: Array<number | Error>) {
  const calls: Sent[] = [];
  const send = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof r !== "number") throw r;
    return new Response(r === 204 ? null : "ok", { status: r });
  }) as typeof fetch;
  return { send, calls };
}

// DNS falso: os testes nunca saem para a rede.
const publicDns: Resolve = async () => [{ address: "93.184.216.34" }];
// Formato real do undici: TypeError("fetch failed") com o erro do socket em cause.
const netError = (code: string, message: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

async function setup(events: WebhookEventType[] = ["charge.paid"]) {
  const merchantId = await newMerchant(d, 1);
  const ep = await createEndpoint(merchantId, { url: "https://loja.example.com/hooks/vantri", events });
  await d.transaction((tx) => emit(tx, merchantId, "charge.paid", { id: "ch_1", amount: 14990 }));
  await d.update(webhookDeliveries).set({ nextAttemptAt: T0 });
  const [delivery] = await d.select().from(webhookDeliveries);
  return { merchantId, ep, delivery };
}

const row = async (id: string) =>
  (await d.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)))[0];

it("signature verifies and fails with altered body", () => {
  const body = JSON.stringify({ id: "evt_1", type: "charge.paid" });
  const t = sec(T0);
  const header = signPayload("whsec_abc", body, t);
  expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  expect(verifySignature("whsec_abc", body, header, t)).toBe(true);
  expect(verifySignature("whsec_abc", body.replace("charge", "payout"), header, t)).toBe(false);
  expect(verifySignature("whsec_outro", body, header, t)).toBe(false);
  expect(verifySignature("whsec_abc", body, "lixo", t)).toBe(false);
  expect(verifySignature("whsec_abc", body, header.replace(/v1=../, "v1=zz"), t)).toBe(false);
});

it("signature older than 300s fails", () => {
  const body = "{}";
  const now = sec(T0);
  expect(verifySignature("s", body, signPayload("s", body, now - 300), now)).toBe(true);
  expect(verifySignature("s", body, signPayload("s", body, now - 301), now)).toBe(false);
  expect(verifySignature("s", body, signPayload("s", body, now - 301), now, 600)).toBe(true);
});

it("emit only enqueues for active endpoints subscribed to the type", async () => {
  const m = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const subscribed = await createEndpoint(m, {
    url: "https://a.example.com/h",
    events: ["charge.paid", "payout.failed"],
  });
  await createEndpoint(m, { url: "https://b.example.com/h", events: ["payout.completed"] });
  const inactive = await createEndpoint(m, { url: "https://c.example.com/h", events: ["charge.paid"] });
  await d.update(webhookEndpoints).set({ active: false }).where(eq(webhookEndpoints.id, inactive.id));
  await createEndpoint(other, { url: "https://d.example.com/h", events: ["charge.paid"] });

  await d.transaction((tx) => emit(tx, m, "charge.paid", { id: "ch_1" }));
  const rows = await d.select().from(webhookDeliveries);
  expect(rows).toHaveLength(1);
  expect(rows[0].endpointId).toBe(subscribed.id);
  expect(rows[0]).toMatchObject({ status: "pending", attempts: 0, eventType: "charge.paid" });
  expect(rows[0].payload).toMatchObject({ id: rows[0].eventId, type: "charge.paid", data: { id: "ch_1" } });
  expect(rows[0].eventId).toMatch(/^evt_[0-9A-Za-z]{24}$/);

  // Dentro da transação do chamador: rollback desfaz a entrega.
  await expect(
    d.transaction(async (tx) => {
      await emit(tx, m, "charge.paid", { id: "ch_2" });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await d.$count(webhookDeliveries)).toBe(1);
});

it("retry schedule: after 1st failure next_attempt_at = now+60s; after 7th failure status=failed", async () => {
  expect(RETRY_DELAYS_SEC).toEqual([60, 300, 1800, 7200, 21600, 86400]);
  const { delivery } = await setup();
  // 302 (redirect não é seguido), conexão recusada e 500 — tudo é falha.
  const { send, calls } = stub(302, netError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.9:443"), 500);

  let now = T0;
  expect(await dispatchDue(50, now, send, publicDns)).toEqual({ delivered: 0, failed: 1 });
  let r = await row(delivery.id);
  expect(r).toMatchObject({ status: "pending", attempts: 1, lastStatusCode: 302, lastError: "resposta HTTP 302" });
  expect(r.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);

  // Antes da hora, nada é enviado.
  const early = new Date(now.getTime() + 59_000);
  expect(await dispatchDue(50, early, send, publicDns)).toEqual({ delivered: 0, failed: 0 });
  expect(calls).toHaveLength(1);

  for (let n = 2; n <= 7; n++) {
    now = r.nextAttemptAt;
    expect(await dispatchDue(50, now, send, publicDns)).toEqual({ delivered: 0, failed: 1 });
    r = await row(delivery.id);
    expect(r.attempts).toBe(n);
    if (n === 2) expect(r).toMatchObject({ lastStatusCode: null, lastError: "conexão recusada" });
    if (n < 7) {
      expect(r.status).toBe("pending");
      expect(r.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_DELAYS_SEC[n - 1] * 1000);
    }
  }
  expect(r).toMatchObject({ status: "failed", attempts: 7, lastStatusCode: 500, lastError: "resposta HTTP 500" });
  expect(r.deliveredAt).toBeNull();
  const later = new Date(now.getTime() + 10 * 86_400_000);
  expect(await dispatchDue(50, later, send, publicDns)).toEqual({ delivered: 0, failed: 0 });
  expect(calls).toHaveLength(7);
});

it("2xx marks delivered", async () => {
  const { ep, delivery } = await setup();
  const { send, calls } = stub(204);

  // Duas rodadas ao mesmo tempo: a entrega é reivindicada por uma só.
  const results = await Promise.all([dispatchDue(50, T0, send, publicDns), dispatchDue(50, T0, send, publicDns)]);
  expect(results.reduce((a, x) => a + x.delivered, 0)).toBe(1);
  expect(calls).toHaveLength(1);

  const r = await row(delivery.id);
  expect(r).toMatchObject({ status: "delivered", attempts: 1, lastStatusCode: 204, lastError: null });
  expect(r.deliveredAt).toEqual(T0);

  const { url, init } = calls[0];
  expect(url).toBe("https://loja.example.com/hooks/vantri");
  expect(init).toMatchObject({ method: "POST", redirect: "manual" });
  expect(init.signal).toBeInstanceOf(AbortSignal);
  const headers = new Headers(init.headers);
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("user-agent")).toBe("Vantri-Webhooks/1");
  const body = init.body as string;
  expect(JSON.parse(body)).toEqual(r.payload);
  expect(verifySignature(ep.secret, body, headers.get("x-vantri-signature")!, sec(T0))).toBe(true);
});

it("host that resolves to an internal IP is never sent to", async () => {
  const { delivery } = await setup();
  const { send, calls } = stub(200);
  const seen: string[] = [];
  const enotfound = Object.assign(new Error("getaddrinfo ENOTFOUND loja.example.com"), { code: "ENOTFOUND" });
  const cases: Array<[Resolve, string]> = [
    [
      async (host) => {
        seen.push(host);
        return [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]; // basta um IP interno
      },
      "endereço bloqueado",
    ],
    [async () => [{ address: "fe80::1%eth0" }], "endereço bloqueado"],
    [async () => [{ address: "::ffff:169.254.169.254" }], "endereço bloqueado"],
    [async () => [], "falha de DNS"],
    [async () => Promise.reject(enotfound), "falha de DNS"],
  ];
  let now = T0;
  for (const [resolve, expected] of cases) {
    expect(await dispatchDue(50, now, send, resolve)).toEqual({ delivered: 0, failed: 1 });
    const r = await row(delivery.id);
    expect(r).toMatchObject({ status: "pending", lastStatusCode: null, lastError: expected });
    now = r.nextAttemptAt;
  }
  expect(seen).toEqual(["loja.example.com"]);

  // URL que as regras atuais recusam (gravada antes delas, ou direto no banco) também é barrada no envio.
  await d.update(webhookEndpoints).set({ url: "https://intranet/h" });
  expect(await dispatchDue(50, now, send, publicDns)).toEqual({ delivered: 0, failed: 1 });
  expect(await row(delivery.id)).toMatchObject({ attempts: 6, lastError: "endereço bloqueado" });
  expect(calls).toHaveLength(0);
});

it("last_error keeps only a generic category, never the raw cause", async () => {
  const { delivery } = await setup();
  const cases: Array<[Error, string]> = [
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "tempo esgotado"],
    [netError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error (attempted address: 10.0.0.9:443)"), "tempo esgotado"],
    [netError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.9:443"), "conexão recusada"],
    [netError("ERR_TLS_CERT_ALTNAME_INVALID", "IP: 10.0.0.9 is not in the cert's list: 192.168.1.1"), "erro de TLS"],
    [netError("ECONNRESET", "read ECONNRESET 10.0.0.9:443"), "erro de rede"],
  ];
  let now = T0;
  for (const [err, expected] of cases) {
    expect(await dispatchDue(50, now, stub(err).send, publicDns)).toEqual({ delivered: 0, failed: 1 });
    const r = await row(delivery.id);
    expect(r.lastError).toBe(expected);
    now = r.nextAttemptAt;
  }
});

it("rejects http:// and https://127.0.0.1 and https://10.0.0.5 endpoint", async () => {
  const m = await newMerchant(d, 1);
  const create = (url: string, events: string[] = ["charge.paid"]) =>
    createEndpoint(m, { url, events: events as WebhookEventType[] });

  for (const url of [
    "http://loja.example.com/h",
    "https://127.0.0.1/h",
    "https://10.0.0.5/h",
    "ftp://loja.example.com/h",
    "não é url",
    "https://localhost/h",
    "https://LOCALHOST./h",
    "https://app.localhost/h",
    "https://impressora.local/h",
    "https://metadata.google.internal/h",
    "https://172.16.0.1/h",
    "https://172.31.255.255/h",
    "https://192.168.0.10/h",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/h",
    "https://0.0.0.0/h",
    "https://2130706433/h", // 127.0.0.1 em decimal
    "https://0x7f.1/h", // 127.0.0.1 em hexa
    "https://[::1]/h",
    "https://[::]/h",
    "https://[fd12:3456::1]/h",
    "https://[fe80::1]/h",
    "https://[::ffff:10.0.0.1]/h",
    "https://[::ffff:127.0.0.1]/h",
    `https://loja.example.com/${"a".repeat(2048)}`,
    "https://usuario:senha@loja.example.com/h",
    "https://usuario@loja.example.com/h",
    "https://intranet/h", // um rótulo só
    "https://nas.localdomain/h",
    "https://198.18.0.1/h",
    "https://198.19.255.255/h",
    "https://224.0.0.1/h",
    "https://240.0.0.1/h",
    "https://255.255.255.255/h",
    "https://[::a00:1]/h", // IPv4-compatível
    "https://[::ffff:0:a00:1]/h", // IPv4-traduzido
    "https://[::ffff:8.8.8.8]/h", // IPv4-mapeado, mesmo público
    "https://[64:ff9b::a00:1]/h", // NAT64
    "https://[2002:a00:1::1]/h", // 6to4
    "https://[fec0::1]/h",
  ]) {
    await expect(create(url), url).rejects.toMatchObject({ code: "invalid_request" });
  }
  await expect(create("https://loja.example.com/h", [])).rejects.toMatchObject({ code: "invalid_request" });
  await expect(create("https://loja.example.com/h", ["charge.refunded"])).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(await d.$count(webhookEndpoints)).toBe(0);

  // Públicos passam (172.32.x fora de 172.16/12; 100.128.x fora de 100.64/10; 198.20.x fora de 198.18/15).
  for (const url of [
    "https://loja.example.com/h",
    "https://8.8.8.8/h",
    "https://172.32.0.1/h",
    "https://100.128.0.1/h",
    "https://198.20.0.1/h",
    "https://[2606:4700::1111]/h",
  ]) {
    await expect(create(url), url).resolves.toBeTruthy();
  }

  const { id, secret } = await create("https://ok.example.com/h", ["charge.paid", "med.opened"]);
  expect(secret).toMatch(/^whsec_[0-9A-Za-z]{32}$/);
  const [ep] = await d.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
  expect(ep.secretEnc).not.toContain(secret);
  expect(decrypt(ep.secretEnc)).toBe(secret);
  expect(ep).toMatchObject({ merchantId: m, active: true, events: ["charge.paid", "med.opened"] });
});

it("resend of other merchant's delivery is not found", async () => {
  const { merchantId, delivery } = await setup();
  const other = await newMerchant(d, 2);
  const future = new Date(Date.now() + 86_400_000);
  await d
    .update(webhookDeliveries)
    .set({ status: "failed", attempts: 7, nextAttemptAt: future })
    .where(eq(webhookDeliveries.id, delivery.id));

  await expect(resendDelivery(other, delivery.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(resendDelivery(merchantId, "nao-e-uuid")).rejects.toMatchObject({ code: "not_found" });
  expect(await row(delivery.id)).toMatchObject({ status: "failed", nextAttemptAt: future });

  const before = Date.now();
  await resendDelivery(merchantId, delivery.id);
  const r = await row(delivery.id);
  expect(r.status).toBe("pending");
  expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  expect(r.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());

  // Uma tentativa a mais: 2xx entrega.
  const { send } = stub(200);
  expect(await dispatchDue(50, new Date(), send, publicDns)).toEqual({ delivered: 1, failed: 0 });
  expect(await row(delivery.id)).toMatchObject({ status: "delivered", attempts: 8 });
});
