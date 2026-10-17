import { beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { ledgerEntries } from "@/lib/db/schema";
import { dailyFlow, pctDelta, periodSummary, previousPeriod } from "@/lib/services/summary";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

const CH1 = "00000000-0000-4000-8000-000000000001";
const CH2 = "00000000-0000-4000-8000-000000000002";
const PO1 = "00000000-0000-4000-8000-000000000003";

// Seed direto do razão (createdAt explícito quando o teste depende do dia civil).
const post = (e: typeof ledgerEntries.$inferInsert) => d.insert(ledgerEntries).values(e);

it("periodSummary sums inflow/outflow/fees and counts", async () => {
  const m = await newMerchant(d, 1);
  // cash_in +10000 ×2, fee_in −149 ×2, cash_out −5000, fee_out −100
  await post({ merchantId: m, amountCents: 10000, bucket: "available", kind: "cash_in", refType: "charge", refId: CH1 });
  await post({ merchantId: m, amountCents: 10000, bucket: "available", kind: "cash_in", refType: "charge", refId: CH2 });
  await post({ merchantId: m, amountCents: -149, bucket: "available", kind: "fee_in", refType: "charge", refId: CH1 });
  await post({ merchantId: m, amountCents: -149, bucket: "available", kind: "fee_in", refType: "charge", refId: CH2 });
  await post({ merchantId: m, amountCents: -5000, bucket: "available", kind: "cash_out", refType: "payout", refId: PO1 });
  await post({ merchantId: m, amountCents: -100, bucket: "available", kind: "fee_out", refType: "payout", refId: PO1 });

  const s = await periodSummary(m, "2026-10-01", "2026-10-31");
  expect(s).toEqual({
    inflowCents: 20000,
    inflowCount: 2,
    outflowCents: 5000,
    outflowCount: 1,
    feeInCents: 298,
    feeOutCents: 100,
    resultCents: 15000,
  });
});

it("periodSummary respects Brasília day boundary", async () => {
  const m = await newMerchant(d, 1);
  // 02:00 UTC do dia 02 = 23:00 BRT do dia 01 → conta no dia 01, não no 02.
  await post({
    merchantId: m,
    amountCents: 10000,
    bucket: "available",
    kind: "cash_in",
    refType: "charge",
    refId: CH1,
    createdAt: new Date("2026-10-02T02:00:00Z"),
  });
  // Dia 01 (BRT) inclui o lançamento; dia 02 (BRT) não.
  expect((await periodSummary(m, "2026-10-01", "2026-10-01")).inflowCents).toBe(10000);
  expect((await periodSummary(m, "2026-10-02", "2026-10-02")).inflowCents).toBe(0);
});

it("dailyFlow returns one row per day with movement", async () => {
  const m = await newMerchant(d, 1);
  await post({
    merchantId: m, amountCents: 10000, bucket: "available", kind: "cash_in", refType: "charge", refId: CH1,
    createdAt: new Date("2026-10-01T15:00:00Z"), // 12:00 BRT dia 01
  });
  await post({
    merchantId: m, amountCents: -5000, bucket: "available", kind: "cash_out", refType: "payout", refId: PO1,
    createdAt: new Date("2026-10-03T15:00:00Z"), // 12:00 BRT dia 03
  });
  const rows = await dailyFlow(m, "2026-10-01", "2026-10-31");
  expect(rows).toEqual([
    { day: "2026-10-01", inflowCents: 10000, outflowCents: 0 },
    { day: "2026-10-03", inflowCents: 0, outflowCents: 5000 },
  ]);
});

it("previousPeriod of 1–16 is previous 16 days ending day before", () => {
  expect(previousPeriod("2026-10-01", "2026-10-16")).toEqual({ fromDay: "2026-09-15", toDay: "2026-09-30" });
});

it("pctDelta null when previous <= 0; pctDelta(112,100)===0.12", () => {
  expect(pctDelta(5000, 0)).toBeNull();
  expect(pctDelta(5000, -10)).toBeNull();
  expect(pctDelta(112, 100)).toBe(0.12);
});
