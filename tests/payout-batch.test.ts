import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { merchants, payoutBatches, payouts } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import {
  createBatchPayout,
  DEFAULT_PAYOUT_CEILING_CENTS,
  getBatch,
  listBatchPayouts,
  needsBatch,
  payoutCeilingCents,
  resumeBatch,
  splitGreedy,
} from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeAll(() => {
  process.env.PIX_PROVIDER = "simulator";
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  // Teto de R$ 150,00 para os testes de integração: 40000 (R$ 400) → [15000, 15000, 10000].
  process.env.PAYOUT_CEILING_CENTS = "15000";
});

afterEach(() => {
  delete process.env.PAYOUT_CEILING_CENTS;
  vi.restoreAllMocks();
});

/** Lojista ativo com saldo exato em `cents` disponível, sem taxa de saque (feeOut = 0). */
async function merchantWith(cents: number, n = 1): Promise<string> {
  const m = await newMerchant(d, n);
  await d
    .update(merchants)
    .set({ status: "active", providerAccountId: `sim_acc_${n}`, feeOutBps: 0, feeOutFixedCents: 0 })
    .where(eq(merchants.id, m));
  if (cents > 0) {
    await d.transaction((tx) =>
      postEntries(tx, [
        { merchantId: m, amountCents: cents, bucket: "available", kind: "cash_in", refType: "charge", refId: randomUUID() },
      ]),
    );
  }
  return m;
}

const BODY = { pix_key: "loja@teste.com", pix_key_type: "email" as const };
const available = async (m: string) => (await getBalance(m)).available;
const countPayouts = (batchId: string) => d.$count(payouts, eq(payouts.batchId, batchId));
const batchPayouts = (batchId: string) =>
  d.select().from(payouts).where(eq(payouts.batchId, batchId)).orderBy(payouts.batchIndex);

// ---- Puros ----

it("splitGreedy: parcelas cheias + resto na última, centavos inteiros", () => {
  expect(splitGreedy(4_000_000, 1_500_000)).toEqual([1_500_000, 1_500_000, 1_000_000]);
  expect(splitGreedy(1_500_001, 1_500_000)).toEqual([1_500_000, 1]);
  expect(splitGreedy(40000, 15000)).toEqual([15000, 15000, 10000]);
  expect(splitGreedy(15000, 15000)).toEqual([15000]); // divide exato = uma parcela
  expect(splitGreedy(100, 15000)).toEqual([100]); // menor que o teto = uma parcela
  // Soma das parcelas é sempre o total (sem perder/criar centavo).
  for (const [total, ceil] of [[4_000_000, 1_500_000], [1_500_001, 1_500_000], [40000, 15000], [99999, 7]] as const) {
    expect(splitGreedy(total, ceil).reduce((a, b) => a + b, 0)).toBe(total);
  }
});

it("needsBatch: teto exato = false, teto+1 = true", () => {
  expect(needsBatch(15000, 15000)).toBe(false);
  expect(needsBatch(15001, 15000)).toBe(true);
  expect(needsBatch(1, 15000)).toBe(false);
});

it("payoutCeilingCents: default e override por env, ignora lixo", () => {
  delete process.env.PAYOUT_CEILING_CENTS; // o beforeEach seta 15000; aqui testamos o default
  expect(DEFAULT_PAYOUT_CEILING_CENTS).toBe(1_500_000);
  expect(payoutCeilingCents()).toBe(1_500_000);
  process.env.PAYOUT_CEILING_CENTS = "2000000";
  expect(payoutCeilingCents()).toBe(2_000_000);
  process.env.PAYOUT_CEILING_CENTS = "lixo";
  expect(payoutCeilingCents()).toBe(1_500_000); // valor inválido não vira NaN
  process.env.PAYOUT_CEILING_CENTS = "0";
  expect(payoutCeilingCents()).toBe(1_500_000); // zero/negativo não vale como teto
  process.env.PAYOUT_CEILING_CENTS = "9000000";
  expect(payoutCeilingCents()).toBe(5_000_000); // limitado ao teto do saque avulso (toda parcela cabe no createPayout)
});

// ---- createBatchPayout ----

it("createBatchPayout debita cada parcela e soma ao total", async () => {
  const m = await merchantWith(40000);
  const r = await createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001");
  expect(r.status).toBe("completed");
  expect(r.chunks.map((c) => c.amountCents)).toEqual([15000, 15000, 10000]);
  expect(r.chunks.every((c) => c.status === "completed")).toBe(true);

  const ps = await batchPayouts(r.batchId);
  expect(ps.map((p) => p.batchIndex)).toEqual([0, 1, 2]);
  expect(ps.map((p) => p.amountCents)).toEqual([15000, 15000, 10000]);
  expect(ps.every((p) => p.status === "completed")).toBe(true);
  expect(ps.map((p) => p.idempotencyKey)).toEqual([`${r.batchId}:0`, `${r.batchId}:1`, `${r.batchId}:2`]);
  expect(await available(m)).toBe(0); // 40000 debitado, taxa 0

  const b = await getBatch(m, r.batchId);
  expect(b).toMatchObject({
    status: "completed",
    totalCents: 40000,
    chunkCents: payoutCeilingCents(),
    count: 3,
    failedAtIndex: null,
  });
  expect((await listBatchPayouts(m, r.batchId)).length).toBe(3);
});

it("saldo insuficiente para o lote inteiro não grava nada", async () => {
  // Saldo para 2 de 3 parcelas (30000 < 40000). Sem a pré-checagem, as 2 primeiras parcelas
  // seriam debitadas e só a 3ª falharia — por isso a pré-checagem barra o lote inteiro.
  const m = await merchantWith(30000);
  await expect(createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001")).rejects.toMatchObject({
    code: "insufficient_balance",
  });
  expect(await d.$count(payouts)).toBe(0);
  expect(await d.$count(payoutBatches)).toBe(0);
  expect(await available(m)).toBe(30000);
});

it("saldo insuficiente conta a tarifa de cada parcela", async () => {
  // feeOut fixo 100/parcela: 40000 + 3×100 = 40300 > 40000.
  const m = await merchantWith(40000);
  await d.update(merchants).set({ feeOutFixedCents: 100 }).where(eq(merchants.id, m));
  await expect(createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001")).rejects.toMatchObject({
    code: "insufficient_balance",
  });
  expect(await d.$count(payoutBatches)).toBe(0);
  expect(await available(m)).toBe(40000);
});

it("chave rejeitada (falha@teste.com): lote partial, failedAtIndex=0, nada debitado", async () => {
  // falha@teste.com é a chave do lote inteiro → a 1ª parcela já cai em failed (com estorno) e para o lote.
  const m = await merchantWith(40000);
  const r = await createBatchPayout(m, { pix_key: "falha@teste.com", pix_key_type: "email", amount: 40000 }, "lote-0001");
  expect(r.status).toBe("partial");
  expect(await getBatch(m, r.batchId)).toMatchObject({ status: "partial", failedAtIndex: 0 });
  const ps = await batchPayouts(r.batchId);
  expect(ps.length).toBe(1); // parou na parcela 0; 1 e 2 nunca criadas
  expect(ps[0]).toMatchObject({ batchIndex: 0, status: "failed" });
  expect(await available(m)).toBe(40000); // parcela 0 falhou e estornou → saldo intacto
});

it("retomar uma chave rejeitada replay a parcela e não paga de novo (idempotente)", async () => {
  const m = await merchantWith(40000);
  const first = await createBatchPayout(m, { pix_key: "falha@teste.com", pix_key_type: "email", amount: 40000 }, "lote-0001");
  expect(first.status).toBe("partial");
  const saldo = await available(m);

  const spy = vi.spyOn(simulator, "createPayout");
  const r1 = await resumeBatch(m, first.batchId); // parcela 0 (failed) → replay, sem reenvio ao provedor
  expect(spy).not.toHaveBeenCalled(); // parcela com linha persistida não chama o provedor de novo
  const r2 = await resumeBatch(m, first.batchId); // retomar de novo também é inócuo
  expect(spy).not.toHaveBeenCalled();

  expect(r1.status).toBe("partial");
  expect(r2.status).toBe("partial");
  expect(await countPayouts(first.batchId)).toBe(1); // nenhuma parcela nova, nenhuma duplicada
  expect(await available(m)).toBe(saldo); // chave de idempotência `${batchId}:${i}` impede novo débito
});

it("retomar re-envia da falha em diante e NÃO paga de novo a parcela concluída", async () => {
  // Falha transiente: a parcela 1 lança merchant_inactive (rollback, SEM linha). A retomada a re-envia de verdade.
  // Determinístico: o spy suspende o lojista no envio da parcela 0, então a parcela 1 cai em merchant_inactive.
  const m = await merchantWith(40000);
  const real = simulator.createPayout.bind(simulator);
  let calls = 0;
  const spy = vi.spyOn(simulator, "createPayout").mockImplementation(async (arg) => {
    if (calls++ === 0) {
      const res = await real(arg); // parcela 0 envia normalmente...
      await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, m)); // ...e suspende antes da 1
      return res;
    }
    return real(arg);
  });
  const first = await createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001");
  expect(first.status).toBe("partial");
  expect(await getBatch(m, first.batchId)).toMatchObject({ status: "partial", failedAtIndex: 1 });
  const ps1 = await batchPayouts(first.batchId);
  expect(ps1.length).toBe(1); // só a parcela 0 ficou (a 1 deu rollback, a 2 nem tentou)
  expect(ps1[0]).toMatchObject({ batchIndex: 0, status: "completed" });
  const saldoAposFalha = await available(m); // 40000 - 15000 = 25000
  expect(saldoAposFalha).toBe(25000);
  const callsAfterCreate = calls;

  // Reativa e retoma.
  await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, m));
  const resumed = await resumeBatch(m, first.batchId);
  // Reenviou só as parcelas 1 e 2 (a 0 não é reenviada — retomada começa em failedAtIndex).
  expect(calls - callsAfterCreate).toBe(2);
  spy.mockRestore();

  expect(resumed.status).toBe("completed");
  const ps2 = await batchPayouts(first.batchId);
  expect(ps2.map((p) => p.batchIndex)).toEqual([0, 1, 2]);
  expect(ps2.every((p) => p.status === "completed")).toBe(true);
  expect(await countPayouts(first.batchId)).toBe(3);
  // Parcela 0 não debitou de novo: 25000 - 15000 (p1) - 10000 (p2) = 0.
  expect(await available(m)).toBe(0);
  expect((await getBatch(m, first.batchId))?.status).toBe("completed");
});

it("retomar um lote já completo é invalid_status e não duplica nada", async () => {
  const m = await merchantWith(40000);
  const r = await createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001");
  expect(r.status).toBe("completed");
  const count = await countPayouts(r.batchId);
  await expect(resumeBatch(m, r.batchId)).rejects.toMatchObject({ code: "invalid_status" });
  expect(await countPayouts(r.batchId)).toBe(count);
  expect(await available(m)).toBe(0);
});

it("replay da chave do lote devolve o mesmo lote", async () => {
  const m = await merchantWith(40000);
  const first = await createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001");
  const again = await createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001");
  expect(again.batchId).toBe(first.batchId);
  expect(again.replayed).toBe(true);
  expect(await d.$count(payoutBatches)).toBe(1);
  expect(await countPayouts(first.batchId)).toBe(3);
  expect(await available(m)).toBe(0);
  // Mesma chave, corpo diferente → conflito.
  await expect(createBatchPayout(m, { ...BODY, amount: 30000 }, "lote-0001")).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
});

it("lote de outro lojista → not_found", async () => {
  const m = await merchantWith(40000, 1);
  const other = await merchantWith(40000, 2);
  const r = await createBatchPayout(m, { ...BODY, amount: 40000 }, "lote-0001");
  expect(await getBatch(other, r.batchId)).toBeNull();
  expect((await listBatchPayouts(other, r.batchId)).length).toBe(0);
  await expect(resumeBatch(other, r.batchId)).rejects.toMatchObject({ code: "not_found" });
  expect(await getBatch(m, "lixo")).toBeNull();
  await expect(resumeBatch(m, "lixo")).rejects.toMatchObject({ code: "not_found" });
});

it("não parcela quando amount <= teto (needsBatch) — rejeita invalid_request", async () => {
  const m = await merchantWith(40000);
  await expect(
    createBatchPayout(m, { ...BODY, amount: payoutCeilingCents() }, "lote-0001"),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(await d.$count(payoutBatches)).toBe(0);
});
