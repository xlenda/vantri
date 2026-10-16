import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { resolveSession, SESSION_COOKIE, type SessionInfo } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";

export async function getSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? resolveSession(token) : null;
}

/**
 * Para páginas e ações do painel/admin. Ordem: sessão → 2FA configurado → 2FA desta sessão →
 * troca de senha obrigatória → papel. As próprias páginas /conta/2fa, /entrar/2fa e /conta/senha
 * não podem chamar isto (redirecionariam para si mesmas): usam getSession().
 */
export async function requireUser(opts: { role: "admin" | "merchant" }): Promise<{
  user: SessionInfo["user"];
  merchant?: typeof merchants.$inferSelect;
}> {
  const s = await getSession();
  if (!s) redirect("/entrar");
  const { user, session } = s;
  if (!user.totpEnabled) redirect("/conta/2fa");
  if (!session.mfaPassed) redirect("/entrar/2fa");
  if (user.mustChangePassword) redirect("/conta/senha");
  if (user.role !== opts.role) notFound();
  if (user.role === "admin") return { user };

  const [merchant] = user.merchantId
    ? await db().select().from(merchants).where(eq(merchants.id, user.merchantId))
    : [];
  if (!merchant) notFound();
  return { user, merchant };
}
