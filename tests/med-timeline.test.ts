import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, charges, medCases, medEvents, users, webhookEndpoints } from "@/lib/db/schema";
import { postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import { applyMedClosed, applyMedOpened, listMedEvents, submitDefense } from "@/lib/services/med";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

const TEXT = "O cliente recebeu o produto, segue comprovante de entrega.";
let seq = 0;

/** Lojista com cobrança paga (14990, 223 de tarifa) e webhook ouvindo MED. */
async function paidMerchant(n = 1) {
  const merchantId = await newMerchant(d, n);
  const providerChargeId = `sim_ch_${++seq}`;
  const [ch] = await d
    .insert(charges)
    .values({
      merchantId,
      txid: `tx${seq}`,
      externalRef: `pedido-${seq}`,
      amountCents: 14990,
      feeCents: 223,
      status: "paid",
      brcode: "000201",
      providerChargeId,
      expiresAt: new Date(Date.now() + 3600_000),
      paidAt: new Date(),
    })
    .returning({ id: charges.id });
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId, amountCents: 14990, bucket: "available", kind: "cash_in", refType: "charge", refId: ch.id },
      { merchantId, amountCents: -223, bucket: "available", kind: "fee_in", refType: "charge", refId: ch.id },
    ]),
  );
  await d
    .insert(webhookEndpoints)
    .values({ merchantId, url: "https://loja.example.com/h", secretEnc: "x", events: ["med.opened", "med.closed"] });
  return { merchantId, providerChargeId };
}

async function openMed(amount = 5000, n = 1) {
  const m = await paidMerchant(n);
  const e = simulator.simulateMed(m.providerChargeId, amount);
  expect(await applyMedOpened(e)).toBe("opened");
  const [c] = await d.select().from(medCases).where(eq(medCases.providerCaseId, e.providerCaseId));
  return { ...m, e, caseId: c.id };
}

const types = (rows: Array<{ type: string }>) => rows.map((r) => r.type);
const trail = (rows: Array<{ type: string; source: string | null }>) => rows.map((r) => `${r.type}:${r.source}`);
const merchant = (merchantId: string) => ({ role: "merchant", merchantId }) as const;

it("applyMedOpened writes 'opened' + 'funds_blocked' once (replay does not duplicate)", async () => {
  const { merchantId, caseId, e } = await openMed(5000);
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened", "funds_blocked"]);
  expect(await applyMedOpened(e)).toBe("duplicate");
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened", "funds_blocked"]);
});

it("submitDefense writes 'defense_submitted' after 'opened'", async () => {
  const { merchantId, caseId } = await openMed();
  await submitDefense(merchantId, caseId, TEXT, []);
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual([
    "opened",
    "funds_blocked",
    "defense_submitted",
  ]);
});

it("applyMedClosed writes closed_merchant_won", async () => {
  const { merchantId, caseId, e } = await openMed(5000);
  expect(
    await applyMedClosed({ type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" }),
  ).toBe("closed");
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual([
    "opened",
    "funds_blocked",
    "closed_merchant_won",
  ]);
});

it("applyMedClosed writes closed_payer_refunded; late close writes nothing", async () => {
  const { merchantId, caseId, e } = await openMed(5000);
  const refund = { type: "med.closed", providerCaseId: e.providerCaseId, outcome: "payer_refunded" } as const;
  expect(await applyMedClosed(refund)).toBe("closed");
  // Encerramento tardio/repetido (outro desfecho): nenhum evento novo.
  expect(
    await applyMedClosed({ type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" }),
  ).toBe("duplicate");
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual([
    "opened",
    "funds_blocked",
    "closed_payer_refunded",
  ]);
  expect(await d.select().from(medEvents).where(eq(medEvents.medCaseId, caseId))).toHaveLength(3);
});

it("listMedEvents is merchant-scoped: another merchant gets [], admin sees all", async () => {
  const { merchantId, caseId } = await openMed(5000, 1);
  const other = await newMerchant(d, 2);
  expect(await listMedEvents(caseId, merchant(other))).toEqual([]);
  expect(await listMedEvents(caseId, { role: "merchant" })).toEqual([]);
  expect(await listMedEvents("nao-e-uuid", { role: "admin" })).toEqual([]);
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened", "funds_blocked"]);
  expect(types(await listMedEvents(caseId, { role: "admin" }))).toEqual(["opened", "funds_blocked"]);
});

it("eventos da mesma transação (mesmo created_at) saem na ordem do ciclo, não na do id aleatório", async () => {
  const { merchantId, caseId } = await openMed();
  await d.delete(medEvents).where(eq(medEvents.medCaseId, caseId));
  const at = new Date();
  await d.insert(medEvents).values([
    { id: "00000000-0000-4000-8000-000000000001", medCaseId: caseId, type: "funds_blocked", createdAt: at },
    { id: "ffffffff-ffff-4fff-bfff-ffffffffffff", medCaseId: caseId, type: "opened", createdAt: at },
  ]);
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened", "funds_blocked"]);
});

it("source: o parceiro abre e encerra, o lojista defende; nada disso entra no audit_log", async () => {
  const { merchantId, caseId, e } = await openMed(5000);
  await submitDefense(merchantId, caseId, TEXT, []);
  await applyMedClosed({ type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" });
  expect(trail(await listMedEvents(caseId, merchant(merchantId)))).toEqual([
    "opened:provider",
    "funds_blocked:provider",
    "defense_submitted:merchant",
    "closed_merchant_won:provider",
  ]);
  expect(await d.$count(auditLog)).toBe(0);
});

it("MED de teste do admin: source 'admin' e audit_log med.open_test/med.close com o autor e só ids", async () => {
  const [admin] = await d
    .insert(users)
    .values({ email: "admin@vantri.test", passwordHash: "x", role: "admin" })
    .returning({ id: users.id });
  const { merchantId, providerChargeId } = await paidMerchant();
  const e = simulator.simulateMed(providerChargeId, 3000);
  const close = { type: "med.closed", providerCaseId: e.providerCaseId, outcome: "payer_refunded" } as const;
  expect(await applyMedOpened(e, admin.id)).toBe("opened");
  expect(await applyMedClosed(close, admin.id)).toBe("closed");
  // Repetido: nada acontece, nada é auditado.
  expect(await applyMedOpened(e, admin.id)).toBe("duplicate");
  expect(await applyMedClosed(close, admin.id)).toBe("duplicate");

  const [c] = await d.select().from(medCases).where(eq(medCases.providerCaseId, e.providerCaseId));
  expect(trail(await listMedEvents(c.id, { role: "admin" }))).toEqual([
    "opened:admin",
    "funds_blocked:admin",
    "closed_payer_refunded:admin",
  ]);
  const log = await d
    .select({ actorUserId: auditLog.actorUserId, action: auditLog.action, meta: auditLog.meta })
    .from(auditLog);
  expect(log).toEqual([
    { actorUserId: admin.id, action: "med.open_test", meta: { merchantId, medCaseId: c.id } },
    { actorUserId: admin.id, action: "med.close", meta: { merchantId, medCaseId: c.id, outcome: "payer_refunded" } },
  ]);
});
