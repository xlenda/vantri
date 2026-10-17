"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { freshTotpProblem } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import type { AdminRole } from "@/lib/auth/perms";
import { logError } from "@/lib/log";
import { setAdminRole } from "@/lib/services/admin/roles";
import { dropSessions, forcePasswordChange, reset2fa, unlock, UserAdminError } from "@/lib/services/admin/users-admin";
import { formFields } from "../format";

// Toda ação aqui muda acesso: permissão no servidor (requireAdmin) e código 2FA novo (anti-replay), nessa ordem,
// depois do formato dos campos (pedido malformado não gasta o código).

const PAGE = "/admin/equipe";

/** Erro do serviço → mensagem em PT; a causa vai só para o log. Conta da equipe sem equipe:gerir → notFound(). */
function fail(e: unknown, context: string, userId: string): { error: string } {
  if (e instanceof UserAdminError) {
    if (e.code === "forbidden") notFound();
    return { error: e.message };
  }
  logError(context, e, { user: userId });
  return { error: GENERIC_ERROR };
}

const ROLES = ["admin", "operador", "suporte"] as const satisfies readonly AdminRole[];
const roleForm = z.strictObject({ userId: z.uuid(), role: z.enum(ROLES) });

/** Papel de um admin: só quem gere a equipe (papel admin). As sessões do alvo caem se o papel mudar. */
export async function setRoleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "equipe:gerir" });
  const input = roleForm.safeParse(formFields(fd, ["userId", "role"]));
  if (!input.success) return { error: "Pedido inválido." };
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return { error: totpProblem };
  try {
    await setAdminRole(input.data.userId, input.data.role, user.id);
  } catch (e) {
    return fail(e, "admin: falha ao mudar papel", input.data.userId);
  }
  revalidatePath(PAGE);
  return { ok: "Papel salvo." };
}

export type UserOpState = { error: string } | { ok: string; tempPassword?: string } | undefined;

const OPS = { reset2fa, sessoes: dropSessions, desbloquear: unlock };
const DONE = {
  reset2fa: "2FA resetado e sessões encerradas. No próximo acesso a pessoa configura o app autenticador de novo.",
  senha: "Senha temporária criada e sessões encerradas. A pessoa troca a senha no próximo acesso.",
  sessoes: "Sessões encerradas. A pessoa precisa entrar de novo.",
  desbloquear: "Acesso desbloqueado.",
};
const opForm = z.strictObject({ userId: z.uuid(), op: z.enum(["reset2fa", "senha", "sessoes", "desbloquear"]) });

/**
 * Reset de 2FA, troca de senha forçada, derrubar sessões, desbloquear. A senha temporária só existe nesta resposta
 * (o banco guarda o hash). Conta da equipe exige também equipe:gerir: o serviço confere e aqui vira notFound().
 */
export async function userOpAction(_prev: UserOpState, fd: FormData): Promise<UserOpState> {
  const { user } = await requireAdmin({ perm: "usuarios:operar" });
  const input = opForm.safeParse(formFields(fd, ["userId", "op"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { userId, op } = input.data;
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return { error: totpProblem };
  let tempPassword: string | undefined;
  try {
    if (op === "senha") ({ tempPassword } = await forcePasswordChange(userId, user.id));
    else await OPS[op](userId, user.id);
  } catch (e) {
    return fail(e, `admin: falha na operação de usuário (${op})`, userId);
  }
  revalidatePath(PAGE);
  return tempPassword ? { ok: DONE[op], tempPassword } : { ok: DONE[op] };
}
