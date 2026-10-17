import { beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { ledgerEntries } from "@/lib/db/schema";
import { getBalance } from "@/lib/money/ledger";
import { dailyClosing, listStatementWithBalance } from "@/lib/services/statement-extra";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

const REF = "00000000-0000-4000-8000-0000000000";
type Seed = {
  merchantId: string;
  amountCents: number;
  bucket?: "available" | "blocked";
  kind?: (typeof ledgerEntries.kind.enumValues)[number];
  at: string; // ISO
  n: number; // sufixo do ref_id (idempotência exige unicidade)
};
// Insere na ordem passada, com created_at explícito, para o saldo corrido ser determinístico.
async function seed(rows: Seed[]) {
  for (const r of rows) {
    await d.insert(ledgerEntries).values({
      merchantId: r.merchantId,
      amountCents: r.amountCents,
      bucket: r.bucket ?? "available",
      kind: r.kind ?? "cash_in",
      refType: "manual",
      refId: `${REF}${String(r.n).padStart(2, "0")}`,
      createdAt: new Date(r.at),
    });
  }
}

it("balanceAfter matches getBalance at each cut", async () => {
  const m = await newMerchant(d, 1);
  await seed([
    { merchantId: m, amountCents: 10000, at: "2026-03-01T12:00:00Z", n: 1 },
    { merchantId: m, amountCents: -149, kind: "fee_in", at: "2026-03-01T12:01:00Z", n: 2 },
    { merchantId: m, amountCents: 5000, at: "2026-03-02T12:00:00Z", n: 3 },
  ]);
  const { data } = await listStatementWithBalance(m, { from: "2026-03-01", to: "2026-03-02" });
  // Mais novos primeiro: 3º, 2º, 1º.
  expect(data.map((r) => r.balanceAfter)).toEqual([14851, 9851, 10000]);
  // Saldo após o 2º lançamento = soma dos dois primeiros.
  expect(data[1].balanceAfter).toBe(10000 - 149);
  // Saldo corrido do lançamento mais novo = getBalance.available.
  expect(data[0].balanceAfter).toBe((await getBalance(m)).available);
});

it("balanceAfter ignores blocked bucket and prior history before the window", async () => {
  const m = await newMerchant(d, 1);
  await seed([
    { merchantId: m, amountCents: 7000, at: "2026-01-10T12:00:00Z", n: 1 }, // antes da janela: conta no saldo
    { merchantId: m, amountCents: 500, bucket: "blocked", kind: "med_hold", at: "2026-03-01T10:00:00Z", n: 2 },
    { merchantId: m, amountCents: 2000, at: "2026-03-01T12:00:00Z", n: 3 },
  ]);
  const { data } = await listStatementWithBalance(m, { from: "2026-03-01", to: "2026-03-01" });
  const rows = data.map((r) => ({ amount: r.amountCents, bal: r.balanceAfter }));
  // Janela traz 2 lançamentos do dia; o blocked não soma no saldo corrido; o histórico anterior (7000) soma.
  expect(rows).toEqual([
    { amount: 2000, bal: 9000 }, // 7000 + 2000
    { amount: 500, bal: 7000 }, // blocked não altera o available
  ]);
});

it("balanceAfter is null when kind filter active", async () => {
  const m = await newMerchant(d, 1);
  await seed([
    { merchantId: m, amountCents: 10000, at: "2026-03-01T12:00:00Z", n: 1 },
    { merchantId: m, amountCents: -149, kind: "fee_in", at: "2026-03-01T12:01:00Z", n: 2 },
  ]);
  const { data } = await listStatementWithBalance(m, { from: "2026-03-01", to: "2026-03-01", kind: ["fee_in"] });
  expect(data).toHaveLength(1);
  expect(data[0].kind).toBe("fee_in");
  expect(data[0].balanceAfter).toBeNull();
});

it("filters by direction/kind/value range on the server", async () => {
  const m = await newMerchant(d, 1);
  await seed([
    { merchantId: m, amountCents: 10000, kind: "cash_in", at: "2026-03-01T12:00:00Z", n: 1 },
    { merchantId: m, amountCents: -3000, kind: "cash_out", at: "2026-03-01T12:01:00Z", n: 2 },
    { merchantId: m, amountCents: -149, kind: "fee_in", at: "2026-03-01T12:02:00Z", n: 3 },
    { merchantId: m, amountCents: -8000, kind: "cash_out", at: "2026-03-01T12:03:00Z", n: 4 },
  ]);
  // direction=out → só os negativos.
  const out = await listStatementWithBalance(m, { from: "2026-03-01", to: "2026-03-01", direction: "out" });
  expect(out.data.every((r) => r.amountCents < 0)).toBe(true);
  expect(out.data).toHaveLength(3);
  // kind=cash_out → só saques.
  const saques = await listStatementWithBalance(m, { from: "2026-03-01", to: "2026-03-01", kind: ["cash_out"] });
  expect(saques.data.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-8000, -3000]);
  // Faixa de valor (valor absoluto): 3000..10000 exclui o fee de 149.
  const faixa = await listStatementWithBalance(m, { from: "2026-03-01", to: "2026-03-01", minCents: 3000, maxCents: 10000 });
  expect(faixa.data.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-8000, -3000, 10000]);
});

it("dailyClosing is continuous and closing = opening + inflow - outflow - fee ± med", async () => {
  const m = await newMerchant(d, 1);
  await seed([
    // Dia 01: entrada 10000, tarifa -149, MED hold -500 (available).
    { merchantId: m, amountCents: 10000, kind: "cash_in", at: "2026-03-01T12:00:00Z", n: 1 },
    { merchantId: m, amountCents: -149, kind: "fee_in", at: "2026-03-01T12:01:00Z", n: 2 },
    { merchantId: m, amountCents: -500, kind: "med_hold", at: "2026-03-01T12:02:00Z", n: 3 },
    // Dia 02: sem movimento (deve repetir o fechamento). Dia 03: saque -2000.
    { merchantId: m, amountCents: -2000, kind: "cash_out", at: "2026-03-03T12:00:00Z", n: 4 },
  ]);
  const series = await dailyClosing(m, "2026-03-01", "2026-03-03");
  expect(series.map((r) => r.day)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);

  const [d1, d2, d3] = series;
  expect(d1).toEqual({
    day: "2026-03-01",
    openingCents: 0,
    inflowCents: 10000,
    outflowCents: 0,
    feeCents: 149,
    medCents: -500,
    closingCents: 9351,
  });
  // Dia sem movimento: fechamento repetido, tudo zero.
  expect(d2).toEqual({
    day: "2026-03-02",
    openingCents: 9351,
    inflowCents: 0,
    outflowCents: 0,
    feeCents: 0,
    medCents: 0,
    closingCents: 9351,
  });
  expect(d3.openingCents).toBe(9351);
  expect(d3.outflowCents).toBe(2000);
  expect(d3.closingCents).toBe(7351);
  // Identidade em cada dia: closing = opening + inflow - outflow - fee + med.
  for (const r of series) {
    expect(r.closingCents).toBe(r.openingCents + r.inflowCents - r.outflowCents - r.feeCents + r.medCents);
  }
  // Fechamento do último dia reconcilia com getBalance.available.
  expect(d3.closingCents).toBe((await getBalance(m)).available);
});

it("dailyClosing opening carries history before the window", async () => {
  const m = await newMerchant(d, 1);
  await seed([
    { merchantId: m, amountCents: 4000, kind: "cash_in", at: "2026-01-05T12:00:00Z", n: 1 }, // antes da janela
    { merchantId: m, amountCents: 1000, kind: "cash_in", at: "2026-03-01T12:00:00Z", n: 2 },
  ]);
  const [d1] = await dailyClosing(m, "2026-03-01", "2026-03-01");
  expect(d1.openingCents).toBe(4000);
  expect(d1.closingCents).toBe(5000);
});

it("dailyClosing rejects period > 366 days", async () => {
  const m = await newMerchant(d, 1);
  await expect(dailyClosing(m, "2026-01-01", "2027-01-02")).rejects.toThrow(/366 dias/);
  // 366 dias exatos (inclusivo) passa.
  await expect(dailyClosing(m, "2026-01-01", "2026-12-31")).resolves.toBeInstanceOf(Array);
});
