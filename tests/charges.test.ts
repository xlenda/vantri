import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { charges, ledgerEntries, merchants, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { getBalance } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import {
  applyChargePaid,
  ChargeError,
  createCharge,
  expireDueCharges,
  getCharge,
  listCharges,
  toChargeJson,
} from "@/lib/services/charges";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeAll(() => {
  process.env.PIX_PROVIDER = "simulator";
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

async function activeMerchant(n: number, fees: { feeInBps?: number; feeInFixedCents?: number } = {}) {
  const id = await newMerchant(d, n);
  await d
    .update(merchants)
    .set({ status: "active", providerAccountId: `sim_acc_${n}`, ...fees })
    .where(eq(merchants.id, id));
  return id;
}

async function subscribe(merchantId: string) {
  await d.insert(webhookEndpoints).values({
    merchantId,
    url: "https://loja.example.com/hooks",
    secretEnc: "x", // enqueueEvent não decifra
    events: ["charge.paid", "charge.expired"],
  });
}

const deliveries = (type: string) => d.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, type));

async function rejects(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ChargeError);
  expect((e as ChargeError).code).toBe(code);
  expect((e as ChargeError).message).not.toBe("");
}

const JSON_KEYS = [
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

it("create charge 14990 snapshots fee 223", async () => {
  const m = await activeMerchant(1);
  const before = Date.now();
  const { charge, created } = await createCharge(m, { external_ref: "pedido-1", amount: 14990, description: "Curso" });
  expect(created).toBe(true);
  expect(charge).toMatchObject({ merchantId: m, amountCents: 14990, feeCents: 223, status: "pending" });
  expect(charge.txid).toMatch(/^[0-9A-Za-z]{25}$/);
  expect(charge.brcode).toContain("5406149.90");
  expect(charge.providerChargeId).toMatch(/^sim_ch_/);
  const ttl = charge.expiresAt.getTime() - before;
  expect(ttl).toBeGreaterThanOrEqual(3600_000);
  expect(ttl).toBeLessThan(3600_000 + 5_000);

  // A taxa fica gravada: mudar a taxa do lojista depois não muda a cobrança.
  await d.update(merchants).set({ feeInBps: 500 }).where(eq(merchants.id, m));
  expect((await getCharge(m, charge.id))?.feeCents).toBe(223);

  const json = await toChargeJson(charge, { withQr: true });
  expect(Object.keys(json).sort()).toEqual([...JSON_KEYS].sort());
  expect(json).toMatchObject({ amount: 14990, fee: 223, net: 14767, payer: null, paid_at: null, external_ref: "pedido-1" });
  expect(json.expires_at).toBe(charge.expiresAt.toISOString());
  // PNG em base64, sem prefixo data:
  expect(json.qr_code_base64).toMatch(/^iVBORw0KGgo/);

  const hook = await toChargeJson(charge, { withQr: false });
  expect("qr_code_base64" in hook).toBe(false);
  expect(Object.keys(hook)).toHaveLength(JSON_KEYS.length - 1);
});

it("expires_in sets the expiry", async () => {
  const m = await activeMerchant(1);
  const before = Date.now();
  const { charge } = await createCharge(m, { external_ref: "p", amount: 1000, expires_in: 300 });
  expect(charge.expiresAt.getTime() - before).toBeGreaterThanOrEqual(300_000);
  expect(charge.expiresAt.getTime() - before).toBeLessThan(305_000);
  await rejects(createCharge(m, { external_ref: "q", amount: 1000, expires_in: 299 }), "invalid_request");
  await rejects(createCharge(m, { external_ref: "q", amount: 1000, expires_in: 86401 }), "invalid_request");
});

it("same external_ref same amount returns existing (created=false)", async () => {
  const m = await activeMerchant(1);
  const a = await createCharge(m, { external_ref: "pedido-1", amount: 14990 });
  const b = await createCharge(m, { external_ref: "pedido-1", amount: 14990 });
  expect(b.created).toBe(false);
  expect(b.charge.id).toBe(a.charge.id);
  // Outro lojista pode usar o mesmo external_ref.
  const other = await createCharge(await activeMerchant(2), { external_ref: "pedido-1", amount: 14990 });
  expect(other.created).toBe(true);
  expect(await d.select().from(charges)).toHaveLength(2);
});

it("same external_ref other amount → idempotency_conflict", async () => {
  const m = await activeMerchant(1);
  await createCharge(m, { external_ref: "pedido-1", amount: 14990 });
  await rejects(createCharge(m, { external_ref: "pedido-1", amount: 15000 }), "idempotency_conflict");
  expect(await d.select().from(charges)).toHaveLength(1);
});

it("concurrent requests with the same external_ref never become a 500", async () => {
  const m = await activeMerchant(1);
  const input = { external_ref: "corrida", amount: 14990 };
  const [a, b] = await Promise.all([createCharge(m, input), createCharge(m, input)]);
  expect([a.created, b.created].sort()).toEqual([false, true]);
  expect(a.charge.id).toBe(b.charge.id);

  const r = await Promise.allSettled([
    createCharge(m, { external_ref: "corrida-2", amount: 1000 }),
    createCharge(m, { external_ref: "corrida-2", amount: 2000 }),
  ]);
  expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
  const failed = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toBeInstanceOf(ChargeError);
  expect(failed.reason.code).toBe("idempotency_conflict");
  expect(await d.select().from(charges)).toHaveLength(2);
});

it("rejects amount 0, -1, 1.5, '100', 10000001, and amount <= fee", async () => {
  const m = await activeMerchant(1);
  for (const amount of [0, -1, 99, 1.5, "100", 10_000_001, null]) {
    await rejects(createCharge(m, { external_ref: "x", amount }), "invalid_request");
  }
  await rejects(createCharge(m, { external_ref: "", amount: 1000 }), "invalid_request");
  await rejects(createCharge(m, { external_ref: "x".repeat(65), amount: 1000 }), "invalid_request");
  await rejects(createCharge(m, { external_ref: "x", amount: 1000, description: "d".repeat(141) }), "invalid_request");
  await rejects(createCharge(m, { external_ref: "x", amount: 1000, merchant_id: m }), "invalid_request");
  await rejects(createCharge(m, "lixo"), "invalid_request");
  // Mensagens do helper compartilhado (lib/validation.ts), sem ecoar o valor recebido.
  await expect(createCharge(m, { external_ref: "x", amount: 1000, merchant_id: m })).rejects.toThrow(
    /^Campo não permitido: merchant_id\.$/,
  );
  await expect(createCharge(m, { external_ref: "x", amount: "100" })).rejects.toThrow(/^Campo inválido: amount\.$/);
  await expect(createCharge(m, "lixo")).rejects.toThrow(/^Campo inválido: entrada\.$/);

  // Fixo 100: amount 100 → taxa 101 → recusa; 102 → taxa 102 → recusa; 103 passa.
  const fixed = await activeMerchant(2, { feeInFixedCents: 100 });
  await rejects(createCharge(fixed, { external_ref: "x", amount: 100 }), "invalid_request");
  await rejects(createCharge(fixed, { external_ref: "x", amount: 102 }), "invalid_request");
  expect((await createCharge(fixed, { external_ref: "x", amount: 103 })).charge.feeCents).toBe(102);

  // Limites exatos passam.
  expect((await createCharge(m, { external_ref: "min", amount: 100 })).created).toBe(true);
  expect((await createCharge(m, { external_ref: "max", amount: 10_000_000 })).created).toBe(true);
  expect(await d.select().from(charges)).toHaveLength(3);
});

it("rejects when merchant not active", async () => {
  const pending = await newMerchant(d, 1);
  await rejects(createCharge(pending, { external_ref: "x", amount: 1000 }), "merchant_inactive");
  const suspended = await activeMerchant(2);
  await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, suspended));
  await rejects(createCharge(suspended, { external_ref: "x", amount: 1000 }), "merchant_inactive");
  await rejects(createCharge("nao-e-uuid", { external_ref: "x", amount: 1000 }), "merchant_inactive");
  expect(await d.select().from(charges)).toHaveLength(0);
});

it("provider failure → provider_error, nothing written", async () => {
  const m = await activeMerchant(1);
  const spy = vi.spyOn(simulator, "createCharge").mockRejectedValueOnce(new Error("parceiro fora do ar"));
  try {
    await rejects(createCharge(m, { external_ref: "x", amount: 1000 }), "provider_error");
  } finally {
    spy.mockRestore();
  }
  expect(await d.select().from(charges)).toHaveLength(0);
});

it("paid event credits net once", async () => {
  const m = await activeMerchant(1);
  await subscribe(m);
  const { charge } = await createCharge(m, { external_ref: "pedido-1", amount: 14990 });
  const event = simulator.simulatePaid(charge.providerChargeId);

  expect(await applyChargePaid(event)).toBe("credited");
  expect(await getBalance(m)).toEqual({ available: 14767, blocked: 0, total: 14767 });
  const entries = await d
    .select({
      kind: ledgerEntries.kind,
      amountCents: ledgerEntries.amountCents,
      bucket: ledgerEntries.bucket,
      refType: ledgerEntries.refType,
      refId: ledgerEntries.refId,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.merchantId, m))
    .orderBy(ledgerEntries.kind);
  expect(entries).toEqual([
    { kind: "cash_in", amountCents: 14990, bucket: "available", refType: "charge", refId: charge.id },
    { kind: "fee_in", amountCents: -223, bucket: "available", refType: "charge", refId: charge.id },
  ]);
  const paid = await getCharge(m, charge.id);
  expect(paid).toMatchObject({
    status: "paid",
    paidAt: event.paidAt,
    endToEndId: event.endToEndId,
    payerName: "Pagador Simulado",
    payerDocumentMasked: "***.982.247-**",
  });

  const [hook] = await deliveries("charge.paid");
  const data = (hook.payload as { data: Record<string, unknown> }).data;
  expect(data).toMatchObject({ id: charge.id, status: "paid", net: 14767 });
  expect(data.payer).toEqual({ name: "Pagador Simulado", document_masked: "***.982.247-**" });
  expect("qr_code_base64" in data).toBe(false);
  // O documento cru do pagador não fica em lugar nenhum.
  expect(JSON.stringify(hook.payload)).not.toContain("52998224725");

  // Mesmo evento de novo, e um evento repetido com outros dados: nada muda, nada é emitido.
  expect(await applyChargePaid(event)).toBe("duplicate");
  const replay = { ...simulator.simulatePaid(charge.providerChargeId), payerName: "Outro" };
  expect(await applyChargePaid(replay)).toBe("duplicate");
  expect(await getBalance(m)).toEqual({ available: 14767, blocked: 0, total: 14767 });
  expect(await d.select().from(ledgerEntries)).toHaveLength(2);
  expect(await deliveries("charge.paid")).toHaveLength(1);
  expect(await getCharge(m, charge.id)).toMatchObject({ endToEndId: event.endToEndId, payerName: "Pagador Simulado" });

  // Paga não expira depois do vencimento.
  expect(await expireDueCharges(new Date(Date.now() + 2 * 86_400_000))).toBe(0);
  expect((await getCharge(m, charge.id))?.status).toBe("paid");
  expect(await deliveries("charge.expired")).toHaveLength(0);
});

it("paid event for unknown charge → unknown", async () => {
  expect(await applyChargePaid(simulator.simulatePaid("sim_ch_nao_existe"))).toBe("unknown");
});

it("paid after expiry still credits and status=paid", async () => {
  const m = await activeMerchant(1);
  await subscribe(m);
  const { charge } = await createCharge(m, { external_ref: "pedido-1", amount: 14990, expires_in: 300 });
  const other = await createCharge(m, { external_ref: "pedido-2", amount: 1000, expires_in: 3600 });

  expect(await expireDueCharges(new Date(Date.now() + 301_000))).toBe(1);
  expect(await expireDueCharges(new Date(Date.now() + 301_000))).toBe(0);
  expect((await getCharge(m, charge.id))?.status).toBe("expired");
  expect((await getCharge(m, other.charge.id))?.status).toBe("pending");
  const [expired] = await deliveries("charge.expired");
  expect((expired.payload as { data: { id: string } }).data.id).toBe(charge.id);

  expect(await applyChargePaid(simulator.simulatePaid(charge.providerChargeId))).toBe("credited");
  expect((await getCharge(m, charge.id))?.status).toBe("paid");
  expect((await getBalance(m)).available).toBe(14767);

  // Paga e vencida nunca volta a expirar: nem no cron, nem na leitura.
  expect(await expireDueCharges(new Date(Date.now() + 301_000))).toBe(0);
  await d.update(charges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(charges.id, charge.id));
  expect((await getCharge(m, charge.id))?.status).toBe("paid");
  expect(await deliveries("charge.expired")).toHaveLength(1);
});

it("getCharge expires a pending charge past due and emits charge.expired once", async () => {
  const m = await activeMerchant(1);
  await subscribe(m);
  const { charge } = await createCharge(m, { external_ref: "pedido-1", amount: 14990 });
  await d.update(charges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(charges.id, charge.id));

  expect((await getCharge(m, charge.id))?.status).toBe("expired");
  expect((await getCharge(m, charge.id))?.status).toBe("expired");
  expect(await deliveries("charge.expired")).toHaveLength(1);
});

it("getCharge of other merchant returns null", async () => {
  const a = await activeMerchant(1);
  const b = await activeMerchant(2);
  const { charge } = await createCharge(a, { external_ref: "pedido-1", amount: 14990 });
  expect(await getCharge(b, charge.id)).toBeNull();
  expect(await getCharge(a, "nao-e-uuid")).toBeNull();
  expect((await getCharge(a, charge.id))?.id).toBe(charge.id);
});

it("listCharges pages newest first, filters by status and stays inside the merchant", async () => {
  const m = await activeMerchant(1);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await createCharge(m, { external_ref: `p${i}`, amount: 1000 + i })).charge.id);
  const foreign = (await createCharge(await activeMerchant(2), { external_ref: "p0", amount: 1000 })).charge.id;
  await d.update(charges).set({ status: "paid" }).where(eq(charges.id, ids[1]));

  const page1 = await listCharges(m, { limit: 2 });
  expect(page1.data.map((c) => c.id)).toEqual([ids[2], ids[1]]);
  expect(page1.nextCursor).toBe(ids[1]);
  const page2 = await listCharges(m, { limit: 2, cursor: page1.nextCursor! });
  expect(page2.data.map((c) => c.id)).toEqual([ids[0]]);
  expect(page2.nextCursor).toBeNull();
  // Id de cobrança de outro lojista (mais nova que as de m) não serve de cursor.
  expect(await listCharges(m, { cursor: foreign })).toEqual({ data: [], nextCursor: null });

  expect((await listCharges(m)).data).toHaveLength(3);
  expect((await listCharges(m, { status: "paid" })).data.map((c) => c.id)).toEqual([ids[1]]);
  await rejects(listCharges(m, { limit: 101 }), "invalid_request");
  await rejects(listCharges(m, { cursor: "lixo" }), "invalid_request");
});

it("listCharges shows an overdue pending charge as expired, also in the filter, without writing", async () => {
  const m = await activeMerchant(1);
  await subscribe(m);
  const { charge: overdue } = await createCharge(m, { external_ref: "vencida", amount: 1000 });
  const { charge: open } = await createCharge(m, { external_ref: "valendo", amount: 1000 });
  await d.update(charges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(charges.id, overdue.id));

  const statuses = async (status?: "pending" | "expired") =>
    Object.fromEntries((await listCharges(m, { status })).data.map((c) => [c.id, c.status]));
  expect(await statuses()).toEqual({ [overdue.id]: "expired", [open.id]: "pending" });
  expect(await statuses("pending")).toEqual({ [open.id]: "pending" });
  expect(await statuses("expired")).toEqual({ [overdue.id]: "expired" });
  // Só leitura: a linha segue pending e nenhum evento sai (quem grava é o cron ou o getCharge).
  expect((await d.select().from(charges).where(eq(charges.id, overdue.id)))[0].status).toBe("pending");
  expect(await deliveries("charge.expired")).toHaveLength(0);
});
