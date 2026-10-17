import { beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { charges, payouts } from "@/lib/db/schema";
import { searchTransactions } from "@/lib/services/search";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

let seq = 0;
async function charge(merchantId: string, over: Partial<typeof charges.$inferInsert> = {}) {
  seq++;
  const [c] = await d
    .insert(charges)
    .values({
      merchantId,
      txid: `txid-${seq}`,
      externalRef: `ref-${seq}`,
      amountCents: 14990,
      feeCents: 223,
      status: "paid",
      brcode: "000201...",
      providerChargeId: `sim_ch_${seq}`,
      expiresAt: new Date(Date.now() + 3600_000),
      ...over,
    })
    .returning();
  return c;
}

async function payout(merchantId: string, over: Partial<typeof payouts.$inferInsert> = {}) {
  seq++;
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId,
      amountCents: 10000,
      feeCents: 100,
      pixKey: "loja@teste.com",
      pixKeyType: "email",
      status: "completed",
      idempotencyKey: `idem-${seq}`,
      requestHash: `hash-${seq}`,
      ...over,
    })
    .returning();
  return p;
}

it("finds charge by exact E2E and by txid", async () => {
  const m = await newMerchant(d, 1);
  const c = await charge(m, { txid: "TXID-ABC", endToEndId: "E12345678202601011200abcdef0001" });

  const byTxid = await searchTransactions(m, "TXID-ABC");
  expect(byTxid.charges.map((x) => x.id)).toEqual([c.id]);

  const byE2e = await searchTransactions(m, "E12345678202601011200abcdef0001");
  expect(byE2e.charges.map((x) => x.id)).toEqual([c.id]);

  // Prefixo do E2E não casa: E2E é exato, não prefixo.
  const partial = await searchTransactions(m, "E12345678");
  expect(partial.charges).toEqual([]);
});

it("finds charge by payer_name prefix", async () => {
  const m = await newMerchant(d, 1);
  const maria = await charge(m, { payerName: "Maria Silva" });
  await charge(m, { payerName: "Ana Souza" });

  const r = await searchTransactions(m, "mar");
  expect(r.charges.map((x) => x.id)).toEqual([maria.id]);
});

it("finds payout by pix_key and by e2e", async () => {
  const m = await newMerchant(d, 1);
  const p = await payout(m, { pixKey: "12345678909", pixKeyType: "cpf", endToEndId: "E99999999payout0001" });

  const byKey = await searchTransactions(m, "12345678909");
  expect(byKey.payouts.map((x) => x.id)).toEqual([p.id]);

  const byE2e = await searchTransactions(m, "E99999999payout0001");
  expect(byE2e.payouts.map((x) => x.id)).toEqual([p.id]);
});

it("never returns other merchant's rows", async () => {
  const mine = await newMerchant(d, 1);
  const other = await newMerchant(d, 2);
  const e2e = "E00000000sharedE2E00000000000001";
  await charge(other, { txid: "txid-other", endToEndId: e2e });
  const theirPayout = await payout(other, { endToEndId: "E00000000otherpayout00000000001" });

  const r = await searchTransactions(mine, e2e);
  expect(r.charges).toEqual([]);

  const rp = await searchTransactions(mine, "E00000000otherpayout00000000001");
  expect(rp.payouts).toEqual([]);
  // sanidade: o dono enxerga
  expect((await searchTransactions(other, "E00000000otherpayout00000000001")).payouts.map((x) => x.id)).toEqual([
    theirPayout.id,
  ]);
});

it("term shorter than 2 chars returns empty", async () => {
  const m = await newMerchant(d, 1);
  await charge(m, { txid: "a", payerName: "A" });

  expect(await searchTransactions(m, "a")).toEqual({ charges: [], payouts: [] });
  expect(await searchTransactions(m, "  ")).toEqual({ charges: [], payouts: [] });
});

it("text term without digit never matches a pix_key document", async () => {
  // Bug da Cashyin §1.17.10: termo sem dígito ("maria") não pode casar documento/chave.
  const m = await newMerchant(d, 1);
  await payout(m, { pixKey: "maria.doc", pixKeyType: "evp" });

  const r = await searchTransactions(m, "maria.doc");
  expect(r.payouts).toEqual([]);
});
