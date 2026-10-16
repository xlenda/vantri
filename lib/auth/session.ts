import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { checkTotpStep, newTotpSecret, totpUri } from "@/lib/auth/totp";
import { decrypt, encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { merchants, sessions, users } from "@/lib/db/schema";
import { rateLimit } from "@/lib/ratelimit";

// Lógica testável sem next/headers; os guardas em ./guards.ts só leem o cookie e chamam daqui.

export const SESSION_COOKIE = "vantri_session";
export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 43200,
} as const;

const MAX_FAILED_LOGINS = 5;

// Hash de comparação para e-mail inexistente: gasta o mesmo argon2 de um usuário real.
let dummyHash: Promise<string> | undefined;

export type LoginResult =
  | { ok: true; token: string; needsTotpSetup: boolean }
  | { ok: false; reason: "invalid" | "locked" | "rate_limited" | "pending" | "suspended" };

export async function login(email: string, password: string, ip: string): Promise<LoginResult> {
  if (!(await rateLimit(`login:ip:${ip}`, 20, 15 * 60)).ok) return { ok: false, reason: "rate_limited" };

  const [row] = await db()
    .select({ user: users, merchantStatus: merchants.status })
    .from(users)
    .leftJoin(merchants, eq(users.merchantId, merchants.id))
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!row) {
    await verifyPassword(await (dummyHash ??= hashPassword(randomToken())), password);
    return { ok: false, reason: "invalid" };
  }
  const { user, merchantStatus } = row;
  if (user.lockedUntil && user.lockedUntil > new Date()) return { ok: false, reason: "locked" };

  if (!(await verifyPassword(user.passwordHash, password))) {
    // Atômico: o SET lê a linha antiga, então tentativas simultâneas não se perdem.
    const reachesMax = sql`${users.failedLogins} + 1 >= ${MAX_FAILED_LOGINS}`;
    await db()
      .update(users)
      .set({
        failedLogins: sql`CASE WHEN ${reachesMax} THEN 0 ELSE ${users.failedLogins} + 1 END`,
        lockedUntil: sql`CASE WHEN ${reachesMax} THEN now() + interval '15 minutes' ELSE ${users.lockedUntil} END`,
      })
      .where(eq(users.id, user.id));
    return { ok: false, reason: "invalid" };
  }
  if (user.failedLogins > 0 || user.lockedUntil) {
    await db().update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
  }

  // Situação do lojista só é revelada a quem acertou a senha.
  if (user.role === "merchant") {
    if (merchantStatus === "suspended") return { ok: false, reason: "suspended" };
    if (merchantStatus !== "active") return { ok: false, reason: "pending" };
  }

  const token = randomToken(32);
  await db()
    .insert(sessions)
    .values({ id: sha256Hex(token), userId: user.id, expiresAt: new Date(Date.now() + cookieOptions.maxAge * 1000) });
  return { ok: true, token, needsTotpSetup: !user.totpEnabled };
}

/** Sessão válida pelo token do cookie. Nunca devolve hash de senha nem segredo TOTP. */
export async function resolveSession(token: string) {
  const [row] = await db()
    .select({
      user: {
        id: users.id,
        email: users.email,
        role: users.role,
        merchantId: users.merchantId,
        totpEnabled: users.totpEnabled,
        mustChangePassword: users.mustChangePassword,
      },
      session: sessions,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sha256Hex(token)), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

export type SessionInfo = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;

/**
 * Confere o código contra o segredo do usuário e consome o passo (RFC 6238 §5.2):
 * passo ≤ totp_last_step é recusado. O UPDATE condicional torna o consumo atômico.
 * `enabled` escolhe entre 2FA ativo (login, saque) e segredo recém-gerado (confirmação).
 */
async function consumeTotp(userId: string, code: string, enabled: boolean): Promise<boolean> {
  // Força bruta de 6 dígitos: limite por usuário, além do de IP no login.
  if (!(await rateLimit(`totp:${userId}`, 10, 15 * 60)).ok) return false;
  const [u] = await db()
    .select({ secretEnc: users.totpSecretEnc })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.totpEnabled, enabled)));
  if (!u?.secretEnc) return false;
  const step = await checkTotpStep(decrypt(u.secretEnc), code);
  if (step === null) return false;
  const updated = await db()
    .update(users)
    .set({ totpLastStep: step, totpEnabled: true })
    .where(
      and(
        eq(users.id, userId),
        eq(users.totpSecretEnc, u.secretEnc), // segredo não trocado no meio
        or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
      ),
    )
    .returning({ id: users.id });
  return updated.length === 1;
}

/** Para ações sensíveis (ex.: saque): exige 2FA ativo e código ainda não usado. */
export function verifyUserTotp(userId: string, code: string): Promise<boolean> {
  return consumeTotp(userId, code, true);
}

export async function passTotp(token: string, code: string): Promise<boolean> {
  const s = await resolveSession(token);
  if (!s || !(await verifyUserTotp(s.user.id, code))) return false;
  await db().update(sessions).set({ mfaPassed: true }).where(eq(sessions.id, s.session.id));
  return true;
}

export async function beginTotpSetup(userId: string): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  // Só sem 2FA ativo: trocar o segredo de quem já usa derrubaria o autenticador dele.
  const [u] = await db()
    .update(users)
    .set({ totpSecretEnc: encrypt(secret) })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, false)))
    .returning({ email: users.email });
  if (!u) throw new Error("2FA já está ativo para este usuário");
  return { secret, uri: totpUri(secret, u.email) };
}

export function confirmTotpSetup(userId: string, code: string): Promise<boolean> {
  return consumeTotp(userId, code, false);
}

export async function changePassword(userId: string, current: string, next: string): Promise<boolean> {
  const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u || !(await verifyPassword(u.hash, current))) return false;
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
    .where(eq(users.id, userId));
  return true;
}

export async function logout(token: string): Promise<void> {
  await db().delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}
