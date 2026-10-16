import { and, eq, gt, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { checkTotpStep, newTotpSecret, totpUri } from "@/lib/auth/totp";
import { decrypt, encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { accessLogs, merchants, sessions, users } from "@/lib/db/schema";
import { rateLimit, releaseRateLimit } from "@/lib/ratelimit";

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

type FailReason = Extract<LoginResult, { ok: false }>["reason"];

export async function login(email: string, password: string, ip: string): Promise<LoginResult> {
  // Barrado pelo limite de IP não grava registro: sob ataque seria uma linha por requisição.
  if (!(await rateLimit(`login:ip:${ip}`, 20, 15 * 60)).ok) return { ok: false, reason: "rate_limited" };
  const { result, userId } = await attemptLogin(email, password);
  await db().insert(accessLogs).values({ userId, ip, event: result.ok ? "login" : "login_failed" });
  return result;
}

async function attemptLogin(
  email: string,
  password: string,
): Promise<{ result: LoginResult; userId: string | null }> {
  const [row] = await db()
    .select({ user: users, merchantStatus: merchants.status })
    .from(users)
    .leftJoin(merchants, eq(users.merchantId, merchants.id))
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!row) {
    await verifyPassword(await (dummyHash ??= hashPassword(randomToken())), password);
    return { result: { ok: false, reason: "invalid" }, userId: null };
  }
  const { user, merchantStatus } = row;
  const fail = (reason: FailReason) => ({ result: { ok: false as const, reason }, userId: user.id });

  // Reserva a tentativa ANTES do argon2, num UPDATE condicional com a hora do banco: sob
  // concorrência no máximo MAX_FAILED_LOGINS passam; as demais já saem como bloqueadas.
  const [attempt] = await db()
    .update(users)
    .set({ failedLogins: sql`${users.failedLogins} + 1` })
    .where(
      and(
        eq(users.id, user.id),
        lt(users.failedLogins, MAX_FAILED_LOGINS),
        or(isNull(users.lockedUntil), lte(users.lockedUntil, sql`now()`)),
      ),
    )
    .returning({ failedLogins: users.failedLogins });
  if (!attempt) return fail("locked");

  if (!(await verifyPassword(user.passwordHash, password))) {
    if (attempt.failedLogins >= MAX_FAILED_LOGINS) {
      await db()
        .update(users)
        .set({ failedLogins: 0, lockedUntil: sql`now() + interval '15 minutes'` })
        .where(eq(users.id, user.id));
    }
    return fail("invalid");
  }
  await db().update(users).set({ failedLogins: 0 }).where(eq(users.id, user.id));

  // Situação do lojista só é revelada a quem acertou a senha.
  if (user.role === "merchant") {
    if (merchantStatus === "suspended") return fail("suspended");
    if (merchantStatus !== "active") return fail("pending");
  }

  const token = randomToken(32);
  await db()
    .insert(sessions)
    .values({ id: sha256Hex(token), userId: user.id, expiresAt: new Date(Date.now() + cookieOptions.maxAge * 1000) });
  return { result: { ok: true, token, needsTotpSetup: !user.totpEnabled }, userId: user.id };
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
  // Força bruta de 6 dígitos: cada tentativa reserva uma vaga do limite por usuário ANTES de
  // conferir (atômico sob concorrência); código aceito devolve a vaga, então só erro gasta o limite.
  const limitKey = `totp:${userId}`;
  if (!(await rateLimit(limitKey, 10, 15 * 60)).ok) return false;
  const ok = await matchTotp(userId, code, enabled);
  if (ok) await releaseRateLimit(limitKey);
  return ok;
}

async function matchTotp(userId: string, code: string, enabled: boolean): Promise<boolean> {
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
        eq(users.totpEnabled, enabled), // nada de religar por verificação concorrente
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

/** Confirma o segredo novo e já marca a sessão atual (`token`, do próprio usuário) como 2FA feito. */
export async function confirmTotpSetup(userId: string, code: string, token: string): Promise<boolean> {
  const s = await resolveSession(token);
  if (s?.user.id !== userId || !(await consumeTotp(userId, code, false))) return false;
  await db().update(sessions).set({ mfaPassed: true }).where(eq(sessions.id, s.session.id));
  return true;
}

/**
 * Troca a senha e derruba as outras sessões do usuário. `keepToken` tem de ser uma sessão
 * do próprio usuário que já passou pelo 2FA; senão nada muda.
 */
export async function changePassword(
  userId: string,
  current: string,
  next: string,
  keepToken: string,
): Promise<boolean> {
  const s = await resolveSession(keepToken);
  if (s?.user.id !== userId || !s.session.mfaPassed) return false;
  const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u || !(await verifyPassword(u.hash, current))) return false;
  const passwordHash = await hashPassword(next);
  await db().transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, userId));
    await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, s.session.id)));
  });
  return true;
}

type Merchant = typeof merchants.$inferSelect;
export type Access =
  | { kind: "ok"; user: SessionInfo["user"]; merchant?: Merchant }
  | { kind: "redirect"; to: string }
  | { kind: "not_found" };

/**
 * Decisão dos guardas, sem next/headers (requireUser em ./guards.ts só traduz o resultado).
 * Ordem: sessão → lojista ativo → 2FA configurado → 2FA desta sessão → troca de senha → papel.
 * Lojista que deixou de estar ativo perde a sessão na hora, em qualquer página.
 */
export async function checkAccess(token: string | undefined, role: "admin" | "merchant"): Promise<Access> {
  const s = token ? await resolveSession(token) : null;
  if (!s) return { kind: "redirect", to: "/entrar" };
  const { user, session } = s;

  let merchant: Merchant | undefined;
  if (user.role === "merchant") {
    [merchant] = user.merchantId
      ? await db().select().from(merchants).where(eq(merchants.id, user.merchantId))
      : [];
    if (merchant?.status !== "active") {
      await db().delete(sessions).where(eq(sessions.id, session.id));
      return { kind: "redirect", to: "/entrar?motivo=suspenso" };
    }
  }

  if (!user.totpEnabled) return { kind: "redirect", to: "/conta/2fa" };
  if (!session.mfaPassed) return { kind: "redirect", to: "/entrar/2fa" };
  if (user.mustChangePassword) return { kind: "redirect", to: "/conta/senha" };
  if (user.role !== role) return { kind: "not_found" };
  return { kind: "ok", user, merchant };
}

export async function logout(token: string): Promise<void> {
  await db().delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}
