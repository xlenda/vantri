import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { type Perm, pode } from "@/lib/auth/perms";
import { randomBase62 } from "@/lib/crypto";
import { type Db, db, type Tx } from "@/lib/db/client";
import { merchants, pendingApprovals, sessions, users } from "@/lib/db/schema";
import { type Fees, feesSchema, reactivateMerchant, updateFees } from "@/lib/services/merchants";
import { parseOr } from "@/lib/validation";
import { writeAudit } from "./audit-util";
import { activePlanFees, FeePlanError } from "./fee-plans";
import { adjustBalance, ApprovalError, reversePayoutManual, reversiblePayout, settleWithPartnerFirst } from "./ledger-admin";

export { ApprovalError, type ApprovalErrorCode } from "./ledger-admin";
export { feeChangeNeedsApproval } from "@/lib/services/merchants";

// Quatro olhos: dinheiro manual (ajuste de saldo, estorno de saque), taxa de cliente ativo, reativação de cliente e
// recuperação de acesso (senha + 2FA na mesma conta) viram pedido em pending_approvals; o efeito só acontece quando
// OUTRO admin, com quatro_olhos:aprovar, aprova. O papel é conferido aqui, no banco, para qualquer chamador; as actions
// conferem antes (requireAdmin) e pedem o código 2FA novo. Auditoria: ids, valores e o motivo (o porquê da trilha),
// nunca dado do pagador.

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

const REQUEST_PERM: Record<ApprovalKind, Perm> = {
  balance_adjustment: "dinheiro:mover",
  payout_reversal: "dinheiro:mover",
  fee_change: "taxas:editar",
  merchant_reactivate: "clientes:cadastro",
  account_recovery: "usuarios:operar",
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
  // planId: a troca veio de um plano (/admin/tarifas); o fee_history guarda de qual.
  fee_change: z.strictObject({ merchantId: z.uuid(), ...feesSchema.shape, planId: z.uuid().optional(), reason: reasonSchema }),
  merchant_reactivate: z.strictObject({ merchantId: z.uuid(), reason: reasonSchema }),
  account_recovery: z.strictObject({ userId: z.uuid(), reason: reasonSchema }),
};
const reversalPayload = z.strictObject({ payoutId: z.uuid() });
const recoveryPayload = z.strictObject({ userId: z.uuid() });

const invalid = () => new ApprovalError("invalid_request", "Pedido inválido: confira os campos.");
const parse = <T extends z.ZodType>(schema: T, input: unknown) => parseOr(schema, input, invalid);

/** Papel atual do usuário no banco (não o da sessão): rebaixado depois de entrar já não pode. Tx também é Db. */
async function hasPerm(d: Db, userId: string, perm: Perm): Promise<boolean> {
  const [u] = await d.select({ adminRole: users.adminRole }).from(users).where(eq(users.id, userId));
  return pode(u?.adminRole ?? null, perm);
}

async function assertPerm(d: Db, userId: string, perm: Perm): Promise<void> {
  if (!(await hasPerm(d, userId, perm))) throw new ApprovalError("forbidden", "Sem permissão para esta operação.");
}

async function planFees(tx: Tx, planId: string): Promise<Fees> {
  try {
    return await activePlanFees(planId, tx);
  } catch (e) {
    if (e instanceof FeePlanError) throw new ApprovalError("not_found", e.message);
    throw e;
  }
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
      const { merchantId, reason, planId, ...typed } = parse(INPUT.fee_change, input);
      await merchantStatus(tx, merchantId);
      // Troca de plano: as taxas são as do plano ativo, não as que vieram no pedido (o fee_history diz a verdade).
      const fees = planId ? await planFees(tx, planId) : typed;
      return { merchantId, reason, amountCents: null, payload: { ...fees, ...(planId && { planId }) } };
    }
    case "merchant_reactivate": {
      const { merchantId, reason } = parse(INPUT.merchant_reactivate, input);
      if ((await merchantStatus(tx, merchantId)) !== "suspended") {
        throw new ApprovalError("invalid_request", "Ação não permitida no status atual do cliente.");
      }
      return { merchantId, reason, amountCents: null, payload: {} };
    }
    case "account_recovery": {
      const { userId, reason } = parse(INPUT.account_recovery, input);
      const [t] = await tx.select({ role: users.role, merchantId: users.merchantId }).from(users).where(eq(users.id, userId));
      if (!t) throw new ApprovalError("not_found", "Usuário não encontrado.");
      // O pedido mora no cliente (merchant_id). Conta da equipe não tem pedido: uma etapa por vez, por quem gere a equipe.
      if (t.role !== "merchant" || !t.merchantId) {
        throw new ApprovalError("invalid_request", "Recuperação de acesso por pedido é só para conta de lojista.");
      }
      return { merchantId: t.merchantId, reason, amountCents: null, payload: { userId } };
    }
    default:
      throw invalid();
  }
}

/** Cria o pedido (nada muda ainda). Quem pede precisa da permissão do tipo (REQUEST_PERM). */
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

/**
 * Recuperação de acesso: senha temporária nova (hash calculado antes da transação), 2FA zerado, bloqueio tirado e
 * sessões derrubadas, na conta de lojista do pedido. É a única porta que faz senha e 2FA juntos na mesma conta.
 */
async function recoverAccess(tx: Tx, a: typeof pendingApprovals.$inferSelect, passwordHash: string, approver: string) {
  const { userId } = parse(recoveryPayload, a.payload);
  const [u] = await tx
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: true,
      totpEnabled: false,
      totpSecretEnc: null,
      totpLastStep: null,
      failedLogins: 0,
      lockedUntil: null,
    })
    .where(and(eq(users.id, userId), eq(users.role, "merchant"), eq(users.merchantId, a.merchantId)))
    .returning({ id: users.id });
  if (!u) throw new ApprovalError("not_found", "Usuário não encontrado.");
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  await writeAudit(tx, approver, "user.recover_access", { userId, merchantId: a.merchantId, approvalId: a.id });
  return userId;
}

/** Aplica o efeito na transação da aprovação. Devolve a referência do resultado (lançamento do ajuste, saque estornado). */
async function apply(
  tx: Tx,
  a: typeof pendingApprovals.$inferSelect,
  approver: string,
  passwordHash: string | undefined,
): Promise<string | null> {
  switch (a.kind) {
    case "balance_adjustment":
      if (a.amountCents === null) throw invalid();
      return adjustBalance(tx, a.merchantId, a.amountCents, a.reason, approver);
    case "payout_reversal": {
      const { payoutId } = parse(reversalPayload, a.payload);
      await reversePayoutManual(tx, payoutId, approver);
      return payoutId;
    }
    case "fee_change": {
      const { planId, ...fees } = a.payload as Fees & { planId?: string };
      // approved: só aqui a taxa de cliente ativo muda. updateFees valida as taxas de novo.
      await updateFees(a.merchantId, fees, approver, { tx, approved: true, ...(planId && { planId }) });
      return null;
    }
    case "merchant_reactivate":
      await reactivateMerchant(a.merchantId, approver, { tx });
      return null;
    case "account_recovery":
      if (!passwordHash) throw invalid();
      return recoverAccess(tx, a, passwordHash, approver);
  }
}

/**
 * Resultado da aprovação: a senha temporária da recuperação de acesso só existe aqui (o banco guarda o hash), com o
 * e-mail de acesso, que quem aprova precisa para entregar a senha à pessoa certa.
 */
export type ApproveResult = { tempPassword?: string; email?: string };

/**
 * Aprova e aplica, numa transação só: pedido travado e pendente, quem aprova não é quem pediu (self_approval), quem
 * pediu ainda tem a permissão do tipo, efeito, decisão e auditoria. Se o efeito for recusado (ex.: débito que
 * estouraria o saldo), nada muda e o pedido segue pendente. Repetir a aprovação dá already_decided.
 * Antes da transação (rede e argon2 não seguram a conexão nem a trava do lojista): o estorno de saque consulta o
 * parceiro (settleWithPartnerFirst) e a recuperação de acesso calcula a senha temporária.
 */
export async function approve(id: string, approver: string): Promise<ApproveResult> {
  await assertPerm(db(), approver, "quatro_olhos:aprovar");
  const [pre] = z.uuid().safeParse(id).success
    ? await db().select().from(pendingApprovals).where(eq(pendingApprovals.id, id))
    : [];
  const ready = pre?.status === "pending" && pre.requestedBy !== approver; // o resto a transação recusa abaixo
  if (ready && pre.kind === "payout_reversal") {
    await settleWithPartnerFirst(parse(reversalPayload, pre.payload).payoutId, approver);
  }
  const tempPassword = ready && pre.kind === "account_recovery" ? randomBase62(16) : undefined;
  const passwordHash = tempPassword && (await hashPassword(tempPassword));

  await db().transaction(async (tx) => {
    await assertPerm(tx, approver, "quatro_olhos:aprovar");
    const a = await lockPending(tx, id);
    if (a.requestedBy === approver) {
      throw new ApprovalError("self_approval", "Quem pediu não aprova o próprio pedido: outro administrador precisa aprovar.");
    }
    // Papel de quem pediu tirado ou rebaixado depois do pedido: o pedido não vale mais.
    if (!(await hasPerm(tx, a.requestedBy, REQUEST_PERM[a.kind]))) {
      throw new ApprovalError("invalid_request", "Quem pediu não tem mais permissão para este pedido. Recuse-o.");
    }
    const resultRefId = await apply(tx, a, approver, passwordHash);
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
  if (!tempPassword || !pre) return {};
  const [u] = await db()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, parse(recoveryPayload, pre.payload).userId));
  return { tempPassword, email: u?.email };
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
