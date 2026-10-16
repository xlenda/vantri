import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { ledgerEntries, merchants, payouts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import {
  applyPayoutResult,
  createPayout,
  findPayoutIdByProviderId,
  getPayout,
  listPayouts,
  pollProcessingPayouts,
  toPayoutJson,
} from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;
let queries: string[];

beforeAll(() => {
  process.env.PIX_PROVIDER = "simulator";
});

beforeEach(async () => {
  queries = [];
  d = await createTestDb({ logger: (q) => queries.push(q) });
  setDb(d);
});

/** Lojista ativo com 14767 disponíveis (cobrança de 14990 com taxa de 223, lançada direto no razão). */
async function richMerchant(n = 1): Promise<string> {
  const m = await newMerchant(d, n);
  await d.update(merchants).set({ status: "active", providerAccountId: `sim_acc_${n}` }).where(eq(merchants.id, m));
  const ref = randomUUID();
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId: m, amountCents: 14990, bucket: "available", kind: "cash_in", refType: "charge", refId: ref },
      { merchantId: m, amountCents: -223, bucket: "available", kind: "fee_in", refType: "charge", refId: ref },
    ]),
  );
  return m;
}

const BODY = { amount: 10000, pix_key: "52998224725", pix_key_type: "cpf" };
const available = async (m: string) => (await getBalance(m)).available;
const payoutRow = async (id: string) => (await d.select().from(payouts).where(eq(payouts.id, id)))[0];
const reversals = () => d.$count(ledgerEntries, eq(ledgerEntries.kind, "cash_out_reversal"));

it("payout debits amount + fee", async () => {
  const m = await richMerchant();
  const { payout, replayed } = await createPayout(m, BODY, "chave-0001");
  expect(replayed).toBe(false);
  expect(payout).toMatchObject({ amountCents: 10000, feeCents: 100, status: "completed" });
  expect(payout.endToEndId).toMatch(/^E/);
  expect(payout.providerPayoutId).toMatch(/^sim_po_/);
  expect(await available(m)).toBe(4667);
  expect(await findPayoutIdByProviderId(payout.providerPayoutId!)).toBe(payout.id);

  const json = toPayoutJson(payout);
  expect(Object.keys(json).sort()).toEqual(
    [
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
    ].sort(),
  );
  expect(json).toMatchObject({ amount: 10000, fee: 100, status: "completed", failure_code: null });
  expect(json.completed_at).toBe(payout.completedAt!.toISOString());
});

it("insufficient balance returns insufficient_balance and writes nothing", async () => {
  const m = await richMerchant();
  // 14668 + 100 de taxa = 14768 > 14767.
  await expect(createPayout(m, { ...BODY, amount: 14668 }, "chave-0001")).rejects.toMatchObject({
    code: "insufficient_balance",
  });
  expect(await d.$count(payouts)).toBe(0);
  expect(await d.$count(ledgerEntries)).toBe(2);
  expect(await available(m)).toBe(14767);
  // No limite exato passa e zera.
  await createPayout(m, { ...BODY, amount: 14667 }, "chave-0002");
  expect(await available(m)).toBe(0);
});

it("percentage fee_out is rounded and added to the fixed part", async () => {
  const m = await richMerchant();
  await d.update(merchants).set({ feeOutBps: 125, feeOutFixedCents: 100 }).where(eq(merchants.id, m));
  // 9999 × 125 / 10000 = 124,9875 → 125; + 100 fixo = 225.
  const { payout } = await createPayout(m, { ...BODY, amount: 9999 }, "chave-0001");
  expect(payout.feeCents).toBe(225);
  expect(await available(m)).toBe(14767 - 9999 - 225);
});

it("replay same key same body returns same payout", async () => {
  const m = await richMerchant();
  const spy = vi.spyOn(simulator, "createPayout");
  const first = await createPayout(m, BODY, "chave-0001");
  // Mesma entrada com as chaves em outra ordem não é conflito.
  const again = await createPayout(m, { pix_key_type: "cpf", pix_key: "52998224725", amount: 10000 }, "chave-0001");
  expect(spy).toHaveBeenCalledTimes(1); // replay não chama o provedor de novo
  spy.mockRestore();
  expect(again.replayed).toBe(true);
  expect(again.payout.id).toBe(first.payout.id);
  expect(toPayoutJson(again.payout)).toEqual(toPayoutJson(first.payout));
  expect(await d.$count(payouts)).toBe(1);
  expect(await available(m)).toBe(4667);
});

it("same key different body → idempotency_conflict", async () => {
  const m = await richMerchant();
  await createPayout(m, BODY, "chave-0001");
  await expect(createPayout(m, { ...BODY, amount: 2000 }, "chave-0001")).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
  expect(await d.$count(payouts)).toBe(1);
  expect(await available(m)).toBe(4667);
});

it("failed payout reverses once", async () => {
  const m = await richMerchant();
  await d.insert(webhookEndpoints).values({
    merchantId: m,
    url: "https://loja.example.com/hooks",
    secretEnc: "v1:x:y:z",
    events: ["payout.completed", "payout.failed"],
  });
  const { payout } = await createPayout(
    m,
    { amount: 10000, pix_key: "Falha@Teste.com", pix_key_type: "email", description: "Retirada" },
    "chave-0001",
  );
  expect(payout).toMatchObject({ status: "failed", failureCode: "pix_key_not_found", pixKey: "falha@teste.com" });
  expect(await available(m)).toBe(14767);

  await applyPayoutResult(payout.id, { status: "failed", failureCode: "pix_key_not_found" });
  await applyPayoutResult(payout.id, { status: "completed", endToEndId: "E123" });
  expect(await available(m)).toBe(14767);
  expect(await reversals()).toBe(1);
  expect((await payoutRow(payout.id)).status).toBe("failed");

  const deliveries = await d.select().from(webhookDeliveries);
  expect(deliveries.map((x) => x.eventType)).toEqual(["payout.failed"]);
  expect((deliveries[0].payload as { data: unknown }).data).toEqual(
    JSON.parse(JSON.stringify(toPayoutJson(payout))),
  );
});

it("completed then failed is ignored", async () => {
  const m = await richMerchant();
  const { payout } = await createPayout(m, BODY, "chave-0001");
  expect(payout.status).toBe("completed");
  await applyPayoutResult(payout.id, { status: "failed", failureCode: "pix_key_not_found" });
  const row = await payoutRow(payout.id);
  expect(row.status).toBe("completed");
  expect(row.failureCode).toBeNull();
  expect(await reversals()).toBe(0);
  expect(await available(m)).toBe(4667);
});

it("locks merchant row", async () => {
  const m = await richMerchant();
  queries.length = 0;
  await createPayout(m, BODY, "chave-0001");
  const lock = queries.findIndex((q) => /from "merchants".* for update/i.test(q));
  const sum = queries.findIndex((q) => /sum\("amount_cents"\).* from "ledger_entries"/i.test(q));
  expect(lock).toBeGreaterThanOrEqual(0);
  expect(sum).toBeGreaterThan(lock);
});

it("rejects invalid cpf key", async () => {
  const m = await richMerchant();
  await expect(createPayout(m, { ...BODY, pix_key: "52998224724" }, "chave-0001")).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(await d.$count(payouts)).toBe(0);
  expect(await available(m)).toBe(14767);
});

it("rejects strange amounts, bad keys and unknown fields", async () => {
  const m = await richMerchant();
  const bad: unknown[] = [
    { ...BODY, amount: 0 },
    { ...BODY, amount: -1 },
    { ...BODY, amount: 1.5 },
    { ...BODY, amount: "10000" },
    { ...BODY, amount: 99 },
    { ...BODY, amount: 5_000_001 },
    { ...BODY, merchant_id: m },
    { ...BODY, description: "x".repeat(141) },
    { amount: 10000, pix_key: "11111111111111", pix_key_type: "cnpj" },
    { amount: 10000, pix_key: "sem-arroba.com", pix_key_type: "email" },
    { amount: 10000, pix_key: "11987654321", pix_key_type: "phone" },
    { amount: 10000, pix_key: "+551198765432100", pix_key_type: "phone" },
    { amount: 10000, pix_key: "not-a-uuid", pix_key_type: "evp" },
    { amount: 10000, pix_key: "52998224725", pix_key_type: "aleatoria" },
    null,
  ];
  for (const input of bad) {
    await expect(createPayout(m, input, "chave-0001"), JSON.stringify(input)).rejects.toMatchObject({
      code: "invalid_request",
    });
  }
  expect(await d.$count(payouts)).toBe(0);
});

it("accepts every key type", async () => {
  const m = await richMerchant();
  const ok = [
    { pix_key: "529.982.247-25", pix_key_type: "cpf", stored: "52998224725" },
    { pix_key: "11.222.333/0001-81", pix_key_type: "cnpj", stored: "11222333000181" },
    { pix_key: "12.abc.345/01de-35", pix_key_type: "cnpj", stored: "12ABC34501DE35" }, // CNPJ alfanumérico
    { pix_key: "+5511987654321", pix_key_type: "phone", stored: "+5511987654321" },
    {
      pix_key: "123E4567-E89B-42D3-A456-426614174000",
      pix_key_type: "evp",
      stored: "123e4567-e89b-42d3-a456-426614174000",
    },
  ];
  for (const [i, k] of ok.entries()) {
    const { payout } = await createPayout(
      m,
      { amount: 100, pix_key: k.pix_key, pix_key_type: k.pix_key_type },
      `chave-000${i}`,
    );
    expect(payout.pixKey).toBe(k.stored);
  }
});

it("rejects when merchant not active, but replays what already exists", async () => {
  const m = await richMerchant();
  const { payout } = await createPayout(m, BODY, "chave-0001");
  await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, m));
  const again = await createPayout(m, BODY, "chave-0001");
  expect(again).toMatchObject({ replayed: true, payout: { id: payout.id } });
  await expect(createPayout(m, BODY, "chave-0002")).rejects.toMatchObject({ code: "merchant_inactive" });
  expect(await d.$count(payouts)).toBe(1);
});

it("provider error leaves payout processing and the poll finishes it", async () => {
  const m = await richMerchant();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const spy = vi.spyOn(simulator, "createPayout").mockRejectedValueOnce(new Error("ECONNRESET"));
  try {
    const { payout } = await createPayout(m, BODY, "chave-0001");
    expect(payout.status).toBe("processing");
    expect(payout.providerPayoutId).toBeNull();
    expect(await available(m)).toBe(4667);

    // Status que não é completed/failed explícito: ignorado, sem estorno.
    await applyPayoutResult(payout.id, { status: "estornado" as never });
    expect((await payoutRow(payout.id)).status).toBe("processing");
    expect(await reversals()).toBe(0);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/status desconhecido/));

    expect(await pollProcessingPayouts(120)).toBe(0); // ainda novo demais
    // Lojista sem conta no provedor: pula e avisa.
    await d.update(merchants).set({ providerAccountId: null }).where(eq(merchants.id, m));
    expect(await pollProcessingPayouts(0)).toBe(0);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/sem conta no provedor/));
    await d.update(merchants).set({ providerAccountId: "sim_acc_1" }).where(eq(merchants.id, m));

    expect(await pollProcessingPayouts(0)).toBe(1);
    // Envio e reenvio usam o id do saque como chave de idempotência no provedor.
    expect(spy.mock.calls[0][0].idempotencyKey).toBe(payout.id);
    expect(spy.mock.calls[1][0].idempotencyKey).toBe(payout.id);
    const row = await payoutRow(payout.id);
    expect(row.status).toBe("completed");
    expect(row.providerPayoutId).toMatch(/^sim_po_/);
    expect(await pollProcessingPayouts(0)).toBe(0);
  } finally {
    spy.mockRestore();
    err.mockRestore();
  }
});

it("reversal already in the ledger rolls back the failed transition", async () => {
  const m = await richMerchant();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const spy = vi.spyOn(simulator, "createPayout").mockRejectedValueOnce(new Error("ECONNRESET"));
  try {
    const { payout } = await createPayout(m, BODY, "chave-0001");
    await d.transaction((tx) =>
      postEntries(tx, [
        { merchantId: m, amountCents: 10100, bucket: "available", kind: "cash_out_reversal", refType: "payout", refId: payout.id },
      ]),
    );
    await applyPayoutResult(payout.id, { status: "failed", failureCode: "pix_key_not_found" });
    expect((await payoutRow(payout.id)).status).toBe("processing"); // UPDATE desfeito junto
    expect(await reversals()).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/estorno já lançado/));
  } finally {
    spy.mockRestore();
    err.mockRestore();
  }
});

it("getPayout and listPayouts only see own payouts, with cursor", async () => {
  const m = await richMerchant(1);
  const other = await richMerchant(2);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await createPayout(m, { ...BODY, amount: 1000 }, `chave-000${i}`)).payout.id);
  const foreign = (await createPayout(other, BODY, "chave-0001")).payout;

  expect((await getPayout(m, ids[0]))?.id).toBe(ids[0]);
  expect(await getPayout(m, foreign.id)).toBeNull();
  expect(await getPayout(m, "lixo")).toBeNull();

  const p1 = await listPayouts(m, { limit: 2 });
  expect(p1.data.map((p) => p.id)).toEqual([ids[2], ids[1]]);
  expect(p1.nextCursor).toBe(ids[1]);
  const p2 = await listPayouts(m, { limit: 2, cursor: p1.nextCursor! });
  expect(p2.data.map((p) => p.id)).toEqual([ids[0]]);
  expect(p2.nextCursor).toBeNull();
  await expect(listPayouts(m, { cursor: "lixo" })).rejects.toMatchObject({ code: "invalid_request" });
});
