import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRoleAction, userOpAction } from "@/app/admin/equipe/actions";
import EquipePage from "@/app/admin/equipe/page";
import { verifyPassword } from "@/lib/auth/password";
import type { AdminRole } from "@/lib/auth/perms";
import { encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { accessLogs, auditLog, merchants, sessions, users } from "@/lib/db/schema";
import { listAdmins, setAdminRole } from "@/lib/services/admin/roles";
import { listUsers, reset2fa } from "@/lib/services/admin/users-admin";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Guarda de verdade (requireAdmin: sessão + 2FA + papel + `pode`) e step-up de verdade (segredo cifrado no banco,
// anti-replay por passo). Só o cookie da requisição é simulado; notFound/redirect lançam como no Next.
const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vantri_session" && cookieJar.token ? { name, value: cookieJar.token } : undefined),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = 1_800_000_015; // meio de um passo de 30 s: códigos determinísticos (só o Date é falso)
const NOT_FOUND = /^NEXT_HTTP_ERROR_FALLBACK;404/;
const NO_CODE = { error: "Digite o código de 6 dígitos do app autenticador." };
const WRONG_CODE = { error: "Código de verificação inválido ou já usado. Espere o próximo código no app e tente de novo." };
const LAST_ADMIN = { error: "Este é o último administrador: promova outra pessoa a administrador antes de mudar este papel." };

let d: Db;
let seq = 0;
let step = 0;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  step = 0;
  cookieJar.token = undefined;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  d = await createTestDb();
  setDb(d);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Código novo do app autenticador: o relógio anda um passo (30 s) a cada chamada, então nunca repete. */
async function freshCode(): Promise<string> {
  step += 1;
  vi.setSystemTime((NOW + step * 30) * 1000);
  return generate({ secret: SECRET, epoch: NOW + step * 30 });
}

async function newUser(o: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await d
    .insert(users)
    .values({
      email: `u${++seq}@vantri.test`,
      passwordHash: "x",
      role: "admin",
      totpSecretEnc: encrypt(SECRET),
      totpEnabled: true,
      ...o,
    })
    .returning();
  return u;
}

/** Sessão que já passou pelo 2FA; devolve o token do cookie. */
async function newSession(userId: string): Promise<string> {
  const token = randomToken();
  await d
    .insert(sessions)
    .values({ id: sha256Hex(token), userId, mfaPassed: true, expiresAt: new Date(Date.now() + 3_600_000) });
  return token;
}

/** Entra (cookie) como um admin novo com o papel dado. */
async function loginAs(adminRole: AdminRole): Promise<string> {
  const u = await newUser({ adminRole });
  cookieJar.token = await newSession(u.id);
  return u.id;
}

/** Usuário de lojista ativo, com 2FA ligado (passo já usado) e duas sessões abertas. */
async function merchantUser() {
  const merchantId = await newMerchant(d, ++seq);
  await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, merchantId));
  const u = await newUser({ role: "merchant", merchantId, totpLastStep: 1 });
  await newSession(u.id);
  await newSession(u.id);
  return { id: u.id, merchantId };
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const row = async (id: string) => (await d.select().from(users).where(eq(users.id, id)))[0];
const sessionsOf = (id: string) => d.select().from(sessions).where(eq(sessions.userId, id));
const audits = () =>
  d
    .select({ actorUserId: auditLog.actorUserId, action: auditLog.action, meta: auditLog.meta })
    .from(auditLog)
    .orderBy(auditLog.action);
/** "ok" ou o digest do erro do Next (notFound/redirect). */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { digest?: string }) => e.digest ?? String(e),
  );

describe("operações de usuário", () => {
  it("suporte reseta o 2FA de um lojista: zera segredo e passo, derruba as sessões dele e audita com o autor", async () => {
    const sup = await loginAs("suporte");
    const m = await merchantUser();
    const other = await merchantUser();

    expect(await userOpAction(undefined, form({ userId: m.id, op: "reset2fa", code: await freshCode() }))).toEqual({
      ok: "2FA resetado e sessões encerradas. No próximo acesso a pessoa configura o app autenticador de novo.",
    });
    expect(await row(m.id)).toMatchObject({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null });
    expect(await sessionsOf(m.id)).toHaveLength(0);
    expect(await sessionsOf(other.id)).toHaveLength(2); // só as do alvo
    expect(await sessionsOf(sup)).toHaveLength(1); // a do autor continua
    expect(await audits()).toEqual([
      { actorUserId: sup, action: "user.reset_2fa", meta: { userId: m.id, merchantId: m.merchantId } },
    ]);
  });

  it("suporte e operador não mudam papel: equipe:gerir negado → notFound na action, nada muda", async () => {
    const target = await newUser({ adminRole: "operador" });
    for (const role of ["suporte", "operador"] as const) {
      await loginAs(role);
      expect(
        await outcome(setRoleAction(undefined, form({ userId: target.id, role: "admin", code: await freshCode() }))),
      ).toMatch(NOT_FOUND);
    }
    expect((await row(target.id)).adminRole).toBe("operador");
    expect(await audits()).toEqual([]);
  });

  it("conta da equipe só é operada por quem gere a equipe (senão um suporte trocaria senha e 2FA de um admin e entraria no lugar dele)", async () => {
    const boss = await newUser({ adminRole: "admin" });
    await newSession(boss.id);
    for (const role of ["suporte", "operador"] as const) {
      await loginAs(role);
      for (const op of ["reset2fa", "senha", "sessoes", "desbloquear"]) {
        expect(await outcome(userOpAction(undefined, form({ userId: boss.id, op, code: await freshCode() })))).toMatch(
          NOT_FOUND,
        );
      }
    }
    expect(await row(boss.id)).toMatchObject({ totpEnabled: true, passwordHash: "x", mustChangePassword: false });
    expect(await sessionsOf(boss.id)).toHaveLength(1);
    expect(await audits()).toEqual([]);

    // O serviço barra sozinho, para qualquer chamador.
    const sup = (await d.select().from(users).where(eq(users.adminRole, "suporte")))[0].id;
    await expect(reset2fa(boss.id, sup)).rejects.toMatchObject({ code: "forbidden" });

    // Um admin opera a conta de outro admin.
    const admin = await loginAs("admin");
    expect(await userOpAction(undefined, form({ userId: boss.id, op: "sessoes", code: await freshCode() }))).toEqual({
      ok: "Sessões encerradas. A pessoa precisa entrar de novo.",
    });
    expect(await sessionsOf(boss.id)).toHaveLength(0);
    expect(await audits()).toEqual([{ actorUserId: admin, action: "user.drop_sessions", meta: { userId: boss.id } }]);
  });

  it("forçar troca de senha devolve a senha temporária uma vez (ela verifica), marca a troca e derruba as sessões", async () => {
    const admin = await loginAs("admin");
    const m = await merchantUser();
    const s = await userOpAction(undefined, form({ userId: m.id, op: "senha", code: await freshCode() }));
    if (!s || !("tempPassword" in s) || !s.tempPassword) throw new Error(`esperava a senha, veio ${JSON.stringify(s)}`);
    expect(s.tempPassword).toMatch(/^[0-9A-Za-z]{16}$/);
    const u = await row(m.id);
    expect(await verifyPassword(u.passwordHash, s.tempPassword)).toBe(true);
    expect(u).toMatchObject({ mustChangePassword: true, totpEnabled: true }); // o 2FA não muda
    expect(await sessionsOf(m.id)).toHaveLength(0);
    const log = await audits();
    expect(log).toEqual([{ actorUserId: admin, action: "user.force_password", meta: { userId: m.id, merchantId: m.merchantId } }]);
    expect(JSON.stringify(log)).not.toContain(s.tempPassword);
  });

  it("derrubar sessões apaga todas as do alvo; desbloquear zera tentativas e bloqueio; ambos auditados", async () => {
    const op = await loginAs("operador");
    const m = await merchantUser();
    await d
      .update(users)
      .set({ failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) })
      .where(eq(users.id, m.id));

    expect(await userOpAction(undefined, form({ userId: m.id, op: "sessoes", code: await freshCode() }))).toMatchObject({
      ok: expect.any(String),
    });
    expect(await sessionsOf(m.id)).toHaveLength(0);
    expect(await userOpAction(undefined, form({ userId: m.id, op: "desbloquear", code: await freshCode() }))).toEqual({
      ok: "Acesso desbloqueado.",
    });
    expect(await row(m.id)).toMatchObject({ failedLogins: 0, lockedUntil: null, totpEnabled: true });
    const meta = { userId: m.id, merchantId: m.merchantId };
    expect(await audits()).toEqual([
      { actorUserId: op, action: "user.drop_sessions", meta },
      { actorUserId: op, action: "user.unlock", meta },
    ]);
  });

  it("toda ação sem step-up TOTP (ausente, errado ou repetido) é recusada e não muda nada", async () => {
    await loginAs("admin");
    const target = await newUser({ adminRole: "operador" });
    const m = await merchantUser();
    await d
      .update(users)
      .set({ failedLogins: 5, lockedUntil: new Date(Date.now() + 600_000) })
      .where(eq(users.id, m.id));
    const before = await row(m.id);

    const right = await freshCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (const op of ["reset2fa", "senha", "sessoes", "desbloquear"]) {
      expect(await userOpAction(undefined, form({ userId: m.id, op }))).toEqual(NO_CODE);
      expect(await userOpAction(undefined, form({ userId: m.id, op, code: wrong }))).toEqual(WRONG_CODE);
    }
    expect(await setRoleAction(undefined, form({ userId: target.id, role: "suporte" }))).toEqual(NO_CODE);
    expect(await setRoleAction(undefined, form({ userId: target.id, role: "suporte", code: wrong }))).toEqual(WRONG_CODE);
    expect(await row(m.id)).toEqual(before);
    expect(await sessionsOf(m.id)).toHaveLength(2);

    // O código certo vale uma vez: usado no papel, repetido na operação é recusado.
    expect(await setRoleAction(undefined, form({ userId: target.id, role: "suporte", code: right }))).toEqual({
      ok: "Papel salvo.",
    });
    expect(await userOpAction(undefined, form({ userId: m.id, op: "reset2fa", code: right }))).toEqual(WRONG_CODE);
    expect(await row(m.id)).toEqual(before);
    expect((await audits()).map((a) => a.action)).toEqual(["role.set"]);
  });

  it("pedido inválido não gasta o código; alvo inexistente dá erro em PT", async () => {
    await loginAs("admin");
    const code = await freshCode();
    expect(await userOpAction(undefined, form({ userId: "nao-e-uuid", op: "reset2fa", code }))).toEqual({
      error: "Pedido inválido.",
    });
    expect(await userOpAction(undefined, form({ userId: crypto.randomUUID(), op: "apagar", code }))).toEqual({
      error: "Pedido inválido.",
    });
    expect(await setRoleAction(undefined, form({ userId: crypto.randomUUID(), role: "dono", code }))).toEqual({
      error: "Pedido inválido.",
    });
    expect(await userOpAction(undefined, form({ userId: crypto.randomUUID(), op: "reset2fa", code }))).toEqual({
      error: "Usuário não encontrado.",
    });
    expect(await audits()).toEqual([]);
  });

  it("sem sessão de admin nenhuma ação roda", async () => {
    const m = await merchantUser();
    expect(await outcome(userOpAction(undefined, form({ userId: m.id, op: "reset2fa", code: await freshCode() })))).toMatch(
      /^NEXT_REDIRECT;.*;\/entrar;/,
    );
    expect((await row(m.id)).totpEnabled).toBe(true);
  });
});

describe("papéis", () => {
  it("o último admin não se rebaixa; com outro admin, mudar papel derruba as sessões do alvo e audita de → para", async () => {
    const me = await loginAs("admin");
    expect(await setRoleAction(undefined, form({ userId: me, role: "operador", code: await freshCode() }))).toEqual(
      LAST_ADMIN,
    );
    await expect(setAdminRole(me, "suporte", me)).rejects.toMatchObject({ code: "last_admin" });
    expect((await row(me)).adminRole).toBe("admin");
    expect(await audits()).toEqual([]);

    const other = await newUser({ adminRole: "operador" });
    await newSession(other.id);
    expect(await setRoleAction(undefined, form({ userId: other.id, role: "admin", code: await freshCode() }))).toEqual({
      ok: "Papel salvo.",
    });
    expect((await row(other.id)).adminRole).toBe("admin");
    expect(await sessionsOf(other.id)).toHaveLength(0); // mudança de acesso tem efeito imediato

    // Agora há outro admin: dá para se rebaixar (e a própria sessão cai também).
    expect(await setRoleAction(undefined, form({ userId: me, role: "suporte", code: await freshCode() }))).toEqual({
      ok: "Papel salvo.",
    });
    expect((await row(me)).adminRole).toBe("suporte");
    expect(await sessionsOf(me)).toHaveLength(0);
    const log = await audits();
    expect(log).toHaveLength(2);
    expect(log).toEqual(
      expect.arrayContaining([
        { actorUserId: me, action: "role.set", meta: { userId: other.id, from: "operador", to: "admin" } },
        { actorUserId: me, action: "role.set", meta: { userId: me, from: "admin", to: "suporte" } },
      ]),
    );
  });

  it("papel só vale para conta da equipe; o mesmo papel não mexe em nada", async () => {
    const me = await loginAs("admin");
    const m = await merchantUser();
    expect(await setRoleAction(undefined, form({ userId: m.id, role: "admin", code: await freshCode() }))).toEqual({
      error: "Usuário não encontrado.",
    });
    expect((await row(m.id)).adminRole).toBeNull();

    const sup = await newUser({ adminRole: "suporte" });
    await newSession(sup.id);
    await setAdminRole(sup.id, "suporte", me);
    expect(await sessionsOf(sup.id)).toHaveLength(1);
    expect(await audits()).toEqual([]);
  });
});

describe("listas", () => {
  const at = (s: string) => new Date(s);

  it("listUsers: admins e lojistas com lojista, último login, bloqueio e troca pendente; filtros, busca e páginas", async () => {
    const ana = await newUser({ email: "ana@vantri.test", adminRole: "suporte" });
    const m = await merchantUser();
    await d.update(merchants).set({ tradeName: "Padaria Pão Quente" }).where(eq(merchants.id, m.merchantId));
    const lock = new Date(Date.now() + 600_000);
    await d
      .update(users)
      .set({ email: "loja@exemplo.com", lockedUntil: lock, mustChangePassword: true })
      .where(eq(users.id, m.id));
    await newUser({ email: "zeca@exemplo.com", role: "merchant", merchantId: m.merchantId, totpEnabled: false });
    await d.insert(accessLogs).values([
      { userId: ana.id, ip: "1.1.1.1", event: "login", createdAt: at("2026-10-01T10:00:00Z") },
      { userId: ana.id, ip: "1.1.1.1", event: "login", createdAt: at("2026-10-02T10:00:00Z") },
      { userId: ana.id, ip: "1.1.1.1", event: "login_failed", createdAt: at("2026-10-03T10:00:00Z") },
      { userId: ana.id, ip: "1.1.1.1", event: "session_use", createdAt: at("2026-10-04T10:00:00Z") },
    ]);

    const all = await listUsers({ page: 1 });
    expect(all.hasNext).toBe(false);
    expect(all.rows.map((r) => r.email)).toEqual(["ana@vantri.test", "loja@exemplo.com", "zeca@exemplo.com"]);
    expect(all.rows[0]).toEqual({
      id: ana.id,
      email: "ana@vantri.test",
      role: "admin",
      adminRole: "suporte",
      merchantId: null,
      tradeName: null,
      totpEnabled: true,
      lastLoginAt: at("2026-10-02T10:00:00Z"), // só login de verdade conta
      lockedUntil: null,
      mustChangePassword: false,
    });
    expect(all.rows[1]).toMatchObject({
      role: "merchant",
      adminRole: null,
      merchantId: m.merchantId,
      tradeName: "Padaria Pão Quente",
      lastLoginAt: null,
      lockedUntil: lock,
      mustChangePassword: true,
    });

    const emails = async (f: Parameters<typeof listUsers>[0]) => (await listUsers(f)).rows.map((r) => r.email);
    expect(await emails({ page: 1, kind: "merchant" })).toEqual(["loja@exemplo.com", "zeca@exemplo.com"]);
    expect(await emails({ page: 1, kind: "admin" })).toEqual(["ana@vantri.test"]);
    expect(await emails({ page: 1, q: "ANA@" })).toEqual(["ana@vantri.test"]);
    expect(await emails({ page: 1, q: "pão quente" })).toEqual(["loja@exemplo.com", "zeca@exemplo.com"]);
    expect(await emails({ page: 1, q: "%" })).toEqual([]); // curinga do LIKE é texto, não "tudo"
    expect(await emails({ page: 1, q: "_" })).toEqual([]);

    const p1 = await listUsers({ page: 1 }, 2);
    expect([p1.rows.length, p1.hasNext]).toEqual([2, true]);
    const p2 = await listUsers({ page: 2 }, 2);
    expect([p2.rows.map((r) => r.email), p2.hasNext]).toEqual([["zeca@exemplo.com"], false]);
  });

  it("listAdmins: só contas da equipe (inclusive admin antigo sem papel), com 2FA e último login", async () => {
    const a = await newUser({ email: "bia@vantri.test", adminRole: "admin" });
    await newUser({ email: "antigo@vantri.test", adminRole: null, totpEnabled: false });
    await merchantUser();
    await d.insert(accessLogs).values({ userId: a.id, ip: "1.1.1.1", event: "login", createdAt: at("2026-10-05T12:00:00Z") });
    expect(await listAdmins()).toEqual([
      { id: expect.any(String), email: "antigo@vantri.test", adminRole: null, totpEnabled: false, lastLoginAt: null },
      { id: a.id, email: "bia@vantri.test", adminRole: "admin", totpEnabled: true, lastLoginAt: at("2026-10-05T12:00:00Z") },
    ]);
  });
});

describe("tela", () => {
  const page = async (sp: Record<string, string>) =>
    renderToStaticMarkup(await EquipePage({ searchParams: Promise.resolve(sp) }));

  it("admin: aba Administradores com o formulário de papel; aba Usuários com as operações e o aviso de identidade", async () => {
    const me = await loginAs("admin");
    const m = await merchantUser();
    let html = await page({ usuario: me });
    expect(html).toContain(">Administradores<");
    expect(html).toContain(">Usuários<");
    expect(html).toContain('name="role"');
    expect(html).toContain("Salvar papel");

    html = await page({ aba: "usuarios", usuario: m.id });
    expect(html).toContain("confirme a identidade fora do sistema antes");
    expect(html).toContain('value="reset2fa"');
    expect(html).toContain('value="senha"');
  });

  it("suporte: sem a aba Administradores (notFound se forçar) e sem operar conta da equipe", async () => {
    const admin = await newUser({ adminRole: "admin" });
    const m = await merchantUser();
    await loginAs("suporte");
    expect(await outcome(page({}))).toMatch(NOT_FOUND);

    let html = await page({ aba: "usuarios", usuario: admin.id });
    expect(html).not.toContain(">Administradores<");
    expect(html).not.toContain('value="reset2fa"');
    expect(html).toContain("Conta da equipe");

    html = await page({ aba: "usuarios", usuario: m.id });
    expect(html).toContain('value="reset2fa"');
  });
});
