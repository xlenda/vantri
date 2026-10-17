import { and, eq } from "drizzle-orm";
import type { AdminRole } from "@/lib/auth/perms";
import { db } from "@/lib/db/client";
import { sessions, users } from "@/lib/db/schema";
import { writeAudit } from "./audit-util";
import { lastLogins, UserAdminError } from "./users-admin";

/** Contas da equipe (role admin), por e-mail. Admin antigo sem papel (null) aparece, para receber um. */
export async function listAdmins(): Promise<
  Array<{ id: string; email: string; adminRole: AdminRole | null; totpEnabled: boolean; lastLoginAt: Date | null }>
> {
  const last = lastLogins();
  return db()
    .select({
      id: users.id,
      email: users.email,
      adminRole: users.adminRole,
      totpEnabled: users.totpEnabled,
      lastLoginAt: last.at,
    })
    .from(users)
    .leftJoin(last, eq(last.userId, users.id))
    .where(eq(users.role, "admin"))
    .orderBy(users.email);
}

/**
 * Papel de um admin. Quem chama já passou por requireAdmin({ perm: "equipe:gerir" }) e pelo step-up.
 * O último admin não perde o papel: as linhas dos admins ficam travadas (FOR UPDATE) antes da contagem, então dois
 * rebaixamentos simultâneos não zeram a equipe. Mudou → as sessões do alvo caem (efeito imediato) e audita de → para.
 */
export async function setAdminRole(targetUserId: string, role: AdminRole, actorUserId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const admins = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.adminRole, "admin")))
      .for("update");
    const [t] = await tx
      .select({ adminRole: users.adminRole })
      .from(users)
      .where(and(eq(users.id, targetUserId), eq(users.role, "admin")));
    if (!t) throw new UserAdminError("not_found", "Usuário não encontrado.");
    if (t.adminRole === role) return;
    if (t.adminRole === "admin" && admins.length <= 1) {
      throw new UserAdminError(
        "last_admin",
        "Este é o último administrador: promova outra pessoa a administrador antes de mudar este papel.",
      );
    }
    await tx.update(users).set({ adminRole: role }).where(eq(users.id, targetUserId));
    await tx.delete(sessions).where(eq(sessions.userId, targetUserId));
    await writeAudit(tx, actorUserId, "role.set", { userId: targetUserId, from: t.adminRole, to: role });
  });
}
