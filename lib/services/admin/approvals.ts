import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { type Perm, pode } from "@/lib/auth/perms";
import { db, type Tx } from "@/lib/db/client";
import { merchants, pendingApprovals, users } from "@/lib/db/schema";
import { type Fees, feesSchema, reactivateMerchant, updateFees } from "@/lib/services/merchants";
import { parseOr } from "@/lib/validation";
import { writeAudit } from "./audit-util";
import { adjustBalance, ApprovalError, reversePayoutManual, reversiblePayout } from "./ledger-admin";

export { ApprovalError, type ApprovalErrorCode } from "./ledger-admin";

// Quatro olhos: dinheiro manual (ajuste de saldo, estorno de saque), taxa de cliente ativo e reativação de cliente
// viram pedido em pending_approvals; o efeito só acontece quando OUTRO admin, com quatro_olhos:aprovar, aprova.
// O papel é conferido aqui, no banco, para qualquer chamador; as actions conferem antes (requireAdmin) e pedem o
// código 2FA novo. Auditoria: ids, valores e o motivo (o porquê da trilha), nunca dado do pagador.

export type ApprovalKind = (typeof pendingApprovals.kind.enumValues)[number];

/** Teto por ajuste manual: R$ 1.000.000,00 (o mesmo do saque em lote). Acima disso, mais de um pedido. */
export const MAX_ADJUSTMENT_CENTS = 100_000_000;

/** Motivo do pedido (e da recusa): uma linha, sem caractere de controle (o Postgres recusa NUL em text). */
export const reasonSchema = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .regex(/^\P{Cc}*$/u);

/** Os termos prometem aviso de 30 dias antes de mudar a tarifa de cliente ativo: cliente que está ou já esteve ativo. */
export const feeChangeNeedsApproval = (m: { status: string; approvedAt: Date | null }) =>
  m.status === "active" || m.approvedAt !== null;

const REQUEST_PERM: Record<ApprovalKind, Perm> = {
  balance_adjustment: "dinheiro:mover",
  payout_reversal: "dinheiro:mover",
  fee_change: "taxas:editar",
  merchant_reactivate: "clientes:cadastro",
};

// Lista branca do pedido, por tipo.
const INPUT = {
  balance_adjustment: z.strictObject({
    merchantId: z.uuid(),
    amountCents: z
      .int()
      .min(-MAX_ADJUSTMENT_CENTS)
      .max(MAX_ADJUSTMENT_CENTS)
      .refine((v) => v !== 0),
    reason: reasonSchema,
  }),
  payout_reversal: z.strictObject({ payoutId: z.uuid(), reason: reasonSchema }),
  fee_change: z.strictObject({ merchantId: z.uuid(), ...feesSchema.shape, reason: reasonSchema }),
  merchant_reactivate: z.strictObject({ merchantId: z.uuid(), reason: reasonSchema }),
};
const reversalPayload = z.strictObject({ payoutId: z.uuid() });

const invalid = () => new ApprovalError("invalid_request", "Pedido inválido: confira os campos.");
const parse = <T extends z.ZodType>(schema: T, input: unknown) => parseOr(schema, input, invalid);

async function assertPerm(tx: Tx, userId: string, perm: Perm): Promise<void> {
  const [u] = await tx.select({ adminRole: users.adminRole }).from(users).where(eq(users.id, userId));
  if (!pode(u?.adminRole ?? null, perm)) throw new ApprovalError("forbidden", "Sem permissão para esta operação.");
}

async function merchantStatus(tx: Tx, id: string) {
  const [m] = await tx.select({ status: merchants.status }).from(merchants).where(eq(merchants.id, id));
  if (!m) throw new ApprovalError("not_found", "Cliente não encontrado.");
  return m.status;
}

type Prepared = { merchantId: string; reason: string; amountCents: number | null; payload: Record<string, unknown> };

/** Valida o pedido do tipo e o estado atual (fail fast); a aprovação confere de novo, sob trava, ao aplicar. */
async function prepare(tx: Tx, kind: ApprovalKind, input: unknown): Promise<Prepared> {
  switch (kind) {
    case "balance_adjustment": {
      const { merchantId, amountCents, reason } = parse(INPUT.balance_adjustment, input);
      await merchantStatus(tx, merchantId);
      return { merchantId, reason, amountCents, payload: {} };
    }
    case "payout_reversal": {
      const { payoutId, reason } = parse(INPUT.payout_reversal, input);
      const p = await reversiblePayout(tx, payoutId);
      return { merchantId: p.merchantId, reason, amountCents: p.amountCents + p.feeCents, payload: { payoutId } };
    }
    case "fee_change": {
      const { merchantId, reason, ...fees } = parse(INPUT.fee_change, input);
      await merchantStatus(tx, merchantId);
      return { merchantId, reason, amountCents: null, payload: fees };
    }
    case "merchant_reactivate": {
      const { merchantId, reason } = parse(INPUT.merchant_reactivate, input);
      if ((await merchantStatus(tx, merchantId)) !== "suspended") {
        throw new ApprovalError("invalid_request", "Ação não permitida no status atual do cliente.");
      }
      return { merchantId, reason, amountCents: null, payload: {} };
    }
    default:
      throw invalid();
  }
}

/** Cria o pedido (nada muda ainda). Quem pede precisa da permissão do tipo: dinheiro:mover, taxas:editar ou clientes:cadastro. */
export async function requestApproval(kind: ApprovalKind, input: unknown, requestedBy: string): Promise<{ id: string }> {
  return db().transaction(async (tx) => {
    await assertPerm(tx, requestedBy, REQUEST_PERM[kind]);
    const p = await prepare(tx, kind, input);
    const [row] = await tx
      .insert(pendingApprovals)
      .values({ kind, requestedBy, ...p })
      .returning({ id: pendingApprovals.id });
    await writeAudit(tx, requestedBy, "approval.request", {
      approvalId: row.id,
      kind,
      merchantId: p.merchantId,
      ...(p.amountCents !== null && { amountCents: p.amountCents }),
      ...p.payload,
      reason: p.reason,
    });
    return row;
  });
}

/**
 * Pendentes, os mais antigos primeiro, com o e-mail de quem pediu, o nome do cliente e as taxas atuais dele (para a
 * tela mostrar "de → para" num pedido de taxa).
 * ponytail: sem paginação; quatro olhos é exceção, a fila é curta. Paginar se passar de algumas dezenas.
 */
export function listPendingApprovals() {
  return db()
    .select({
      id: pendingApprovals.id,
      kind: pendingApprovals.kind,
      merchantId: pendingApprovals.merchantId,
      payload: pendingApprovals.payload,
      reason: pendingApprovals.reason,
      amountCents: pendingApprovals.amountCents,
      requestedBy: pendingApprovals.requestedBy,
      createdAt: pendingApprovals.createdAt,
      requesterEmail: users.email,
      tradeName: merchants.tradeName,
      currentFees: {
        feeInBps: merchants.feeInBps,
        feeInFixedCents: merchants.feeInFixedCents,
        feeOutBps: merchants.feeOutBps,
        feeOutFixedCents: merchants.feeOutFixedCents,
      },
    })
    .from(pendingApprovals)
    .innerJoin(users, eq(users.id, pendingApprovals.requestedBy))
    .innerJoin(merchants, eq(merchants.id, pendingApprovals.merchantId))
    .where(eq(pendingApprovals.status, "pending"))
    .orderBy(asc(pendingApprovals.createdAt));
}

/** O pedido travado (FOR UPDATE) e ainda pendente: dois "aprovar" ao mesmo tempo, o segundo vê já decidido. */
async function lockPending(tx: Tx, id: string) {
  const [a] = z.uuid().safeParse(id).success
    ? await tx.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).for("update")
    : [];
  if (!a) throw new ApprovalError("not_found", "Pedido não encontrado.");
  if (a.status !== "pending") throw new ApprovalError("already_decided", "Este pedido já foi decidido.");
  return a;
}

/** Aplica o efeito na transação da aprovação. Devolve a referência do resultado (lançamento do ajuste, saque estornado). */
async function apply(tx: Tx, a: typeof pendingApprovals.$inferSelect, approver: string): Promise<string | null> {
  switch (a.kind) {
    case "balance_adjustment":
      if (a.amountCents === null) throw invalid();
      return adjustBalance(tx, a.merchantId, a.amountCents, a.reason, approver);
    case "payout_reversal": {
      const { payoutId } = parse(reversalPayload, a.payload);
      await reversePayoutManual(tx, payoutId, approver);
      return payoutId;
    }
    case "fee_change":
      await updateFees(a.merchantId, a.payload as Fees, approver, { tx }); // updateFees valida as taxas de novo
      return null;
    case "merchant_reactivate":
      await reactivateMerchant(a.merchantId, approver, { tx });
      return null;
  }
}

/**
 * Aprova e aplica, numa transação só: pedido travado e pendente, quem aprova não é quem pediu (self_approval), efeito,
 * decisão e auditoria. Se o efeito for recusado (ex.: débito que estouraria o saldo), nada muda e o pedido segue
 * pendente. Repetir a aprovação dá already_decided e não aplica de novo.
 */
export async function approve(id: string, approver: string): Promise<void> {
  await db().transaction(async (tx) => {
    await assertPerm(tx, approver, "quatro_olhos:aprovar");
    const a = await lockPending(tx, id);
    if (a.requestedBy === approver) {
      throw new ApprovalError("self_approval", "Quem pediu não aprova o próprio pedido: outro administrador precisa aprovar.");
    }
    const resultRefId = await apply(tx, a, approver);
    await tx
      .update(pendingApprovals)
      .set({ status: "approved", decidedBy: approver, decidedAt: new Date(), resultRefId })
      .where(eq(pendingApprovals.id, a.id));
    await writeAudit(tx, approver, "approval.approve", {
      approvalId: a.id,
      kind: a.kind,
      merchantId: a.merchantId,
      requestedBy: a.requestedBy,
      ...(resultRefId && { resultRefId }),
    });
  });
}

/** Recusa com motivo: nada é aplicado. Quem pediu pode recusar o próprio pedido (é cancelar; não move nada). */
export async function reject(id: string, approver: string, reason: string): Promise<void> {
  const why = parse(reasonSchema, reason);
  await db().transaction(async (tx) => {
    await assertPerm(tx, approver, "quatro_olhos:aprovar");
    const a = await lockPending(tx, id);
    await tx
      .update(pendingApprovals)
      .set({ status: "rejected", decidedBy: approver, decidedAt: new Date() })
      .where(eq(pendingApprovals.id, a.id));
    await writeAudit(tx, approver, "approval.reject", {
      approvalId: a.id,
      kind: a.kind,
      merchantId: a.merchantId,
      requestedBy: a.requestedBy,
      reason: why,
    });
  });
}
