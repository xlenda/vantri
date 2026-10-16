import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { generate } from "otplib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/auth/guards";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  beginTotpSetup,
  changePassword,
  checkAccess,
  confirmTotpSetup,
  login,
  logout,
  passTotp,
  resolveSession,
  verifyUserTotp,
} from "@/lib/auth/session";
import { decrypt, encrypt, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { accessLogs, merchants, rateLimits, sessions, users } from "@/lib/db/schema";
import { rateLimit } from "@/lib/ratelimit";
import { verifyTurnstile } from "@/lib/turnstile";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Único ponto simulado: o cookie da requisição (fora do Next não existe requisição).
const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "vantri_session" && cookieJar.token ? { name, value: cookieJar.token } : undefined,
  }),
}));

const PASS = "senha-certa-123";
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
let d: Db;
let ipSeq = 0;
const ip = () => `10.0.0.${++ipSeq}`;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

async function newUser(
  email: string,
  opts: { role?: "admin" | "merchant"; merchantId?: string; totp?: boolean; mustChange?: boolean } = {},
): Promise<string> {
  const [u] = await d
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASS),
      role: opts.role ?? "admin",
      merchantId: opts.merchantId,
      totpSecretEnc: opts.totp ? encrypt(TOTP_SECRET) : null,
      totpEnabled: opts.totp ?? false,
      mustChangePassword: opts.mustChange ?? false,
    })
    .returning({ id: users.id });
  return u.id;
}

async function activeMerchant(n: number): Promise<string> {
  const id = await newMerchant(d, n);
  await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, id));
  return id;
}

async function loginToken(email: string): Promise<string> {
  const r = await login(email, PASS, ip());
  if (!r.ok) throw new Error(`login falhou: ${r.reason}`);
  return r.token;
}

/** Sessão que já passou pelo 2FA. */
async function mfaToken(email: string): Promise<string> {
  const token = await loginToken(email);
  await d.update(sessions).set({ mfaPassed: true }).where(eq(sessions.id, sha256Hex(token)));
  return token;
}

describe("login", () => {
  it("login locks after 5 wrong passwords", async () => {
    await newUser("a@x.com");
    const from = ip();
    for (let i = 0; i < 5; i++) {
      expect(await login("a@x.com", "errada", from)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await login("a@x.com", PASS, from)).toEqual({ ok: false, reason: "locked" });
    const [u] = await d.select().from(users).where(eq(users.email, "a@x.com"));
    const mins = (u.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(14);
    expect(mins).toBeLessThanOrEqual(15);
    expect(await d.select().from(sessions)).toHaveLength(0);
  });

  it("concurrent wrong passwords lock after at most 5", async () => {
    await newUser("cc@x.com");
    const from = ip();
    const results = await Promise.all(Array.from({ length: 8 }, () => login("cc@x.com", "errada", from)));
    const reasons = results.map((r) => (r.ok ? "ok" : r.reason));
    expect(reasons.filter((r) => r === "invalid").length).toBeLessThanOrEqual(5);
    expect(reasons.every((r) => r === "invalid" || r === "locked")).toBe(true);
    expect(reasons).toContain("locked");
    expect(await login("cc@x.com", PASS, from)).toEqual({ ok: false, reason: "locked" });
  });

  it("lock expires and counter restarts", async () => {
    await newUser("le@x.com");
    for (let i = 0; i < 5; i++) await login("le@x.com", "errada", ip());
    expect(await login("le@x.com", PASS, ip())).toEqual({ ok: false, reason: "locked" });

    // Tempo comparado no banco: vence o bloqueio pelo relógio do próprio Postgres.
    await d.update(users).set({ lockedUntil: sql`now() - interval '1 second'` }).where(eq(users.email, "le@x.com"));
    expect(await login("le@x.com", "errada", ip())).toEqual({ ok: false, reason: "invalid" });
    let [u] = await d.select().from(users).where(eq(users.email, "le@x.com"));
    expect(u.failedLogins).toBe(1); // recomeçou do zero
    expect((await login("le@x.com", PASS, ip())).ok).toBe(true);
    [u] = await d.select().from(users).where(eq(users.email, "le@x.com"));
    expect(u.failedLogins).toBe(0);
  });

  it("login writes an access log with the ip", async () => {
    const id = await newUser("al@x.com");
    const r = await login("al@x.com", PASS, "200.1.2.3");
    await login("al@x.com", "errada", "200.1.2.4");
    await login("fantasma@x.com", PASS, "200.1.2.5");
    const rows = await d.select().from(accessLogs).orderBy(accessLogs.ip);
    expect(rows.map(({ userId, ip, event }) => ({ userId, ip, event }))).toEqual([
      { userId: id, ip: "200.1.2.3", event: "login" },
      { userId: id, ip: "200.1.2.4", event: "login_failed" },
      { userId: null, ip: "200.1.2.5", event: "login_failed" },
    ]);
    expect(rows.every((row) => row.createdAt instanceof Date)).toBe(true);
    if (r.ok) await logout(r.token);
    expect(await d.select().from(accessLogs)).toHaveLength(3); // logout não apaga registro
  });

  it("4 wrong then right resets the counter", async () => {
    await newUser("b@x.com");
    for (let i = 0; i < 4; i++) await login("b@x.com", "errada", ip());
    expect((await login("b@x.com", PASS, ip())).ok).toBe(true);
    const [u] = await d.select().from(users).where(eq(users.email, "b@x.com"));
    expect(u.failedLogins).toBe(0);
    expect(u.lockedUntil).toBeNull();
  });

  it("login unknown email returns invalid", async () => {
    expect(await login("ninguem@x.com", PASS, ip())).toEqual({ ok: false, reason: "invalid" });
  });

  it("login pending merchant returns pending", async () => {
    const m = await newMerchant(d, 1); // nasce pending
    await newUser("loja@x.com", { role: "merchant", merchantId: m });
    expect(await login("loja@x.com", PASS, ip())).toEqual({ ok: false, reason: "pending" });
    await d.update(merchants).set({ status: "rejected" }).where(eq(merchants.id, m));
    expect(await login("loja@x.com", PASS, ip())).toEqual({ ok: false, reason: "pending" });
    await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, m));
    expect(await login("loja@x.com", PASS, ip())).toEqual({ ok: false, reason: "suspended" });
    expect(await d.select().from(sessions)).toHaveLength(0);
    await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, m));
    expect((await login("loja@x.com", PASS, ip())).ok).toBe(true);
  });

  it("session token stored only as hash", async () => {
    await newUser("c@x.com");
    const r = await login("  C@X.com ", PASS, ip()); // e-mail normalizado
    expect(r).toMatchObject({ ok: true, needsTotpSetup: true });
    if (!r.ok) throw new Error("login falhou");
    const rows = await d.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(r.token);
    expect(rows[0].id).toBe(sha256Hex(r.token));
    expect(rows[0].mfaPassed).toBe(false);
    const hours = (rows[0].expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);

    const s = await resolveSession(r.token);
    expect(s?.user.email).toBe("c@x.com");
    expect(s?.user).not.toHaveProperty("passwordHash");
    expect(await resolveSession(rows[0].id)).toBeNull(); // o hash não serve de token

    await logout(r.token);
    expect(await resolveSession(r.token)).toBeNull();
  });

  it("expired session does not resolve", async () => {
    await newUser("e@x.com");
    const token = await loginToken("e@x.com");
    await d.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await resolveSession(token)).toBeNull();
  });

  it("login is rate limited per IP (20 per 15 min)", async () => {
    const from = ip();
    for (let i = 0; i < 20; i++) {
      expect(await login("ninguem@x.com", "x", from)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await login("ninguem@x.com", "x", from)).toEqual({ ok: false, reason: "rate_limited" });
    expect((await login("ninguem@x.com", "x", ip())).ok).toBe(false); // outro IP segue
  });
});

describe("totp", () => {
  // Relógio fixo no meio de um passo de 30 s: códigos determinísticos.
  const NOW = 1_800_000_015;
  const codeAt = (stepsFromNow: number) => generate({ secret: TOTP_SECRET, epoch: NOW + stepsFromNow * 30 });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passTotp marks mfa_passed", async () => {
    await newUser("t@x.com", { totp: true });
    const token = await loginToken("t@x.com");
    expect(await passTotp(token, "000000")).toBe(false);
    expect((await resolveSession(token))?.session.mfaPassed).toBe(false);
    expect(await passTotp(token, await codeAt(0))).toBe(true);
    expect((await resolveSession(token))?.session.mfaPassed).toBe(true);
  });

  it("same TOTP code cannot be used twice", async () => {
    const id = await newUser("r@x.com", { totp: true });
    const code = await codeAt(0);
    const t1 = await loginToken("r@x.com");
    const t2 = await loginToken("r@x.com");
    expect(await passTotp(t1, code)).toBe(true);
    expect(await passTotp(t2, code)).toBe(false);
    expect(await verifyUserTotp(id, code)).toBe(false);
    expect(await verifyUserTotp(id, await codeAt(-1))).toBe(false); // passo anterior também
    expect(await verifyUserTotp(id, await codeAt(1))).toBe(true); // passo seguinte vale uma vez
    expect(await passTotp(t2, await codeAt(1))).toBe(false);
  });

  it("beginTotpSetup stores encrypted secret; confirmTotpSetup enables it", async () => {
    const id = await newUser("s@x.com");
    const { secret, uri } = await beginTotpSetup(id);
    expect(uri).toContain(`secret=${secret}`);
    let [u] = await d.select().from(users).where(eq(users.id, id));
    expect(u.totpSecretEnc).not.toContain(secret);
    expect(decrypt(u.totpSecretEnc!)).toBe(secret);
    expect(u.totpEnabled).toBe(false);

    const token = await loginToken("s@x.com");
    const code = await generate({ secret, epoch: NOW });
    expect(await passTotp(token, code)).toBe(false); // ainda não confirmado
    expect(await verifyUserTotp(id, code)).toBe(false);
    expect(await confirmTotpSetup(id, "000000", token)).toBe(false);
    expect(await confirmTotpSetup(id, code, token)).toBe(true);
    [u] = await d.select().from(users).where(eq(users.id, id));
    expect(u.totpEnabled).toBe(true);
    expect(await passTotp(token, code)).toBe(false); // mesmo código, mesmo passo
    await expect(beginTotpSetup(id)).rejects.toThrow(/2FA/); // ativo não é sobrescrito
  });

  it("confirmTotpSetup marks the session mfa_passed", async () => {
    const id = await newUser("m@x.com");
    await newUser("outro@x.com");
    const { secret } = await beginTotpSetup(id);
    const token = await loginToken("m@x.com");
    const other = await loginToken("m@x.com");
    const stranger = await loginToken("outro@x.com");
    const code = await generate({ secret, epoch: NOW });

    // Token de outro usuário não confirma nada (e não consome o código).
    expect(await confirmTotpSetup(id, code, stranger)).toBe(false);
    expect((await d.select().from(users).where(eq(users.id, id)))[0].totpEnabled).toBe(false);

    expect(await confirmTotpSetup(id, code, token)).toBe(true);
    expect((await resolveSession(token))?.session.mfaPassed).toBe(true);
    expect((await resolveSession(other))?.session.mfaPassed).toBe(false); // só a sessão atual
    expect((await resolveSession(stranger))?.session.mfaPassed).toBe(false);
  });

  it("2FA attempt limit counts only failed codes", async () => {
    // 10 erradas esgotam o limite: o código certo depois disso é recusado.
    const bad = await newUser("bf@x.com", { totp: true });
    expect(await Promise.all([-1, 0, 1].map(codeAt))).not.toContain("000000"); // pré-condição
    for (let i = 0; i < 10; i++) expect(await verifyUserTotp(bad, "000000")).toBe(false);
    expect(await verifyUserTotp(bad, await codeAt(0))).toBe(false);

    // 11 códigos certos em 11 passos seguidos (mesma janela do limite): todos valem.
    const good = await newUser("ok@x.com", { totp: true });
    for (let i = 0; i < 11; i++) {
      vi.setSystemTime((NOW + i * 30) * 1000);
      expect(await verifyUserTotp(good, await codeAt(i))).toBe(true);
    }
  });
});

it("rateLimit blocks 21st call in window", async () => {
  for (let i = 0; i < 20; i++) expect((await rateLimit("k", 20, 900)).ok).toBe(true);
  const blocked = await rateLimit("k", 20, 900);
  expect(blocked.ok).toBe(false);
  expect(blocked.retryAfterSec).toBeGreaterThan(0);
  expect(blocked.retryAfterSec).toBeLessThanOrEqual(900);
  expect((await rateLimit("outra", 20, 900)).ok).toBe(true);
  // Janela vencida: a contagem recomeça.
  await d.update(rateLimits).set({ windowStart: new Date(Date.now() - 901_000) }).where(eq(rateLimits.key, "k"));
  expect(await rateLimit("k", 20, 900)).toEqual({ ok: true, retryAfterSec: 0 });
  const [row] = await d.select().from(rateLimits).where(eq(rateLimits.key, "k"));
  expect(row.count).toBe(1);
});

it("changePassword rejects wrong current", async () => {
  const id = await newUser("p@x.com", { mustChange: true });
  const before = (await d.select().from(users).where(eq(users.id, id)))[0].passwordHash;
  const token = await mfaToken("p@x.com");
  expect(await changePassword(id, "errada", "nova-senha-456", token)).toBe(false);
  expect((await d.select().from(users).where(eq(users.id, id)))[0].passwordHash).toBe(before);

  expect(await changePassword(id, PASS, "nova-senha-456", token)).toBe(true);
  const [u] = await d.select().from(users).where(eq(users.id, id));
  expect(await verifyPassword(u.passwordHash, "nova-senha-456")).toBe(true);
  expect(u.mustChangePassword).toBe(false);
});

it("changePassword revokes other sessions", async () => {
  const id = await newUser("v@x.com");
  await newUser("w@x.com");
  const [t1, keep, t3] = [await loginToken("v@x.com"), await mfaToken("v@x.com"), await loginToken("v@x.com")];
  const someoneElse = await loginToken("w@x.com");

  expect(await changePassword(id, "errada", "nova-senha-456", keep)).toBe(false);
  expect(await d.select().from(sessions)).toHaveLength(4); // senha errada não derruba nada

  expect(await changePassword(id, PASS, "nova-senha-456", keep)).toBe(true);
  expect(await resolveSession(keep)).not.toBeNull();
  expect(await resolveSession(t1)).toBeNull();
  expect(await resolveSession(t3)).toBeNull();
  expect(await resolveSession(someoneElse)).not.toBeNull(); // só as do próprio usuário
});

it("changePassword refuses a session without mfa_passed", async () => {
  const id = await newUser("nm@x.com");
  await newUser("nm2@x.com");
  const before = (await d.select().from(users).where(eq(users.id, id)))[0].passwordHash;
  const noMfa = await loginToken("nm@x.com");
  const other = await loginToken("nm@x.com");
  const stranger = await mfaToken("nm2@x.com");

  expect(await changePassword(id, PASS, "nova-senha-456", noMfa)).toBe(false);
  expect(await changePassword(id, PASS, "nova-senha-456", stranger)).toBe(false); // sessão de outro usuário
  expect(await changePassword(id, PASS, "nova-senha-456", "token-inventado")).toBe(false);
  expect((await d.select().from(users).where(eq(users.id, id)))[0].passwordHash).toBe(before);
  expect(await resolveSession(other)).not.toBeNull(); // nada derrubado
});

it("merchant suspended after login is rejected on next request", async () => {
  const m = await activeMerchant(9);
  await newUser("z@x.com", { role: "merchant", merchantId: m, totp: true });
  const token = await loginToken("z@x.com");
  await d.update(sessions).set({ mfaPassed: true });
  expect(await checkAccess(token, "merchant")).toMatchObject({ kind: "ok", merchant: { id: m } });

  await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, m));
  expect(await checkAccess(token, "merchant")).toEqual({ kind: "redirect", to: "/entrar?motivo=suspenso" });
  expect(await resolveSession(token)).toBeNull(); // sessão apagada
  expect(await checkAccess(token, "merchant")).toEqual({ kind: "redirect", to: "/entrar" });
});

it("requireUser redirects in order and checks role", async () => {
  const digest = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: { digest?: string }) => e.digest ?? String(e),
    );
  const m = await activeMerchant(7);
  const id = await newUser("g@x.com", { role: "merchant", merchantId: m, mustChange: true });

  cookieJar.token = undefined;
  expect(await digest(requireUser({ role: "merchant" }))).toMatch(/^NEXT_REDIRECT;.*;\/entrar;/);

  cookieJar.token = await loginToken("g@x.com");
  expect(await digest(requireUser({ role: "merchant" }))).toMatch(/;\/conta\/2fa;/);

  await d.update(users).set({ totpEnabled: true, totpSecretEnc: encrypt(TOTP_SECRET) }).where(eq(users.id, id));
  expect(await digest(requireUser({ role: "merchant" }))).toMatch(/;\/entrar\/2fa;/);

  await d.update(sessions).set({ mfaPassed: true });
  expect(await digest(requireUser({ role: "merchant" }))).toMatch(/;\/conta\/senha;/);

  await d.update(users).set({ mustChangePassword: false }).where(eq(users.id, id));
  const r = await requireUser({ role: "merchant" });
  expect(r.user.id).toBe(id);
  expect(r.merchant?.id).toBe(m);
  expect(await digest(requireUser({ role: "admin" }))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
});

it("verifyTurnstile: no secret passes with one warning; secret without token fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const original = process.env.TURNSTILE_SECRET_KEY;
  try {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await verifyTurnstile(undefined, "1.1.1.1")).toBe(true);
    expect(await verifyTurnstile("x", "1.1.1.1")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    process.env.TURNSTILE_SECRET_KEY = "segredo";
    expect(await verifyTurnstile(undefined, "1.1.1.1")).toBe(false);
  } finally {
    if (original === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = original;
    warn.mockRestore();
  }
});
