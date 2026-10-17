import { and, eq, ilike, max, or } from "drizzle-orm";
import { hashPassword } from "@/lib/auth/password";
import { type AdminRole, pode } from "@/lib/auth/perms";
import { randomBase62 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { accessLogs, merchants, sessions, users } from "@/lib/db/schema";
import { writeAudit } from "./audit-util";

// Operações de acesso na conta de alguém (admin ou lojista). Quem chama já passou por
// requireAdmin({ perm: "usuarios:operar" }) e pelo step-up TOTP; aqui ficam a regra da conta da equipe, o efeito
// e a auditoria, na mesma transação. Auditoria só com ids: nunca e-mail, nunca senha.

export class UserAdminError extends Error {
  constructor(
    public readonly code: "not_found" | "forbidden" | "last_admin",
    message: string,
  ) {
    super(message);
    this.name = "UserAdminError";
  }
}

/**
 * Último login de cada usuário (registros de acesso do Marco Civil), para LEFT JOIN.
 * ponytail: access_logs não tem índice por usuário; o agregado lê os logins a cada tela. Índice
 * (user_id, created_at) onde event = 'login' quando a tabela crescer.
 */
export function lastLogins() {
  return db()
    .select({ userId: accessLogs.userId, at: max(accessLogs.createdAt).as("last_login_at") })
    .from(accessLogs)
    .where(eq(accessLogs.event, "login"))
    .groupBy(accessLogs.userId)
    .as("last_login");
}

export type UserRow = {
  id: string;
  email: string;
  role: "admin" | "merchant";
  adminRole: AdminRole | null;
  merchantId: string | null;
  tradeName: string | null;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
};

/** Admins e lojistas, por e-mail. `q` procura no e-mail e no nome do lojista (curingas do LIKE viram texto). */
export async function listUsers(
  f: { q?: string; kind?: "admin" | "merchant"; page: number },
  limit = 25,
): Promise<{ rows: UserRow[]; hasNext: boolean }> {
  const last = lastLogins();
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, "\\$&")}%` : undefined;
  const rows = await db()
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      adminRole: users.adminRole,
      merchantId: users.merchantId,
      tradeName: merchants.tradeName,
      totpEnabled: users.totpEnabled,
      lastLoginAt: last.at,
      lockedUntil: users.lockedUntil,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .leftJoin(merchants, eq(merchants.id, users.merchantId))
    .leftJoin(last, eq(last.userId, users.id))
    .where(
      and(
        f.kind ? eq(users.role, f.kind) : undefined,
        like ? or(ilike(users.email, like), ilike(merchants.tradeName, like)) : undefined,
      ),
    )
    .orderBy(users.email)
    .limit(limit + 1)
    .offset((f.page - 1) * limit);
  return { rows: rows.slice(0, limit), hasNext: rows.length > limit };
}

type Patch = Partial<
  Pick<
    typeof users.$inferInsert,
    "totpEnabled" | "totpSecretEnc" | "totpLastStep" | "passwordHash" | "mustChangePassword" | "failedLogins" | "lockedUntil"
  >
>;

/**
 * Uma operação na conta: confere o alvo, aplica `patch`, derruba as sessões (se `drop`) e audita, numa transação.
 * Conta da equipe só com `equipe:gerir` do autor: sem isso, um suporte trocaria a senha e o 2FA de um admin e
 * entraria no lugar dele. A regra fica aqui para valer em qualquer chamador.
 */
async function operate(targetUserId: string, actorUserId: string, action: string, patch: Patch | null, drop: boolean) {
  await db().transaction(async (tx) => {
    const [t] = await tx
      .select({ role: users.role, merchantId: users.merchantId })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!t) throw new UserAdminError("not_found", "Usuário não encontrado.");
    if (t.role === "admin") {
      const [a] = await tx.select({ adminRole: users.adminRole }).from(users).where(eq(users.id, actorUserId));
      if (!pode(a?.adminRole ?? null, "equipe:gerir")) {
        throw new UserAdminError("forbidden", "Conta da equipe: só quem gere a equipe opera.");
      }
    }
    if (patch) await tx.update(users).set(patch).where(eq(users.id, targetUserId));
    if (drop) await tx.delete(sessions).where(eq(sessions.userId, targetUserId));
    await writeAudit(tx, actorUserId, action, { userId: targetUserId, ...(t.merchantId && { merchantId: t.merchantId }) });
  });
}

/** Desliga o 2FA (a pessoa configura de novo no próximo acesso) e derruba as sessões: quem tinha uma não reconfigura. */
export function reset2fa(targetUserId: string, actorUserId: string): Promise<void> {
  const patch = { totpEnabled: false, totpSecretEnc: null, totpLastStep: null };
  return operate(targetUserId, actorUserId, "user.reset_2fa", patch, true);
}

/** Senha temporária nova (troca obrigatória no próximo acesso). Ela só existe no retorno: o banco guarda o hash. */
export async function forcePasswordChange(targetUserId: string, actorUserId: string): Promise<{ tempPassword: string }> {
  const tempPassword = randomBase62(16);
  const passwordHash = await hashPassword(tempPassword); // argon2 fora da transação: não segura a conexão
  await operate(targetUserId, actorUserId, "user.force_password", { passwordHash, mustChangePassword: true }, true);
  return { tempPassword };
}

export function dropSessions(targetUserId: string, actorUserId: string): Promise<void> {
  return operate(targetUserId, actorUserId, "user.drop_sessions", null, true);
}

/** Tira o bloqueio de senhas erradas e zera a contagem. */
export function unlock(targetUserId: string, actorUserId: string): Promise<void> {
  return operate(targetUserId, actorUserId, "user.unlock", { failedLogins: 0, lockedUntil: null }, false);
}
