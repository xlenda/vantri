import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { ledgerEntries, payouts } from "@/lib/db/schema";
import { getBalance, lockMerchant, postEntries } from "@/lib/money/ledger";
import { emit } from "@/lib/services/events";
import { toPayoutJson } from "@/lib/services/payouts";
import { writeAudit } from "./audit-util";

// Movimento manual de dinheiro. Só a aprovação de quatro olhos (approvals.approve) chama, dentro da transação dela;
// nenhuma action chama direto. Sempre postEntries com lockMerchant antes de ler saldo; lançamento existente nunca é
// editado nem apagado, só se lança o contrário.

export type ApprovalErrorCode = "invalid_request" | "not_found" | "self_approval" | "already_decided" | "forbidden";

/** Erro do quatro olhos e do dinheiro manual (reexportado por approvals.ts). Mensagem em PT, sem dado interno. */
export class ApprovalError extends Error {
  constructor(
    public readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * Crédito (+) ou débito (−) no disponível. Débito que deixaria o disponível negativo é recusado antes de lançar.
 * Devolve a chave do lançamento (refId), que a aprovação guarda em pending_approvals.result_ref_id.
 */
export async function adjustBalance(
  tx: Tx,
  merchantId: string,
  amountCents: number,
  reason: string,
  actorUserId: string,
): Promise<string> {
  // Dinheiro manual nunca se move sem um motivo escrito (ele fica no pedido e na auditoria do pedido).
  if (!Number.isInteger(amountCents) || amountCents === 0 || !reason.trim()) {
    throw new ApprovalError("invalid_request", "Ajuste inválido: valor diferente de zero e motivo são obrigatórios.");
  }
  await lockMerchant(tx, merchantId);
  if (amountCents < 0 && (await getBalance(merchantId, tx)).available + amountCents < 0) {
    throw new ApprovalError("invalid_request", "Saldo disponível insuficiente: o débito deixaria o saldo do cliente negativo.");
  }
  // Chave nova por ajuste: dois ajustes iguais nunca colidem no UNIQUE do razão (o segundo seria engolido calado).
  const refId = randomUUID();
  const posted = await postEntries(tx, [
    { merchantId, amountCents, bucket: "available", kind: "adjustment", refType: "manual", refId },
  ]);
  if (!posted) throw new Error("ajuste: a chave nova já existia no razão");
  await writeAudit(tx, actorUserId, "balance.adjust", { merchantId, amountCents, refId });
  return refId;
}

const notReversible = () =>
  new ApprovalError("invalid_request", "Só saque em processamento ou com falha, e ainda sem estorno, pode ser estornado.");

/** Conferência na hora do pedido (sem trava): o saque existe, não foi concluído e o razão ainda não tem o estorno dele. */
export async function reversiblePayout(tx: Tx, payoutId: string) {
  const [p] = await tx.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!p) throw new ApprovalError("not_found", "Saque não encontrado.");
  const [reversal] = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.merchantId, p.merchantId),
        eq(ledgerEntries.kind, "cash_out_reversal"),
        eq(ledgerEntries.refId, p.id),
      ),
    )
    .limit(1);
  if (p.status === "completed" || reversal) throw notReversible();
  return p;
}

/**
 * Saque em processamento que o parceiro não resolve (marca falho e avisa o lojista com payout.failed) ou com falha que
 * ficou sem estorno: devolve valor + tarifa ao disponível uma vez só. A chave é a do estorno automático
 * (cash_out_reversal, refId = saque), então o UNIQUE do razão recusa o segundo estorno, venha de onde vier.
 */
export async function reversePayoutManual(tx: Tx, payoutId: string, actorUserId: string): Promise<void> {
  const [cur] = await tx.select({ merchantId: payouts.merchantId }).from(payouts).where(eq(payouts.id, payoutId));
  if (!cur) throw new ApprovalError("not_found", "Saque não encontrado.");
  // applyPayoutResult trava o mesmo lojista: daqui ao commit, o status lido abaixo não muda por baixo.
  await lockMerchant(tx, cur.merchantId);
  let [p] = await tx.select().from(payouts).where(eq(payouts.id, payoutId));
  const from = p.status;
  if (from === "completed") throw notReversible();
  if (from === "processing") {
    [p] = await tx.update(payouts).set({ status: "failed" }).where(eq(payouts.id, payoutId)).returning();
    await emit(tx, p.merchantId, "payout.failed", toPayoutJson(p));
  }
  const amountCents = p.amountCents + p.feeCents;
  const posted = await postEntries(tx, [
    { merchantId: p.merchantId, amountCents, bucket: "available", kind: "cash_out_reversal", refType: "payout", refId: p.id },
  ]);
  // Já estornado: o erro desfaz a transação inteira (inclusive o "falho" e o aviso acima).
  if (!posted) throw notReversible();
  await writeAudit(tx, actorUserId, "payout.force_fail", { merchantId: p.merchantId, payoutId: p.id, amountCents, from });
}
