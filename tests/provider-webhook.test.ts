import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET as tick } from "@/app/api/cron/tick/route";
import { POST as webhook } from "@/app/api/provider/webhook/route";
import { type Db, setDb } from "@/lib/db/client";
import { charges, ledgerEntries, merchants, payouts, rateLimits, sessions, users } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import { createCharge } from "@/lib/services/charges";
import { createPayout } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// `after` real só existe dentro de uma requisição do Next; aqui guarda a tarefa para o teste conferir.
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void afterTasks.push(task),
}));

let d: Db;

beforeEach(async () => {
  vi.stubEnv("PIX_PROVIDER", "simulator");
  vi.stubEnv("SIMULATOR_WEBHOOK_SECRET", "segredo-sim");
  vi.stubEnv("CRON_SECRET", "segredo-cron");
  afterTasks.length = 0;
  d = await createTestDb();
  setDb(d);
});

afterEach(() => vi.unstubAllEnvs());

async function activeMerchant(n = 1) {
  const id = await newMerchant(d, n);
  await d.update(merchants).set({ status: "active", providerAccountId: `sim_acc_${n}` }).where(eq(merchants.id, id));
  return id;
}

function post(events: unknown[], secret = "segredo-sim", body = JSON.stringify({ events })) {
  return webhook(
    new Request("http://localhost/api/provider/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-simulator-secret": secret },
      body,
    }),
  );
}

const get = (auth?: string) =>
  tick(new Request("http://localhost/api/cron/tick", { headers: auth === undefined ? {} : { authorization: auth } }));

const cashIns = () => d.$count(ledgerEntries, eq(ledgerEntries.kind, "cash_in"));

it("webhook with wrong simulator secret → 401", async () => {
  const m = await activeMerchant();
  const { charge } = await createCharge(m, { external_ref: "p1", amount: 14990 });
  const events = [simulator.simulatePaid(charge.providerChargeId)];
  for (const res of [await post(events, "errado"), await post(events, "")]) {
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  }
  expect(await cashIns()).toBe(0);
  expect(afterTasks).toHaveLength(0);
});

it("malformed body with the right secret → 400", async () => {
  for (const res of [
    await post([], undefined, "{"),
    await post([{ ...simulator.simulatePaid("sim_ch_x"), paidAt: null }]),
  ]) {
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  }
});

it("charge.paid delivered twice credits once", async () => {
  const m = await activeMerchant();
  const { charge } = await createCharge(m, { external_ref: "p1", amount: 14990 });
  const paid = simulator.simulatePaid(charge.providerChargeId);

  for (const events of [[paid], [paid, paid]]) {
    const res = await post(events);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: events.length });
  }
  expect(await cashIns()).toBe(1);
  expect((await getBalance(m)).available).toBe(14990 - 223);
  const [row] = await d.select().from(charges).where(eq(charges.id, charge.id));
  expect(row.status).toBe("paid");
  expect(afterTasks).toHaveLength(2);
  expect(await afterTasks[0]()).toEqual({ delivered: 0, failed: 0 }); // dispatchDue sem endpoints
});

it("unknown charge and unknown payout are ignored with 200", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const res = await post([
    simulator.simulatePaid("sim_ch_nao_existe"),
    { type: "payout.failed", providerPayoutId: "sim_po_nao_existe", failureCode: "x" },
  ]);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ received: 2 });
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls.join(" ")).not.toContain("Pagador Simulado");
  expect(log.mock.calls.join(" ")).not.toContain("52998224725");
  log.mockRestore();
});

it("payout.failed after completed ignored", async () => {
  const m = await activeMerchant();
  const ref = crypto.randomUUID();
  await d.transaction((tx) =>
    postEntries(tx, [{ merchantId: m, amountCents: 14767, bucket: "available", kind: "cash_in", refType: "charge", refId: ref }]),
  );
  const { payout } = await createPayout(m, { amount: 10000, pix_key: "52998224725", pix_key_type: "cpf" }, "chave-0001");
  // Parceiro ainda não respondeu: o saque fica em processamento até o webhook.
  await d.update(payouts).set({ status: "processing", endToEndId: null, completedAt: null }).where(eq(payouts.id, payout.id));
  const id = payout.providerPayoutId!;

  const res = await post([
    { type: "payout.completed", providerPayoutId: id, endToEndId: "E00000000abc" },
    { type: "payout.failed", providerPayoutId: id, failureCode: "pix_key_not_found" },
  ]);
  expect(res.status).toBe(200);
  const [row] = await d.select().from(payouts).where(eq(payouts.id, payout.id));
  expect(row).toMatchObject({ status: "completed", endToEndId: "E00000000abc", failureCode: null });
  expect(await d.$count(ledgerEntries, eq(ledgerEntries.kind, "cash_out_reversal"))).toBe(0);
  expect((await getBalance(m)).available).toBe(14767 - 10000 - 100);
});

it("med.opened and med.closed go through the webhook", async () => {
  const m = await activeMerchant();
  const { charge } = await createCharge(m, { external_ref: "p1", amount: 14990 });
  const opened = simulator.simulateMed(charge.providerChargeId, 5000);
  await post([simulator.simulatePaid(charge.providerChargeId), opened]);
  expect(await getBalance(m)).toMatchObject({ available: 14767 - 5000, blocked: 5000 });

  const res = await post([{ type: "med.closed", providerCaseId: opened.providerCaseId, outcome: "merchant_won" }]);
  expect(res.status).toBe(200);
  expect(await getBalance(m)).toMatchObject({ available: 14767, blocked: 0 });
});

it("error while applying → 500 so the partner retries", async () => {
  const m = await activeMerchant();
  const { charge } = await createCharge(m, { external_ref: "p1", amount: 14990 });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await (d as unknown as { $client: PGlite }).$client.close(); // toda query passa a lançar
  const res = await post([simulator.simulatePaid(charge.providerChargeId)]);
  expect(res.status).toBe(500);
  expect(afterTasks).toHaveLength(0);
  err.mockRestore();
});

it("tick without secret → 401", async () => {
  for (const auth of [undefined, "Bearer errado", "segredo-cron", "Bearer segredo-cronX"]) {
    expect((await get(auth)).status).toBe(401);
  }
  vi.stubEnv("CRON_SECRET", "");
  expect((await get("Bearer ")).status).toBe(401);
  expect((await get("Bearer")).status).toBe(401);
  vi.stubEnv("CRON_SECRET", undefined);
  expect((await get("Bearer undefined")).status).toBe(401);
});

it("tick expires due charges", async () => {
  const m = await activeMerchant();
  const { charge } = await createCharge(m, { external_ref: "p1", amount: 14990 });
  const { charge: fresh } = await createCharge(m, { external_ref: "p2", amount: 14990 });
  await d.update(charges).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(charges.id, charge.id));

  const res = await get("Bearer segredo-cron");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    expired_charges: 1,
    settled_payouts: 0,
    webhooks: { delivered: 0, failed: 0 },
    deleted_rate_limits: 0,
    deleted_sessions: 0,
    errors: {},
  });
  const status = async (id: string) => (await d.select().from(charges).where(eq(charges.id, id)))[0].status;
  expect(await status(charge.id)).toBe("expired");
  expect(await status(fresh.id)).toBe("pending");
});

it("tick cleans old rate limits and expired sessions", async () => {
  const [u] = await d
    .insert(users)
    .values({ email: "a@x.com", passwordHash: "x", role: "admin" })
    .returning({ id: users.id });
  await d.insert(rateLimits).values([
    { key: "velho", windowStart: sql`now() - interval '25 hours'`, count: 3 },
    { key: "novo", windowStart: sql`now() - interval '23 hours'`, count: 3 },
  ]);
  await d.insert(sessions).values([
    { id: "vencida", userId: u.id, expiresAt: sql`now() - interval '1 second'` },
    { id: "valida", userId: u.id, expiresAt: sql`now() + interval '1 hour'` },
  ]);

  const body = await (await get("Bearer segredo-cron")).json();
  expect(body).toMatchObject({ deleted_rate_limits: 1, deleted_sessions: 1, errors: {} });
  expect((await d.select({ k: rateLimits.key }).from(rateLimits)).map((r) => r.k)).toEqual(["novo"]);
  expect((await d.select({ id: sessions.id }).from(sessions)).map((r) => r.id)).toEqual(["valida"]);
});

it("one failing tick step does not skip the others", async () => {
  const m = await activeMerchant();
  const { charge } = await createCharge(m, { external_ref: "p1", amount: 14990 });
  await d.update(charges).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(charges.id, charge.id));
  vi.stubEnv("PIX_PROVIDER", ""); // pollProcessingPayouts lança em getProvider()
  const err = vi.spyOn(console, "error").mockImplementation(() => {});

  const res = await get("Bearer segredo-cron");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ expired_charges: 1, settled_payouts: null, deleted_sessions: 0 });
  expect(body.errors).toEqual({ settled_payouts: "falha ao consultar saques no provedor" });
  err.mockRestore();
});
