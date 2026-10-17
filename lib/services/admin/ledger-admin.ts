import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { ledgerEntries, payouts } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { getBalance, lockMerchant, postEntries } from "@/lib/money/ledger";
import { emit } from "@/lib/services/events";
import { type PayoutRow, repollPayout, toPayoutJson } from "@/lib/services/payouts";
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

const PARTNER_SETTLED: Record<"completed" | "failed", string> = {
  completed: "O parceiro concluiu este saque: não há o que estornar. Recuse o pedido.",
  failed: "O parceiro recusou este saque e o estorno automático já devolveu o valor e a tarifa. Recuse o pedido.",
};

/**
 * Antes de aprovar o estorno manual de um saque em processamento que o parceiro conhece (tem id lá): pergunta a ele
 * (repollPayout, fora de transação). Concluído ou falho, vale o resultado dele e o manual para aqui. Ainda processando
 * ou sem resposta: recusa, porque estornar agora pagaria duas vezes se ele concluir depois (applyPayoutResult só mexe
 * em saque processing). Sem id no parceiro (o envio nunca foi confirmado), segue para o estorno.
 * ponytail: saque sem id no parceiro pode ter chegado lá (resposta perdida); fechar isso pede consultar o parceiro
 * pela chave de idempotência. E "não conheço este saque" do parceiro hoje é erro (recusa sempre): mapear para falha
 * definitiva quando houver o parceiro de Pix real (requer parceiro).
 */
export async function settleWithPartnerFirst(payoutId: string, actorUserId: string): Promise<void> {
  const [p] = await db()
    .select({ status: payouts.status, providerPayoutId: payouts.providerPayoutId })
    .from(payouts)
    .where(eq(payouts.id, payoutId));
  if (p?.status !== "processing" || !p.providerPayoutId) return;
  let status: PayoutRow["status"];
  try {
    status = await repollPayout(payoutId, actorUserId);
  } catch (e) {
    logError("quatro olhos: parceiro não confirmou o saque antes do estorno", e, { payout: payoutId });
    throw new ApprovalError("invalid_request", "Não foi possível confirmar o saque com o parceiro agora. Tente aprovar de novo em instantes.");
  }
  if (status === "processing") {
    throw new ApprovalError(
      "invalid_request",
      "O parceiro ainda está processando este saque: estornar agora pagaria duas vezes se ele concluir. Consulte de novo mais tarde.",
    );
  }
  throw new ApprovalError("invalid_request", PARTNER_SETTLED[status]);
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
  // Ganhou id no parceiro depois da consulta de settleWithPartnerFirst (um reenvio terminou no meio): agora só o
  // resultado dele vale; estornar aqui pagaria duas vezes se ele concluir.
  if (from === "processing" && p.providerPayoutId) {
    throw new ApprovalError("invalid_request", "O saque chegou ao parceiro depois do pedido: consulte o resultado dele antes de estornar.");
  }
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
