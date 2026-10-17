import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { type Perm, pode } from "@/lib/auth/perms";
import { type Access, checkAccess, resolveSession, SESSION_COOKIE, type SessionInfo } from "@/lib/auth/session";

async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function getSession(): Promise<SessionInfo | null> {
  const token = await sessionToken();
  return token ? resolveSession(token) : null;
}

/**
 * Para páginas e ações do painel/admin; a decisão (e a ordem) está em checkAccess.
 * As próprias páginas /conta/2fa, /entrar/2fa e /conta/senha não podem chamar isto
 * (redirecionariam para si mesmas): usam getSession().
 */
export async function requireUser(opts: { role: "admin" | "merchant" }): Promise<Omit<Extract<Access, { kind: "ok" }>, "kind">> {
  const r = await checkAccess(await sessionToken(), opts.role);
  if (r.kind === "redirect") redirect(r.to);
  if (r.kind === "not_found") notFound();
  return { user: r.user, merchant: r.merchant };
}

/**
 * Guarda de toda página, Server Action e route handler do /admin: a porta grossa de admin
 * (sessão + 2FA + troca de senha + papel) MAIS a permissão do sub-papel. Controle de acesso é
 * sempre aqui, no servidor — esconder botão no front nunca basta. Sem a permissão: notFound().
 */
export async function requireAdmin(opts: { perm: Perm }): Promise<{ user: SessionInfo["user"] }> {
  const { user } = await requireUser({ role: "admin" });
  if (!pode(user.adminRole, opts.perm)) notFound();
  return { user };
}
