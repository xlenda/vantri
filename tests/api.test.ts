import { randomUUID } from "node:crypto";
import { format } from "node:util";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { GET as balanceGET } from "@/app/api/v1/balance/route";
import { GET as chargeGET } from "@/app/api/v1/charges/[id]/route";
import { GET as chargesGET, POST as chargesPOST } from "@/app/api/v1/charges/route";
import { GET as medCaseGET } from "@/app/api/v1/med/[id]/route";
import { GET as medGET } from "@/app/api/v1/med/route";
import { GET as openapiGET } from "@/app/api/v1/openapi.json/route";
import { GET as payoutGET } from "@/app/api/v1/payouts/[id]/route";
import { GET as payoutsGET, POST as payoutsPOST } from "@/app/api/v1/payouts/route";
import { GET as statementGET } from "@/app/api/v1/statement/route";
import { withApi } from "@/lib/api/http";
import { ApiKeyError, createApiKey, revokeApiKey, type Scope, SCOPES } from "@/lib/api/keys";
import { sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { apiKeys, charges, ledgerEntries, medCases, merchants, payouts } from "@/lib/db/schema";
import { postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// `after` real só existe dentro de uma requisição do Next; aqui guarda a tarefa para o teste conferir.
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void afterTasks.push(task),
}));

let d: Db;

beforeAll(() => {
  process.env.PIX_PROVIDER = "simulator";
});

beforeEach(async () => {
  afterTasks.length = 0;
  d = await createTestDb();
  setDb(d);
});

type Handler = (req: Request, ctx: { params: Promise<never> }) => Promise<Response>;

async function call(
  h: Handler,
  o: { key?: string; path?: string; body?: unknown; headers?: Record<string, string>; id?: string } = {},
) {
  const headers = new Headers(o.headers);
  if (o.key) headers.set("authorization", `Bearer ${o.key}`);
  const req = new Request(`http://localhost/api/v1${o.path ?? "/"}`, {
    method: o.body === undefined ? "GET" : "POST",
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const res = await h(req, { params: Promise.resolve(o.id === undefined ? {} : { id: o.id }) as Promise<never> });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

async function activeMerchant(n: number): Promise<string> {
  const id = await newMerchant(d, n);
  await d.update(merchants).set({ status: "active", providerAccountId: `sim_acc_${n}` }).where(eq(merchants.id, id));
  return id;
}

const keyFor = async (m: string, scopes: Scope[] = [...SCOPES], ipAllowlist: string[] = []) =>
  (await createApiKey(m, { name: "teste", scopes, ipAllowlist })).key;

/** Crédito de 14990 com taxa 223 direto no razão (14767 disponíveis). */
async function credit(m: string, createdAt?: Date) {
  const ref = randomUUID();
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId: m, amountCents: 14990, bucket: "available", kind: "cash_in", refType: "charge", refId: ref },
      { merchantId: m, amountCents: -223, bucket: "available", kind: "fee_in", refType: "charge", refId: ref },
    ]),
  );
  if (createdAt) await d.update(ledgerEntries).set({ createdAt }).where(eq(ledgerEntries.refId, ref));
}

const CHARGE_KEYS = [
  "id",
  "txid",
  "external_ref",
  "amount",
  "fee",
  "net",
  "description",
  "status",
  "brcode",
  "qr_code_base64",
  "expires_at",
  "paid_at",
  "payer",
  "end_to_end_id",
  "created_at",
];

/** O que o console escreveria (util.format mostra mensagem e stack de Error; JSON.stringify de Error dá "{}"). */
const logged = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((args) => format(...args)).join("\n");

const PAYOUT_KEYS = [
  "id",
  "amount",
  "fee",
  "pix_key",
  "pix_key_type",
  "description",
  "status",
  "failure_code",
  "end_to_end_id",
  "created_at",
  "completed_at",
];

const CHARGE = { external_ref: "pedido_1", amount: 14990, description: "Curso" };
const PAYOUT = { amount: 10000, pix_key: "52998224725", pix_key_type: "cpf" };

it("no key → 401", async () => {
  const m = await activeMerchant(1);
  const key = await keyFor(m);
  for (const k of [undefined, `vk_live_${"x".repeat(40)}`, "vk_live_curta", key.replace("vk_live_", "vk_test_")]) {
    const r = await call(balanceGET, { key: k });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("unauthorized");
    expect(r.json.error.message).not.toBe("");
  }
  expect((await call(balanceGET, { key })).status).toBe(200);
});

it("revoked key → 401", async () => {
  const m = await activeMerchant(1);
  const { id, key } = await createApiKey(m, { name: "x", scopes: ["balance:read"], ipAllowlist: [] });
  expect((await call(balanceGET, { key })).status).toBe(200);
  await expect(revokeApiKey(await activeMerchant(2), id)).rejects.toBeInstanceOf(ApiKeyError); // de outro lojista
  expect((await call(balanceGET, { key })).status).toBe(200);
  await revokeApiKey(m, id);
  const r = await call(balanceGET, { key });
  expect(r.status).toBe(401);
  expect(r.json.error.code).toBe("unauthorized");
});

it("charges:read key POST /charges → 403", async () => {
  const m = await activeMerchant(1);
  const key = await keyFor(m, ["charges:read"]);
  const r = await call(chargesPOST, { key, body: CHARGE });
  expect(r.status).toBe(403);
  expect(r.json.error.code).toBe("forbidden");
  expect(await d.$count(charges)).toBe(0);
  expect((await call(chargesGET, { key })).status).toBe(200);
});

it("ip not in allowlist → 403", async () => {
  const m = await activeMerchant(1);
  const key = await keyFor(m, ["balance:read"], ["203.0.113.7"]);
  const as = (headers: Record<string, string>) => call(balanceGET, { key, headers });
  const denied = await as({ "x-forwarded-for": "198.51.100.1, 203.0.113.7" }); // vale só o primeiro
  expect(denied.status).toBe(403);
  expect(denied.json.error.code).toBe("forbidden");
  expect((await as({})).status).toBe(403); // sem IP
  expect((await as({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).status).toBe(200);
  expect((await as({ "x-real-ip": "203.0.113.7" })).status).toBe(200);
});

it("merchant not active → 403", async () => {
  const m = await activeMerchant(1);
  const key = await keyFor(m);
  await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, m));
  const r = await call(balanceGET, { key });
  expect(r.status).toBe(403);
  expect(r.json.error.code).toBe("merchant_inactive");
});

it("POST /charges 201 then same body 200 same id", async () => {
  const key = await keyFor(await activeMerchant(1));
  const first = await call(chargesPOST, { key, body: CHARGE });
  expect(first.status).toBe(201);
  expect(first.json).toMatchObject({ amount: 14990, fee: 223, net: 14767, status: "pending" });
  const again = await call(chargesPOST, { key, body: CHARGE });
  expect(again.status).toBe(200);
  expect(again.json.id).toBe(first.json.id);
  expect(await d.$count(charges)).toBe(1);

  const conflict = await call(chargesPOST, { key, body: { ...CHARGE, amount: 20000 } });
  expect(conflict.status).toBe(409);
  expect(conflict.json.error.code).toBe("idempotency_conflict");
  const bad = await call(chargesPOST, { key, body: { ...CHARGE, external_ref: "p2", fee: 0 } });
  expect(bad.status).toBe(422);
  expect(bad.json.error.code).toBe("invalid_request");
});

it("response has no internal fields", async () => {
  const key = await keyFor(await activeMerchant(1));
  const created = await call(chargesPOST, { key, body: CHARGE });
  expect(Object.keys(created.json)).toEqual(CHARGE_KEYS);
  expect(created.json.qr_code_base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
  const one = await call(chargeGET, { key, id: created.json.id });
  expect(Object.keys(one.json)).toEqual(CHARGE_KEYS);
  const list = await call(chargesGET, { key });
  expect(Object.keys(list.json)).toEqual(["data", "next_cursor"]);
  expect(Object.keys(list.json.data[0])).toEqual(CHARGE_KEYS);

  const bal = await call(balanceGET, { key });
  expect(bal.json).toEqual({ available: 0, blocked: 0, total: 0 });
});

it("GET /charges/{id} of other merchant → 404", async () => {
  const keyA = await keyFor(await activeMerchant(1));
  const keyB = await keyFor(await activeMerchant(2));
  const { json } = await call(chargesPOST, { key: keyA, body: CHARGE });
  expect((await call(chargeGET, { key: keyA, id: json.id })).status).toBe(200);
  const r = await call(chargeGET, { key: keyB, id: json.id });
  expect(r.status).toBe(404);
  expect(r.json.error.code).toBe("not_found");
  expect((await call(chargeGET, { key: keyA, id: "nao-e-uuid" })).status).toBe(404);
  expect((await call(chargesGET, { key: keyB })).json.data).toEqual([]);
});

it("GET /payouts/{id} of other merchant → 404", async () => {
  const a = await activeMerchant(1);
  const keyA = await keyFor(a);
  const keyB = await keyFor(await activeMerchant(2));
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId: a,
      amountCents: 1000,
      feeCents: 100,
      pixKey: "52998224725",
      pixKeyType: "cpf",
      status: "completed",
      idempotencyKey: "chave-0001",
      requestHash: "h",
    })
    .returning();
  const ok = await call(payoutGET, { key: keyA, id: p.id });
  expect(ok.status).toBe(200);
  expect(ok.json.id).toBe(p.id);
  expect(Object.keys(ok.json)).toEqual(PAYOUT_KEYS);
  const r = await call(payoutGET, { key: keyB, id: p.id });
  expect(r.status).toBe(404);
  expect(r.json.error.code).toBe("not_found");
  const list = (await call(payoutsGET, { key: keyA })).json;
  expect(list.data).toHaveLength(1);
  expect(Object.keys(list.data[0])).toEqual(PAYOUT_KEYS);
  expect((await call(payoutsGET, { key: keyB })).json.data).toEqual([]);
});

it("GET /med/{id} of other merchant → 404", async () => {
  const a = await activeMerchant(1);
  const keyA = await keyFor(a);
  const keyB = await keyFor(await activeMerchant(2));
  const [c] = await d
    .insert(charges)
    .values({
      merchantId: a,
      txid: "t1",
      externalRef: "r1",
      amountCents: 14990,
      feeCents: 223,
      status: "paid",
      brcode: "000201",
      providerChargeId: "sim_ch_1",
      expiresAt: new Date(),
    })
    .returning();
  const [mc] = await d
    .insert(medCases)
    .values({
      merchantId: a,
      chargeId: c.id,
      providerCaseId: "sim_med_1",
      amountCents: 14990,
      reason: "fraude",
      status: "open",
      defenseDeadline: new Date(Date.now() + 86_400_000),
    })
    .returning();
  const ok = await call(medCaseGET, { key: keyA, id: mc.id });
  expect(ok.status).toBe(200);
  expect(Object.keys(ok.json)).toEqual([
    "id",
    "charge_id",
    "amount",
    "reason",
    "status",
    "defense_deadline",
    "created_at",
    "closed_at",
  ]);
  const r = await call(medCaseGET, { key: keyB, id: mc.id });
  expect(r.status).toBe(404);
  expect(r.json.error.code).toBe("not_found");
  expect((await call(medGET, { key: keyA })).json).toEqual({ data: [ok.json], next_cursor: null });
  expect((await call(medGET, { key: keyB })).json.data).toEqual([]);
});

it("POST /payouts without Idempotency-Key → 422", async () => {
  const m = await activeMerchant(1);
  await credit(m);
  const key = await keyFor(m);
  const bad: Record<string, string>[] = [{}, { "idempotency-key": "curta" }, { "idempotency-key": "x".repeat(65) }];
  for (const headers of bad) {
    const r = await call(payoutsPOST, { key, body: PAYOUT, headers });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("invalid_request");
  }
  expect(await d.$count(payouts)).toBe(0);
  expect(afterTasks).toHaveLength(0);

  const headers = { "idempotency-key": "pedido-saque-0001" };
  const first = await call(payoutsPOST, { key, body: PAYOUT, headers });
  expect(first.status).toBe(201);
  // payout.completed do simulador já está na fila: o envio dos webhooks fica agendado para depois da resposta.
  expect(afterTasks).toHaveLength(1);
  expect(await afterTasks[0]()).toEqual({ delivered: 0, failed: 0 }); // é o dispatchDue (sem endpoint: nada a enviar)
  expect(Object.keys(first.json)).toEqual(PAYOUT_KEYS);
  const again = await call(payoutsPOST, { key, body: PAYOUT, headers });
  expect(again.status).toBe(200);
  expect(again.json.id).toBe(first.json.id);
  const poor = await call(payoutsPOST, { key, body: PAYOUT, headers: { "idempotency-key": "pedido-saque-0002" } });
  expect(poor.status).toBe(422);
  expect(poor.json.error.code).toBe("insufficient_balance");
});

it("121st request in a minute → 429 with Retry-After", async () => {
  const m = await activeMerchant(1);
  const key = await keyFor(m);
  for (let i = 0; i < 120; i++) expect((await call(balanceGET, { key })).status).toBe(200);
  const r = await call(balanceGET, { key });
  expect(r.status).toBe(429);
  expect(r.json.error.code).toBe("rate_limited");
  expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  expect((await call(balanceGET, { key: await keyFor(m) })).status).toBe(200); // limite é por chave
});

it("openapi.json parses and has openapi '3.1.0' and all 8 paths", async () => {
  const doc = JSON.parse(await (await openapiGET()).text());
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.servers[0].url).toMatch(/\/api\/v1$/);
  // Enquanto o Pix é simulado, o servidor não se chama "Produção".
  expect(doc.servers[0].description).toBe("Demonstração (Pix simulado)");
  vi.stubEnv("PIX_PROVIDER", "parceiro");
  try {
    expect((await (await openapiGET()).json()).servers[0].description).toBe("Produção");
  } finally {
    vi.unstubAllEnvs();
  }
  expect(Object.keys(doc.paths).sort()).toEqual(
    ["/balance", "/charges", "/charges/{id}", "/med", "/med/{id}", "/payouts", "/payouts/{id}", "/statement"].sort(),
  );
  expect(Object.keys(doc.webhooks).sort()).toEqual(
    ["charge.expired", "charge.paid", "med.closed", "med.opened", "payout.completed", "payout.failed"].sort(),
  );
  // Todo $ref aponta para algo que existe.
  const refs = JSON.stringify(doc).match(/"\$ref":"[^"]+"/g) ?? [];
  expect(refs.length).toBeGreaterThan(10);
  for (const r of refs) {
    const path = r.slice('"$ref":"#/'.length, -1).split("/");
    expect(path.reduce((o, k) => o?.[k], doc), r).toBeDefined();
  }
});

it("list limit and cursor are validated and paginate", async () => {
  const key = await keyFor(await activeMerchant(1));
  for (const q of ["?limit=0", "?limit=101", "?limit=abc", "?limit=1.5", "?status=paid", "?cursor=xyz"]) {
    const r = await call(chargesGET, { key, path: `/charges${q}` });
    expect(r.status, q).toBe(422);
    expect(r.json.error.code).toBe("invalid_request");
  }
  await call(chargesPOST, { key, body: CHARGE });
  const second = await call(chargesPOST, { key, body: { ...CHARGE, external_ref: "pedido_2" } });
  const p1 = await call(chargesGET, { key, path: "/charges?limit=1" });
  expect(p1.json.data.map((c: { id: string }) => c.id)).toEqual([second.json.id]);
  expect(p1.json.next_cursor).toBe(second.json.id);
  const p2 = await call(chargesGET, { key, path: `/charges?limit=1&cursor=${p1.json.next_cursor}` });
  expect(p2.json.data).toHaveLength(1);
  expect(p2.json.data[0].external_ref).toBe("pedido_1");
  expect(p2.json.next_cursor).toBeNull();
});

it("GET /statement filters by period, paginates and caps the interval at 366 days", async () => {
  const m = await activeMerchant(1);
  const key = await keyFor(m, ["statement:read"]);
  await credit(m, new Date("2026-03-10T15:00:00Z"));
  await credit(m, new Date("2026-03-12T15:00:00Z"));
  await credit(m);
  const st = (q = "") => call(statementGET, { key, path: `/statement${q}` });

  const recent = await st();
  expect(recent.status).toBe(200);
  expect(recent.json.data).toHaveLength(2); // só as de agora (últimos 30 dias)
  expect(Object.keys(recent.json.data[0])).toEqual(["id", "kind", "bucket", "amount", "ref_type", "ref_id", "created_at"]);
  expect((await st("?limit=3")).json.next_cursor).toBeNull();

  // Dias no horário de Brasília, `to` inclusivo.
  const day10 = await st("?from=2026-03-10&to=2026-03-10");
  expect(day10.json.data.map((e: { amount: number }) => e.amount).sort()).toEqual([-223, 14990]);
  expect((await st("?from=2026-03-11&to=2026-03-11")).json.data).toEqual([]);

  const page = await st("?from=2026-03-01&to=2026-03-31&limit=3");
  expect(page.json.data).toHaveLength(3);
  const rest = await st(`?from=2026-03-01&to=2026-03-31&limit=3&cursor=${page.json.next_cursor}`);
  expect(rest.json.data).toHaveLength(1);
  expect(rest.json.next_cursor).toBeNull();
  const ids = [...page.json.data, ...rest.json.data].map((e: { id: string }) => e.id);
  expect(new Set(ids).size).toBe(4);

  expect((await st("?from=2025-10-16&to=2026-10-16")).status).toBe(200); // 366 dias
  for (const q of ["?from=2025-10-15&to=2026-10-16", "?from=2026-03-11&to=2026-03-10", "?from=2026-02-30", "?x=1"]) {
    const r = await st(q);
    expect(r.status, q).toBe(422);
    expect(r.json.error.code).toBe("invalid_request");
  }
  expect((await call(statementGET, { key: await keyFor(m, ["balance:read"]) })).status).toBe(403);
});

it("unexpected error → 500 generic, logged without the message, no leak", async () => {
  const m = await activeMerchant(1);
  const key = await keyFor(m);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const boom = withApi("balance:read", async () => {
    throw new Error('Failed query: insert … params: segredo-pix-52998224725,Ana Segredo');
  });
  const r = await call(boom, { key });
  expect(r.status).toBe(500);
  expect(r.json.error.code).toBe("internal_error");
  expect(JSON.stringify(r.json)).not.toContain("egredo");
  expect(log).toHaveBeenCalled();
  expect(logged(log)).not.toContain("egredo");
  expect(logged(log)).toContain(m); // contexto: qual lojista
  log.mockRestore();
});

it("provider_error → 502, cause logged without its message", async () => {
  const key = await keyFor(await activeMerchant(1));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const provider = vi.spyOn(simulator, "createCharge").mockRejectedValue(new Error("token segredo do parceiro"));
  const r = await call(chargesPOST, { key, body: CHARGE });
  expect(r.status).toBe(502);
  expect(r.json.error.code).toBe("provider_error");
  expect(log).toHaveBeenCalled();
  expect(logged(log)).not.toContain("segredo");
  provider.mockRestore();
  log.mockRestore();
});

it("GET /charges and GET /charges/{id} agree on an overdue charge", async () => {
  const key = await keyFor(await activeMerchant(1));
  const { json } = await call(chargesPOST, { key, body: CHARGE });
  await d.update(charges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(charges.id, json.id));
  expect((await call(chargesGET, { key })).json.data[0].status).toBe("expired");
  expect((await call(chargeGET, { key, id: json.id })).json.status).toBe("expired");
});

it("last_used_at is updated at most once per minute", async () => {
  const m = await activeMerchant(1);
  const { id, key } = await createApiKey(m, { name: "x", scopes: ["balance:read"], ipAllowlist: [] });
  const lastUsed = async () => (await d.select().from(apiKeys).where(eq(apiKeys.id, id)))[0].lastUsedAt;
  expect(await lastUsed()).toBeNull();
  await call(balanceGET, { key });
  expect(await lastUsed()).toBeInstanceOf(Date);
  const recent = new Date(Date.now() - 30_000);
  await d.update(apiKeys).set({ lastUsedAt: recent }).where(eq(apiKeys.id, id));
  await call(balanceGET, { key });
  expect((await lastUsed())!.getTime()).toBe(recent.getTime());
  const old = new Date(Date.now() - 61_000);
  await d.update(apiKeys).set({ lastUsedAt: old }).where(eq(apiKeys.id, id));
  await call(balanceGET, { key });
  expect((await lastUsed())!.getTime()).toBeGreaterThan(old.getTime() + 60_000);
});

it("createApiKey stores only the hash and validates input", async () => {
  const m = await activeMerchant(1);
  const { id, key } = await createApiKey(m, {
    name: " Loja ",
    scopes: ["charges:read", "charges:read"],
    ipAllowlist: ["2001:DB8::1"],
  });
  expect(key).toMatch(/^vk_live_[0-9A-Za-z]{40}$/);
  const [row] = await d.select().from(apiKeys).where(eq(apiKeys.id, id));
  expect(row).toMatchObject({
    merchantId: m,
    name: "Loja",
    prefix: key.slice(0, 12),
    keyHash: sha256Hex(key),
    scopes: ["charges:read"],
    ipAllowlist: ["2001:db8::1"],
  });
  expect(JSON.stringify(row)).not.toContain(key);
  for (const bad of [
    { name: "", scopes: ["charges:read"], ipAllowlist: [] },
    { name: "x", scopes: [], ipAllowlist: [] },
    { name: "x", scopes: ["admin"], ipAllowlist: [] },
    { name: "x", scopes: ["charges:read"], ipAllowlist: ["999.1.1.1"] },
  ]) {
    await expect(createApiKey(m, bad as never)).rejects.toMatchObject({ code: "invalid_request" });
  }
});
