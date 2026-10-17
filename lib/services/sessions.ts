import { and, eq, gt, ne } from "drizzle-orm";
import { sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";

// Sessões do próprio usuário: listar e revogar. O id da sessão é o sha256 do token (opaco);
// o token em si nunca é guardado nem devolvido. Toda escrita filtra por userId (IDOR-safe).
// ponytail: não há coluna de IP/user-agent em `sessions`; criada em/expira em/atual já resolve
// "derrubar sessão esquecida". Upgrade = colunas ip/ua se o lojista pedir.

export type SessionRow = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  mfaPassed: boolean;
  current: boolean;
};

/**
 * Sessões não expiradas do usuário, mais recentes primeiro. Marca a atual comparando
 * `sha256Hex(currentToken)` com `sessions.id`. Nunca devolve o token (só o hash-id opaco).
 */
export async function listSessions(userId: string, currentToken: string): Promise<SessionRow[]> {
  const currentId = sha256Hex(currentToken);
  const rows = await db()
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      mfaPassed: sessions.mfaPassed,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(sessions.createdAt);
  return rows.map((r) => ({ ...r, current: r.id === currentId })).reverse();
}

/** Apaga uma sessão do próprio usuário; id de outro usuário não apaga nada. Devolve se apagou. */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const deleted = await db()
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id });
  return deleted.length > 0;
}

/** "Encerrar as outras": apaga todas as sessões do usuário menos `keepSessionId`. Devolve quantas. */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const deleted = await db()
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
    .returning({ id: sessions.id });
  return deleted.length;
}
