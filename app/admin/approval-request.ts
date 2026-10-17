import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { freshTotpProblem } from "@/app/painel/lib";
import { logError } from "@/lib/log";
import { ApprovalError, type ApprovalKind, reasonSchema, requestApproval } from "@/lib/services/admin/approvals";

// Apoio das Server Actions do admin. Sem "use server" de propósito: exportar daqui não cria endpoint.

/**
 * Quatro olhos: motivo → código 2FA novo (anti-replay) → pedido. Nada muda aqui: o efeito só acontece quando outro
 * administrador aprovar em Aprovações. Motivo malformado não gasta o código. `ids` vão só para o log.
 */
export async function askApproval(
  userId: string,
  fd: FormData,
  kind: ApprovalKind,
  input: { reason: string } & Record<string, unknown>,
  done: string,
  ids: Record<string, string>,
): Promise<FormState> {
  if (!reasonSchema.safeParse(input.reason).success) return { error: "Escreva o motivo (de 3 a 500 caracteres)." };
  const totpProblem = await freshTotpProblem(userId, fd);
  if (totpProblem) return { error: totpProblem };
  try {
    await requestApproval(kind, input, userId);
  } catch (e) {
    if (e instanceof ApprovalError) {
      if (e.code === "forbidden") notFound(); // o serviço barrou o papel: mesma resposta do requireAdmin
      return { error: e.message };
    }
    logError(`admin: falha ao pedir aprovação (${kind})`, e, ids);
    return { error: GENERIC_ERROR };
  }
  revalidatePath("/admin/aprovacoes");
  return { ok: done };
}
