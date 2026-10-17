"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { freshTotpProblem } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { logError } from "@/lib/log";
import { ApprovalError, approve, reasonSchema, reject } from "@/lib/services/admin/approvals";
import { MerchantError } from "@/lib/services/merchants";
import { formFields } from "../format";

// Só quem aprova quatro olhos (papel admin): permissão no servidor e código 2FA novo, depois do formato dos campos.
// Quem pediu não aprova o próprio pedido: o serviço confere (self_approval), não o botão escondido na tela.

/** Erro do serviço → a mensagem dele (PT, sem dado interno); outro erro: genérica, com a causa só no log. */
function fail(e: unknown, approvalId: string): { error: string } {
  if (e instanceof ApprovalError) {
    if (e.code === "forbidden") notFound();
    return { error: e.message };
  }
  // Efeito recusado pelo serviço do cliente (ex.: já não está suspenso): a aprovação inteira foi desfeita.
  if (e instanceof MerchantError) return { error: e.message };
  logError("admin: falha ao decidir pedido de quatro olhos", e, { approval: approvalId });
  return { error: GENERIC_ERROR };
}

// approvalId, não "id": um campo "id" sobrescreve form.id no DOM e o React perde o "op" do botão clicado.
const decideForm = z.strictObject({ approvalId: z.uuid(), op: z.enum(["approve", "reject"]), reason: z.string().max(500) });

/** Aprovar (aplica o efeito na hora, numa transação só) ou recusar (com motivo; nada é aplicado). */
export async function decideApprovalAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "quatro_olhos:aprovar" });
  const input = decideForm.safeParse(formFields(fd, ["approvalId", "op", "reason"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { approvalId: id, op, reason } = input.data;
  if (op === "reject" && !reasonSchema.safeParse(reason).success) {
    return { error: "Escreva o motivo da recusa (de 3 a 500 caracteres)." };
  }
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return { error: totpProblem };
  // Saldo, taxa e status aparecem em várias telas do admin; a fila também.
  const refresh = () => revalidatePath("/admin", "layout");
  let result: { tempPassword?: string; email?: string } = {};
  try {
    if (op === "approve") result = await approve(id, user.id);
    else await reject(id, user.id, reason);
  } catch (e) {
    refresh();
    return fail(e, id);
  }
  if (result.tempPassword) {
    // Recuperação de acesso: a senha só existe nesta resposta (o banco guarda o hash). Sem revalidar: a fila
    // recarregada tiraria este cartão da tela, e a senha sumiria junto antes de alguém ler.
    return {
      ok: `Pedido aprovado e aplicado. E-mail de acesso: ${result.email ?? "—"}. Senha temporária (aparece só agora): ${result.tempPassword}. Passe à pessoa por um canal seguro, nunca pelo mesmo canal do pedido; no próximo acesso ela troca a senha e configura o 2FA.`,
    };
  }
  refresh();
  return op === "approve" ? { ok: "Pedido aprovado e aplicado." } : { ok: "Pedido recusado. Nada foi aplicado." };
}
