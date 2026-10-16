import { beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { ledgerEntries } from "@/lib/db/schema";
import { computeFee } from "@/lib/money/fees";
import { getBalance, lockMerchant, postEntries } from "@/lib/money/ledger";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

const CHARGE = "00000000-0000-4000-8000-000000000001";
const MED = "00000000-0000-4000-8000-000000000002";

it("computeFee arredonda a parte percentual e soma a fixa", () => {
  expect(computeFee(10000, 149, 0)).toBe(149);
  expect(computeFee(10000, 0, 100)).toBe(100);
  expect(computeFee(9999, 149, 99)).toBe(248);
  expect(computeFee(1, 149, 0)).toBe(0);
});

it("getBalance sums per bucket", async () => {
  const m = await newMerchant(d, 1);
  await d.transaction(async (tx) => {
    await lockMerchant(tx, m);
    const ok = await postEntries(tx, [
      { merchantId: m, amountCents: 10000, bucket: "available", kind: "cash_in", refType: "charge", refId: CHARGE },
      { merchantId: m, amountCents: -149, bucket: "available", kind: "fee_in", refType: "charge", refId: CHARGE },
      { merchantId: m, amountCents: -500, bucket: "available", kind: "med_hold", refType: "med_case", refId: MED },
      { merchantId: m, amountCents: 500, bucket: "blocked", kind: "med_hold", refType: "med_case", refId: MED },
    ]);
    expect(ok).toBe(true);
    expect(await getBalance(m, tx)).toEqual({ available: 9351, blocked: 500, total: 9851 });
  });
  expect(await getBalance(m)).toEqual({ available: 9351, blocked: 500, total: 9851 });
  // Lojista sem lançamento: zeros, não null.
  expect(await getBalance(await newMerchant(d, 2))).toEqual({ available: 0, blocked: 0, total: 0 });
});

it("postEntries returns false and writes nothing new on replay", async () => {
  const m = await newMerchant(d, 1);
  const entries = [
    { merchantId: m, amountCents: 10000, bucket: "available", kind: "cash_in", refType: "charge", refId: CHARGE },
    { merchantId: m, amountCents: -149, bucket: "available", kind: "fee_in", refType: "charge", refId: CHARGE },
  ] as const;
  expect(await d.transaction((tx) => postEntries(tx, [...entries]))).toBe(true);
  expect(await d.transaction((tx) => postEntries(tx, [...entries]))).toBe(false);
  expect(await d.$count(ledgerEntries)).toBe(2);
  expect(await getBalance(m)).toEqual({ available: 9851, blocked: 0, total: 9851 });
});
