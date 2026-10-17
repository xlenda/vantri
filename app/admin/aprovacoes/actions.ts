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

const decideForm = z.strictObject({ id: z.uuid(), op: z.enum(["approve", "reject"]), reason: z.string().max(500) });

/** Aprovar (aplica o efeito na hora, numa transação só) ou recusar (com motivo; nada é aplicado). */
export async function decideApprovalAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "quatro_olhos:aprovar" });
  const input = decideForm.safeParse(formFields(fd, ["id", "op", "reason"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { id, op, reason } = input.data;
  if (op === "reject" && !reasonSchema.safeParse(reason).success) {
    return { error: "Escreva o motivo da recusa (de 3 a 500 caracteres)." };
  }
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return { error: totpProblem };
  try {
    if (op === "approve") await approve(id, user.id);
    else await reject(id, user.id, reason);
  } catch (e) {
    return fail(e, id);
  } finally {
    revalidatePath("/admin", "layout"); // saldo, taxa e status aparecem em várias telas do admin; a fila também
  }
  return op === "approve" ? { ok: "Pedido aprovado e aplicado." } : { ok: "Pedido recusado. Nada foi aplicado." };
}
