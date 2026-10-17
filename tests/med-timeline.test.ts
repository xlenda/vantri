import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { charges, medCases, medEvents, webhookEndpoints } from "@/lib/db/schema";
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
const merchant = (merchantId: string) => ({ role: "merchant", merchantId }) as const;

it("applyMedOpened writes an 'opened' event once (replay does not duplicate)", async () => {
  const { merchantId, caseId, e } = await openMed(5000);
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened"]);
  expect(await applyMedOpened(e)).toBe("duplicate");
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened"]);
});

it("submitDefense writes 'defense_submitted' after 'opened'", async () => {
  const { merchantId, caseId } = await openMed();
  await submitDefense(merchantId, caseId, TEXT, []);
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened", "defense_submitted"]);
});

it("applyMedClosed writes closed_merchant_won", async () => {
  const { merchantId, caseId, e } = await openMed(5000);
  expect(
    await applyMedClosed({ type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" }),
  ).toBe("closed");
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened", "closed_merchant_won"]);
});

it("applyMedClosed writes closed_payer_refunded; late close writes nothing", async () => {
  const { merchantId, caseId, e } = await openMed(5000);
  const refund = { type: "med.closed", providerCaseId: e.providerCaseId, outcome: "payer_refunded" } as const;
  expect(await applyMedClosed(refund)).toBe("closed");
  // Encerramento tardio/repetido (outro desfecho): nenhum evento novo.
  expect(
    await applyMedClosed({ type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" }),
  ).toBe("duplicate");
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened", "closed_payer_refunded"]);
  expect(await d.select().from(medEvents).where(eq(medEvents.medCaseId, caseId))).toHaveLength(2);
});

it("listMedEvents is merchant-scoped: another merchant gets [], admin sees all", async () => {
  const { merchantId, caseId } = await openMed(5000, 1);
  const other = await newMerchant(d, 2);
  expect(await listMedEvents(caseId, merchant(other))).toEqual([]);
  expect(await listMedEvents(caseId, { role: "merchant" })).toEqual([]);
  expect(await listMedEvents("nao-e-uuid", { role: "admin" })).toEqual([]);
  expect(types(await listMedEvents(caseId, merchant(merchantId)))).toEqual(["opened"]);
  expect(types(await listMedEvents(caseId, { role: "admin" }))).toEqual(["opened"]);
});
