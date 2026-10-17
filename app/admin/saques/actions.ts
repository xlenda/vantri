"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { freshTotpProblem } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { merchants, payouts } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { ApprovalError, reasonSchema, requestApproval } from "@/lib/services/admin/approvals";
import { PayoutError, type PayoutRow, repollPayout } from "@/lib/services/payouts";
import { formFields } from "../format";

// Operação de saque: permissão no servidor (o botão escondido não protege nada) e código 2FA novo em toda ação.
// Consultar/reenviar é direto (o parceiro decide; o estorno, se vier, é o automático). Marcar como falho e estornar
// move dinheiro à mão: vira pedido de quatro olhos e só acontece quando outro administrador aprovar.

function fail(e: unknown, payoutId: string): { error: string } {
  if (e instanceof ApprovalError) {
    if (e.code === "forbidden") notFound(); // o serviço barrou o papel: mesma resposta do requireAdmin
    return { error: e.message };
  }
  if (e instanceof PayoutError) return { error: e.message };
  logError("admin: falha ao operar saque", e, { payout: payoutId });
  return { error: GENERIC_ERROR };
}

const RESULT: Record<PayoutRow["status"], string> = {
  completed: "saque concluído.",
  failed: "saque falhou; valor e tarifa voltaram ao saldo do cliente.",
  processing: "o saque continua em processamento.",
};

/** "Consultar no parceiro agora" (com id no parceiro) ou "Reenviar ao parceiro" (sem id: mesma chave de idempotência). */
export async function repollPayoutAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "saques:operar" });
  const input = z.uuid().safeParse(formFields(fd, ["payoutId"]).payoutId);
  if (!input.success) return { error: "Pedido inválido." };
  const payoutId = input.data;
  const [p] = await db()
    .select({
      status: payouts.status,
      providerPayoutId: payouts.providerPayoutId,
      providerAccountId: merchants.providerAccountId,
    })
    .from(payouts)
    .innerJoin(merchants, eq(merchants.id, payouts.merchantId))
    .where(eq(payouts.id, payoutId));
  if (!p) return { error: "Saque não encontrado." };
  // Antes do código: o que não tem o que fazer não gasta o código 2FA.
  if (p.status !== "processing") return { error: "Este saque não está mais em processamento: não há o que consultar." };
  if (!p.providerPayoutId && !p.providerAccountId) {
    return { error: "O cliente não tem conta no parceiro: não há como reenviar este saque." };
  }
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return { error: totpProblem };
  let status: PayoutRow["status"];
  try {
    status = await repollPayout(payoutId, user.id);
  } catch (e) {
    return fail(e, payoutId);
  } finally {
    revalidatePath(`/admin/saques/${payoutId}`);
  }
  return { ok: `${p.providerPayoutId ? "Consultado no parceiro" : "Reenviado ao parceiro"}: ${RESULT[status]}` };
}

const reversalForm = z.strictObject({ payoutId: z.uuid(), reason: z.string().max(500) });

/** "Marcar como falho e estornar": só cria o pedido de quatro olhos (motivo + código 2FA). Nada muda aqui. */
export async function requestPayoutReversalAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "dinheiro:mover" });
  const input = reversalForm.safeParse(formFields(fd, ["payoutId", "reason"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { payoutId, reason } = input.data;
  if (!reasonSchema.safeParse(reason).success) return { error: "Escreva o motivo (de 3 a 500 caracteres)." };
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return { error: totpProblem };
  try {
    await requestApproval("payout_reversal", { payoutId, reason }, user.id);
  } catch (e) {
    return fail(e, payoutId);
  }
  revalidatePath("/admin/aprovacoes");
  revalidatePath(`/admin/saques/${payoutId}`);
  return {
    ok: "Pedido enviado. O saque só é marcado como falho e estornado quando outro administrador aprovar em Aprovações.",
  };
}
