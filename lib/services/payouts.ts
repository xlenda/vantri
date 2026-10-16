import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { isValidCnpj, isValidCpf, normalizeDocument } from "@/lib/br/documents";
import { sha256Hex } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { merchants, payouts } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { computeFee } from "@/lib/money/fees";
import { getBalance, type LedgerEntry, lockMerchant, postEntries } from "@/lib/money/ledger";
import { getProvider } from "@/lib/provider";
import type { PixKeyType, PixProvider } from "@/lib/provider/types";
import { emit } from "@/lib/services/events";
import { parseOr } from "@/lib/validation";

export type PayoutRow = typeof payouts.$inferSelect;
type PayoutResult = { status: PayoutRow["status"]; failureCode?: string; endToEndId?: string };

export type PayoutErrorCode =
  | "invalid_request"
  | "idempotency_conflict"
  | "insufficient_balance"
  | "not_found"
  | "merchant_inactive";

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

function parse(input: unknown): z.output<typeof payoutSchema> {
  const data = parseOr(payoutSchema, input, (msg) => new PayoutError("invalid_request", msg));
  const pixKey = normalizeKey(data.pix_key_type, data.pix_key);
  if (!pixKey) throw new PayoutError("invalid_request", `Chave Pix inválida para o tipo ${data.pix_key_type}.`);
  return { ...data, pix_key: pixKey };
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

/** Mais novos primeiro. `cursor` = id do último item da página anterior. */
export async function listPayouts(
  merchantId: string,
  opts: { limit?: number; cursor?: string } = {},
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
    .where(and(eq(payouts.merchantId, merchantId), after))
    .orderBy(desc(payouts.createdAt), desc(payouts.id))
    .limit(limit + 1);
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
}

/**
 * Cron: saques em processing há mais de `olderThanSec`. Com id do provedor → getPayout; sem (a chamada original
 * falhou) → reenvia com a mesma chave de idempotência. Devolve quantos chegaram a estado final.
 */
export async function pollProcessingPayouts(olderThanSec = 120): Promise<number> {
  const provider = getProvider();
  // ponytail: 50 por rodada, em série; paralelizar se a fila crescer além do que o tick dá conta.
  const rows = await db()
    .select({ payout: payouts, providerAccountId: merchants.providerAccountId })
    .from(payouts)
    .innerJoin(merchants, eq(merchants.id, payouts.merchantId))
    .where(
      and(eq(payouts.status, "processing"), lt(payouts.createdAt, sql`now() - interval '1 second' * ${olderThanSec}`)),
    )
    .orderBy(asc(payouts.createdAt))
    .limit(50);
  let settled = 0;
  for (const { payout: p, providerAccountId } of rows) {
    try {
      if (p.providerPayoutId) await applyPayoutResult(p.id, await provider.getPayout(p.providerPayoutId));
      else if (providerAccountId) await submit(provider, p, providerAccountId);
      else {
        console.error(`saque ${p.id}: lojista ${p.merchantId} sem conta no provedor, reenvio pulado`);
        continue;
      }
      if ((await byId(p.id)).status !== "processing") settled++;
    } catch (e) {
      logError("saque: consulta ao provedor falhou", e, { payout: p.id });
    }
  }
  return settled;
}
