import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isValidCnpj, isValidCpf, normalizeDocument, onlyDigits } from "@/lib/br/documents";
import { sha256Hex } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { merchants, payoutBatches, payouts } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { computeFee } from "@/lib/money/fees";
import { getBalance, type LedgerEntry, lockMerchant, postEntries } from "@/lib/money/ledger";
import { getProvider, SIMULATED_ACCOUNT_MESSAGE, simulatedAccountOutsideSimulator } from "@/lib/provider";
import type { PixKeyType, PixProvider } from "@/lib/provider/types";
import { writeAudit } from "@/lib/services/admin/audit-util";
import { emit } from "@/lib/services/events";
import { parseOr } from "@/lib/validation";

export type PayoutRow = typeof payouts.$inferSelect;
type PayoutResult = { status: PayoutRow["status"]; failureCode?: string; endToEndId?: string };

export type PayoutErrorCode =
  | "invalid_request"
  | "idempotency_conflict"
  | "insufficient_balance"
  | "not_found"
  | "merchant_inactive"
  | "simulated_account";

export class PayoutError extends Error {
  constructor(
    public readonly code: PayoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PayoutError";
  }
}

/** Formato público (API e webhooks). */
export function toPayoutJson(p: PayoutRow) {
  return {
    id: p.id,
    amount: p.amountCents,
    fee: p.feeCents,
    pix_key: p.pixKey,
    pix_key_type: p.pixKeyType,
    description: p.description,
    status: p.status,
    failure_code: p.failureCode,
    end_to_end_id: p.endToEndId,
    created_at: p.createdAt.toISOString(),
    completed_at: p.completedAt?.toISOString() ?? null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normaliza a chave para o formato do DICT; null se não for válida para o tipo. */
function normalizeKey(type: PixKeyType, key: string): string | null {
  const k = key.trim();
  switch (type) {
    case "cpf":
    case "cnpj": {
      const d = normalizeDocument(k);
      return (type === "cpf" ? isValidCpf(d) : isValidCnpj(d)) ? d : null;
    }
    case "email":
      return k.length <= 77 && EMAIL.test(k) ? k.toLowerCase() : null;
    case "phone":
      return /^\+55\d{10,11}$/.test(k) ? k : null;
    case "evp":
      return UUID.test(k) ? k.toLowerCase() : null;
  }
}

const payoutSchema = z.strictObject({
  amount: z.int().min(100).max(5_000_000),
  pix_key: z.string().max(100),
  pix_key_type: z.enum(payouts.pixKeyType.enumValues),
  description: z.string().max(140).optional(),
});

/** Formato da chave para o tipo: a mensagem do erro, ou null se válida. O painel confere antes de gastar o código 2FA. */
export function pixKeyProblem(type: PixKeyType, key: string): string | null {
  return normalizeKey(type, key) === null ? `Chave Pix inválida para o tipo ${type}.` : null;
}

function parse(input: unknown): z.output<typeof payoutSchema> {
  const data = parseOr(payoutSchema, input, (msg) => new PayoutError("invalid_request", msg));
  const problem = pixKeyProblem(data.pix_key_type, data.pix_key);
  if (problem) throw new PayoutError("invalid_request", problem);
  return { ...data, pix_key: normalizeKey(data.pix_key_type, data.pix_key)! };
}

// Sentinela: lançamento que já existia desfaz a transação inteira (nunca grava meio lote).
class DuplicateEntry extends Error {}
async function post(tx: Tx, entries: LedgerEntry[]): Promise<void> {
  if (!(await postEntries(tx, entries))) throw new DuplicateEntry("lançamento já existia no razão");
}

const byId = async (id: string) => (await db().select().from(payouts).where(eq(payouts.id, id)))[0];

/** Manda ao provedor e aplica o resultado. A chave de idempotência no provedor é o id do saque (reenvio seguro). */
async function submit(provider: PixProvider, p: PayoutRow, providerAccountId: string): Promise<void> {
  const r = await provider.createPayout({
    providerAccountId,
    amountCents: p.amountCents,
    pixKey: p.pixKey,
    pixKeyType: p.pixKeyType,
    idempotencyKey: p.id,
    description: p.description ?? undefined,
  });
  await db().update(payouts).set({ providerPayoutId: r.providerPayoutId }).where(eq(payouts.id, p.id));
  await applyPayoutResult(p.id, r);
}

export async function createPayout(
  merchantId: string,
  input: unknown,
  idempotencyKey: string,
): Promise<{ payout: PayoutRow; replayed: boolean }> {
  const data = parse(input);
  const requestHash = sha256Hex(JSON.stringify(data, Object.keys(data).sort()));
  const provider = getProvider(); // provedor mal configurado falha antes de debitar

  const res = await db().transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    // Replay antes da checagem de status: saque já feito volta igual mesmo se o lojista foi suspenso depois.
    const [existing] = await tx
      .select()
      .from(payouts)
      .where(and(eq(payouts.merchantId, merchantId), eq(payouts.idempotencyKey, idempotencyKey)));
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new PayoutError("idempotency_conflict", "Idempotency-Key já usada com outro conteúdo.");
      }
      return { payout: existing, replayed: true as const };
    }

    const [m] = await tx
      .select({
        status: merchants.status,
        providerAccountId: merchants.providerAccountId,
        feeOutBps: merchants.feeOutBps,
        feeOutFixedCents: merchants.feeOutFixedCents,
      })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    if (!m) throw new PayoutError("not_found", "Cliente não encontrado.");
    if (m.status !== "active" || !m.providerAccountId) {
      throw new PayoutError("merchant_inactive", "Conta não está ativa para saques.");
    }
    if (simulatedAccountOutsideSimulator(m.providerAccountId)) {
      throw new PayoutError("simulated_account", SIMULATED_ACCOUNT_MESSAGE);
    }

    const fee = computeFee(data.amount, m.feeOutBps, m.feeOutFixedCents);
    const { available } = await getBalance(merchantId, tx);
    if (available < data.amount + fee) {
      throw new PayoutError("insufficient_balance", "Saldo insuficiente para o saque e a tarifa.");
    }

    const [p] = await tx
      .insert(payouts)
      .values({
        merchantId,
        amountCents: data.amount,
        feeCents: fee,
        pixKey: data.pix_key,
        pixKeyType: data.pix_key_type,
        description: data.description,
        status: "processing",
        idempotencyKey,
        requestHash,
      })
      .returning();
    const ref = { merchantId, bucket: "available", refType: "payout", refId: p.id } as const;
    await post(tx, [
      { ...ref, kind: "cash_out", amountCents: -p.amountCents },
      { ...ref, kind: "fee_out", amountCents: -p.feeCents },
    ]);
    return { payout: p, replayed: false as const, providerAccountId: m.providerAccountId };
  });
  if (res.replayed) return res;

  try {
    await submit(provider, res.payout, res.providerAccountId);
  } catch (e) {
    // Rede/erro desconhecido: o dinheiro já está debitado e o saque fica processing; o cron reconsulta.
    logError("saque: provedor falhou, fica em processamento", e, { payout: res.payout.id });
  }
  return { payout: await byId(res.payout.id), replayed: false };
}

/** Só processing→completed e processing→failed; o resto é ignorado. failed estorna amount+fee uma única vez. */
export async function applyPayoutResult(payoutId: string, r: PayoutResult): Promise<void> {
  // Só "completed"/"failed" explícitos mexem em algo; status desconhecido nunca estorna dinheiro.
  if (r.status !== "completed" && r.status !== "failed") {
    if (r.status !== "processing") console.error(`saque ${payoutId}: status desconhecido do provedor, ignorado`);
    return;
  }
  try {
    await db().transaction(async (tx) => {
      const [cur] = await tx.select({ merchantId: payouts.merchantId }).from(payouts).where(eq(payouts.id, payoutId));
      if (!cur) return;
      await lockMerchant(tx, cur.merchantId);
      const [p] = await tx
        .update(payouts)
        .set(
          r.status === "completed"
            ? { status: "completed", endToEndId: r.endToEndId ?? null, completedAt: new Date() }
            : { status: "failed", failureCode: r.failureCode ?? null },
        )
        .where(and(eq(payouts.id, payoutId), eq(payouts.status, "processing")))
        .returning();
      if (!p) return;
      if (p.status === "failed") {
        await post(tx, [
          {
            merchantId: p.merchantId,
            amountCents: p.amountCents + p.feeCents,
            bucket: "available",
            kind: "cash_out_reversal",
            refType: "payout",
            refId: p.id,
          },
        ]);
      }
      await emit(tx, p.merchantId, p.status === "failed" ? "payout.failed" : "payout.completed", toPayoutJson(p));
    });
  } catch (e) {
    if (!(e instanceof DuplicateEntry)) throw e;
    console.error(`saque ${payoutId}: estorno já lançado no razão, resultado desfeito e ignorado`);
  }
}

export async function findPayoutIdByProviderId(providerPayoutId: string): Promise<string | null> {
  const [p] = await db()
    .select({ id: payouts.id })
    .from(payouts)
    .where(eq(payouts.providerPayoutId, providerPayoutId));
  return p?.id ?? null;
}

/** Saque de outro lojista (ou id inválido) → null. */
export async function getPayout(merchantId: string, id: string): Promise<PayoutRow | null> {
  if (!UUID.test(id)) return null;
  const [p] = await db()
    .select()
    .from(payouts)
    .where(and(eq(payouts.id, id), eq(payouts.merchantId, merchantId)));
  return p ?? null;
}

/**
 * Busca do painel: chave Pix nas formas em que o lojista digita (a gravada é a normalizada: CPF/CNPJ sem pontuação,
 * e-mail minúsculo, celular +55…) ou E2E exato. Igualdade, nunca LIKE: termo sem dígito não casa tudo. Vazio = sem filtro.
 */
function payoutSearch(q: string | undefined) {
  const term = q?.trim();
  if (!term) return undefined;
  const d = onlyDigits(term);
  const keys = [term, term.toLowerCase(), normalizeDocument(term), ...(d ? [`+55${d}`, `+${d}`] : [])];
  return or(inArray(payouts.pixKey, [...new Set(keys)]), eq(payouts.endToEndId, term));
}

/** Contagem por status no histórico inteiro (não só a página), com a mesma busca da lista. */
export async function countPayoutsByStatus(
  merchantId: string,
  q?: string,
): Promise<Record<PayoutRow["status"] | "all", number>> {
  const rows = await db()
    .select({ status: payouts.status, n: count() })
    .from(payouts)
    .where(and(eq(payouts.merchantId, merchantId), payoutSearch(q)))
    .groupBy(payouts.status);
  const out = { all: 0, processing: 0, completed: 0, failed: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.all += r.n;
  }
  return out;
}

/** Mais novos primeiro. `cursor` = id do último item da página anterior. `status` e `q` (chave/E2E) filtram. */
export async function listPayouts(
  merchantId: string,
  opts: { limit?: number; cursor?: string; status?: PayoutRow["status"]; q?: string } = {},
): Promise<{ data: PayoutRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), 100);
  if (opts.cursor !== undefined && !UUID.test(opts.cursor)) {
    throw new PayoutError("invalid_request", "Cursor inválido.");
  }
  // Compara (created_at, id) no banco: o cursor não carrega data, então não perde os microssegundos.
  const after = opts.cursor
    ? sql`(${payouts.createdAt}, ${payouts.id}) < (select p.created_at, p.id from payouts p where p.id = ${opts.cursor} and p.merchant_id = ${merchantId})`
    : undefined;
  const rows = await db()
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.merchantId, merchantId),
        opts.status ? eq(payouts.status, opts.status) : undefined,
        payoutSearch(opts.q),
        after,
      ),
    )
    .orderBy(desc(payouts.createdAt), desc(payouts.id))
    .limit(limit + 1);
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
}

/**
 * Um saque em processing: com id do provedor → getPayout; sem (a chamada original falhou) → reenvia com a mesma
 * chave de idempotência. Devolve o status depois. Saque já final: nada a fazer, nem auditoria. Cada consulta/reenvio
 * entra no audit_log (`payout.repoll`/`payout.resend`, autor null = cron): é a linha do tempo do saque no admin.
 */
export async function repollPayout(payoutId: string, actorUserId: string | null = null): Promise<PayoutRow["status"]> {
  const [r] = UUID.test(payoutId)
    ? await db()
        .select({ payout: payouts, providerAccountId: merchants.providerAccountId })
        .from(payouts)
        .innerJoin(merchants, eq(merchants.id, payouts.merchantId))
        .where(eq(payouts.id, payoutId))
    : [];
  if (!r) throw new PayoutError("not_found", "Saque não encontrado.");
  const { payout: p, providerAccountId } = r;
  if (p.status !== "processing") return p.status;
  const provider = getProvider();
  if (p.providerPayoutId) await applyPayoutResult(p.id, await provider.getPayout(p.providerPayoutId));
  else if (providerAccountId) await submit(provider, p, providerAccountId);
  else {
    console.error(`saque ${p.id}: lojista ${p.merchantId} sem conta no provedor, reenvio pulado`);
    return p.status;
  }
  const { status } = await byId(p.id);
  // ponytail: uma linha por consulta do cron enquanto o saque não fecha; agregar se a fila de presos crescer.
  await db().transaction((tx) =>
    writeAudit(tx, actorUserId, p.providerPayoutId ? "payout.repoll" : "payout.resend", {
      merchantId: p.merchantId,
      payoutId: p.id,
      status,
    }),
  );
  return status;
}

/** Cron: saques em processing há mais de `olderThanSec`, um a um por repollPayout. Devolve quantos chegaram a estado final. */
export async function pollProcessingPayouts(olderThanSec = 120): Promise<number> {
  getProvider(); // provedor mal configurado: o passo do cron falha inteiro, antes de olhar a fila
  // ponytail: 50 por rodada, em série; paralelizar se a fila crescer além do que o tick dá conta.
  const rows = await db()
    .select({ id: payouts.id })
    .from(payouts)
    .where(
      and(eq(payouts.status, "processing"), lt(payouts.createdAt, sql`now() - interval '1 second' * ${olderThanSec}`)),
    )
    .orderBy(asc(payouts.createdAt))
    .limit(50);
  let settled = 0;
  for (const { id } of rows) {
    try {
      if ((await repollPayout(id)) !== "processing") settled++;
    } catch (e) {
      logError("saque: consulta ao provedor falhou", e, { payout: id });
    }
  }
  return settled;
}

// ===========================================================================
// Saque parcelado (M-BATCH): lote persistido, divisão gulosa, retomada idempotente.
// Cada parcela é um payout avulso normal com idempotency_key = `${batchId}:${index}`
// (reusa o unique(merchant_id, idempotency_key) para impedir parcela dupla). A retomada
// vive no banco (payout_batches.failed_at_index), não na memória — o oposto da Cashyin.
// ===========================================================================

export type PayoutBatchErrorCode =
  | "invalid_request"
  | "idempotency_conflict"
  | "insufficient_balance"
  | "not_found"
  | "invalid_status";

export class PayoutBatchError extends Error {
  constructor(
    public readonly code: PayoutBatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PayoutBatchError";
  }
}

/** Teto por transferência (default R$ 15.000). O valor real depende do parceiro de Pix (marcar na UI). */
export const DEFAULT_PAYOUT_CEILING_CENTS = 1_500_000;

/**
 * Teto configurável por `PAYOUT_CEILING_CENTS` (centavos). Valor inválido (não inteiro, ≤ 0) cai no default;
 * limitado ao teto por saque avulso (5.000.000) para que toda parcela caiba no `createPayout`.
 */
export function payoutCeilingCents(): number {
  const raw = process.env.PAYOUT_CEILING_CENTS;
  if (raw === undefined) return DEFAULT_PAYOUT_CEILING_CENTS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_PAYOUT_CEILING_CENTS;
  return Math.min(n, 5_000_000);
}

/** Divisão gulosa: parcelas cheias do teto + o resto na última. Centavos inteiros, soma = total. Pura. */
export function splitGreedy(totalCents: number, ceilingCents: number): number[] {
  const full = Math.floor(totalCents / ceilingCents);
  const rest = totalCents - full * ceilingCents;
  const chunks = Array<number>(full).fill(ceilingCents);
  if (rest > 0) chunks.push(rest);
  return chunks;
}

/** Precisa parcelar? Só acima do teto (teto exato é saque avulso — regra §1.7). */
export function needsBatch(amountCents: number, ceilingCents: number): boolean {
  return amountCents > ceilingCents;
}

// O lote aceita um total maior que o teto do saque avulso; cada parcela (≤ teto) é validada pelo createPayout.
const batchPayoutSchema = z.strictObject({
  amount: z.int().min(100).max(100_000_000),
  pix_key: z.string().max(100),
  pix_key_type: z.enum(payouts.pixKeyType.enumValues),
  description: z.string().max(140).optional(),
});

function parseBatch(input: unknown): z.output<typeof batchPayoutSchema> {
  const data = parseOr(batchPayoutSchema, input, (msg) => new PayoutBatchError("invalid_request", msg));
  const problem = pixKeyProblem(data.pix_key_type, data.pix_key);
  if (problem) throw new PayoutBatchError("invalid_request", problem);
  return { ...data, pix_key: normalizeKey(data.pix_key_type, data.pix_key)! };
}

type BatchStatus = (typeof payoutBatches.$inferSelect)["status"];
type ChunkView = { index: number; amountCents: number; payoutId: string | null; status: PayoutRow["status"] | "pending" };
export type BatchResult = { batchId: string; status: BatchStatus; replayed: boolean; chunks: ChunkView[] };

/** Estado atual do lote lido do banco (um número só): parcelas planejadas sobrepostas pelos payouts persistidos. */
async function batchResult(batch: typeof payoutBatches.$inferSelect, replayed: boolean): Promise<BatchResult> {
  const rows = await db()
    .select({ id: payouts.id, batchIndex: payouts.batchIndex, amountCents: payouts.amountCents, status: payouts.status })
    .from(payouts)
    .where(eq(payouts.batchId, batch.id));
  const byIndex = new Map(rows.map((r) => [r.batchIndex, r]));
  const chunks: ChunkView[] = splitGreedy(batch.totalCents, batch.chunkCents).map((amountCents, index) => {
    const p = byIndex.get(index);
    return { index, amountCents: p?.amountCents ?? amountCents, payoutId: p?.id ?? null, status: p?.status ?? "pending" };
  });
  return { batchId: batch.id, status: batch.status, replayed, chunks };
}

/** Envia as parcelas em sequência a partir de `startIndex`. Para na 1ª que não concluir e persiste o ponto. */
async function runBatch(
  merchantId: string,
  batch: typeof payoutBatches.$inferSelect,
  data: z.output<typeof batchPayoutSchema>,
  chunks: number[],
  startIndex: number,
): Promise<BatchResult> {
  for (let i = startIndex; i < chunks.length; i++) {
    let status: PayoutRow["status"];
    try {
      // Parcela = saque avulso normal; reusa trava/idempotência/estorno. Replay (parcela já feita) não repaga.
      const { payout } = await createPayout(
        merchantId,
        { amount: chunks[i], pix_key: data.pix_key, pix_key_type: data.pix_key_type, description: data.description },
        `${batch.id}:${i}`,
      );
      status = payout.status;
      // createPayout não conhece batch_id/batch_index: carimba aqui, só enquanto nulo (idempotente na retomada).
      await db()
        .update(payouts)
        .set({ batchId: batch.id, batchIndex: i })
        .where(and(eq(payouts.id, payout.id), isNull(payouts.batchId)));
    } catch (e) {
      if (!(e instanceof PayoutError)) throw e; // erro inesperado sobe; PayoutError = parcela não criada (rollback)
      status = "failed";
    }
    if (status !== "completed") {
      await db()
        .update(payoutBatches)
        .set({ status: "partial", failedAtIndex: i })
        .where(eq(payoutBatches.id, batch.id));
      return batchResult({ ...batch, status: "partial", failedAtIndex: i }, false);
    }
  }
  await db()
    .update(payoutBatches)
    .set({ status: "completed", failedAtIndex: null })
    .where(eq(payoutBatches.id, batch.id));
  return batchResult({ ...batch, status: "completed", failedAtIndex: null }, false);
}

/**
 * Cria o lote e envia as parcelas. Idempotente por `(merchant_id, idempotency_key)`: replay devolve o lote existente.
 * Pré-checa o saldo do lote INTEIRO (total + soma das tarifas) sob lock antes de criar nada — sem isso as primeiras
 * parcelas debitariam e só a última falharia, deixando lote pela metade.
 */
export async function createBatchPayout(
  merchantId: string,
  input: unknown,
  idempotencyKey: string,
): Promise<BatchResult> {
  const data = parseBatch(input);
  const ceiling = payoutCeilingCents();
  if (!needsBatch(data.amount, ceiling)) {
    throw new PayoutBatchError("invalid_request", "Valor dentro do limite por transferência; use o saque avulso.");
  }
  const chunks = splitGreedy(data.amount, ceiling);
  const requestHash = sha256Hex(JSON.stringify(data, Object.keys(data).sort()));
  getProvider(); // provedor mal configurado falha antes de debitar

  const created = await db().transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    const [existing] = await tx
      .select()
      .from(payoutBatches)
      .where(and(eq(payoutBatches.merchantId, merchantId), eq(payoutBatches.idempotencyKey, idempotencyKey)));
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new PayoutBatchError("idempotency_conflict", "Idempotency-Key já usada com outro conteúdo.");
      }
      return { batch: existing, replayed: true as const };
    }
    const [m] = await tx
      .select({ feeOutBps: merchants.feeOutBps, feeOutFixedCents: merchants.feeOutFixedCents })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    if (!m) throw new PayoutBatchError("not_found", "Cliente não encontrado.");
    // A tarifa de cada parcela conta na pré-checagem (a Cashyin esquece a tarifa — §1.7).
    const sumFees = chunks.reduce((s, c) => s + computeFee(c, m.feeOutBps, m.feeOutFixedCents), 0);
    const { available } = await getBalance(merchantId, tx);
    if (available < data.amount + sumFees) {
      throw new PayoutBatchError("insufficient_balance", "Saldo insuficiente para o lote e as tarifas.");
    }
    const [b] = await tx
      .insert(payoutBatches)
      .values({
        merchantId,
        totalCents: data.amount,
        chunkCents: ceiling,
        count: chunks.length,
        pixKey: data.pix_key,
        pixKeyType: data.pix_key_type,
        description: data.description,
        status: "processing",
        idempotencyKey,
        requestHash,
      })
      .returning();
    return { batch: b, replayed: false as const };
  });

  if (created.replayed) return batchResult(created.batch, true);
  return runBatch(merchantId, created.batch, data, chunks, 0);
}

/**
 * Retoma um lote `partial` a partir de `failed_at_index`, só do próprio lojista. Reusa a MESMA chave por parcela
 * `${batchId}:${index}`: parcela já concluída → createPayout replay, NÃO paga de novo. Re-checa o saldo do restante.
 */
export async function resumeBatch(merchantId: string, batchId: string): Promise<BatchResult> {
  if (!UUID.test(batchId)) throw new PayoutBatchError("not_found", "Lote não encontrado.");
  const [b] = await db()
    .select()
    .from(payoutBatches)
    .where(and(eq(payoutBatches.id, batchId), eq(payoutBatches.merchantId, merchantId)));
  if (!b) throw new PayoutBatchError("not_found", "Lote não encontrado.");
  if (b.status !== "partial") throw new PayoutBatchError("invalid_status", "Só um lote parcial pode ser retomado.");
  getProvider();

  const chunks = splitGreedy(b.totalCents, b.chunkCents);
  const start = b.failedAtIndex ?? 0;

  // Re-checa o saldo do que ainda falta pagar (parcelas da falha em diante que ainda não concluíram), sob lock.
  await db().transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    const [m] = await tx
      .select({ feeOutBps: merchants.feeOutBps, feeOutFixedCents: merchants.feeOutFixedCents })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    if (!m) throw new PayoutBatchError("not_found", "Cliente não encontrado.");
    const done = new Set(
      (
        await tx
          .select({ batchIndex: payouts.batchIndex })
          .from(payouts)
          .where(and(eq(payouts.batchId, batchId), eq(payouts.status, "completed")))
      ).map((r) => r.batchIndex),
    );
    let need = 0;
    for (let i = start; i < chunks.length; i++) {
      if (!done.has(i)) need += chunks[i] + computeFee(chunks[i], m.feeOutBps, m.feeOutFixedCents);
    }
    const { available } = await getBalance(merchantId, tx);
    if (available < need) throw new PayoutBatchError("insufficient_balance", "Saldo insuficiente para retomar o lote.");
  });

  const data: z.output<typeof batchPayoutSchema> = {
    amount: b.totalCents,
    pix_key: b.pixKey,
    pix_key_type: b.pixKeyType,
    description: b.description ?? undefined,
  };
  return runBatch(merchantId, b, data, chunks, start);
}

/** Lote de outro lojista (ou id inválido) → null. */
export async function getBatch(merchantId: string, batchId: string): Promise<typeof payoutBatches.$inferSelect | null> {
  if (!UUID.test(batchId)) return null;
  const [b] = await db()
    .select()
    .from(payoutBatches)
    .where(and(eq(payoutBatches.id, batchId), eq(payoutBatches.merchantId, merchantId)));
  return b ?? null;
}

/** Parcelas do lote (payouts), em ordem de índice. Lote de outro lojista → vazio. */
export async function listBatchPayouts(merchantId: string, batchId: string): Promise<PayoutRow[]> {
  if (!UUID.test(batchId)) return [];
  return db()
    .select()
    .from(payouts)
    .where(and(eq(payouts.batchId, batchId), eq(payouts.merchantId, merchantId)))
    .orderBy(asc(payouts.batchIndex));
}
