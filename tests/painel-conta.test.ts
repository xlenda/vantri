import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import TrocarTotpPage from "@/app/painel/conta/2fa/page";
import {
  confirmTotpRotationAction,
  reconfigureTotpAction,
  revokeOthersAction,
  revokeSessionAction,
} from "@/app/painel/conta/actions";
import ContaPage from "@/app/painel/conta/page";
import { TOTP_ROTATION_COOKIE } from "@/app/painel/conta/rotation";
import { hashPassword } from "@/lib/auth/password";
import { beginTotpSetup, pendingTotpSecret, verifyUserTotp } from "@/lib/auth/session";
import { encrypt, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { merchants, sessions, users } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Guarda de verdade (requireUser → checkAccess no banco) e 2FA de verdade; só os cookies da requisição são simulados
// (o de sessão e os que as actions gravam). redirect/notFound lançam como os reais.
const jar = vi.hoisted(() => ({
  token: undefined as string | undefined,
  extra: new Map<string, string>(),
  opts: undefined as unknown,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === "vantri_session") return jar.token ? { name, value: jar.token } : undefined;
      const value = jar.extra.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, opts: unknown) => {
      jar.extra.set(name, value);
      jar.opts = opts;
    },
    delete: (o: string | { name: string }) => {
      jar.extra.delete(typeof o === "string" ? o : o.name);
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const PASS = "senha-atual-da-loja";
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
// Relógio fixo no meio do passo de 30 s de agora: códigos determinísticos (só o Date é falso). Perto da hora real,
// o timer interno do PGlite não estoura (TimeoutOverflowWarning com o Date meses à frente).
const NOW = Math.floor(Date.now() / 30_000) * 30 + 15;
const codeAt = (stepsFromNow: number, secret = TOTP_SECRET) => generate({ secret, epoch: NOW + stepsFromNow * 30 });
const WRONG_CODE = "Código de verificação inválido ou já usado. Espere o próximo código no app e tente de novo.";
const CURRENT = "tok-atual";

let d: Db;
let userId: string;
let passwordHash: string;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  passwordHash = await hashPassword(PASS); // argon2 uma vez só
});

/** Sessão do usuário a partir de um token; devolve o id (sha256 do token). */
async function newSession(uid: string, token: string, mfaPassed = true): Promise<string> {
  await d.insert(sessions).values({ id: sha256Hex(token), userId: uid, mfaPassed, expiresAt: new Date(Date.now() + 12 * 3_600_000) });
  return sha256Hex(token);
}

async function newUser(n: number): Promise<string> {
  const merchantId = await newMerchant(d, n);
  await d
    .update(merchants)
    .set({ status: "active", documentEnc: encrypt("12345678000195") })
    .where(eq(merchants.id, merchantId));
  const [u] = await d
    .insert(users)
    .values({
      email: `loja${n}@exemplo.com`,
      passwordHash,
      role: "merchant",
      merchantId,
      totpSecretEnc: encrypt(TOTP_SECRET),
      totpEnabled: true,
    })
    .returning({ id: users.id });
  return u.id;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  d = await createTestDb();
  setDb(d);
  userId = await newUser(1);
  await newSession(userId, CURRENT);
  jar.token = CURRENT;
  jar.extra.clear();
  jar.opts = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.append(k, v);
  return fd;
};
const me = async () => (await d.select().from(users).where(eq(users.id, userId)))[0];
const sessionIds = async () => (await d.select({ id: sessions.id }).from(sessions)).map((s) => s.id).sort();

describe("reconfigurar 2FA (reconfigureTotpAction)", () => {
  it("sem senha ou sem código: recusado antes do 2FA, sem gastar o código", async () => {
    const code = await codeAt(0);
    expect(await reconfigureTotpAction(undefined, form({ code }))).toEqual({ error: "Digite a sua senha atual." });
    expect(await reconfigureTotpAction(undefined, form({ password: PASS }))).toEqual({
      error: "Digite o código de 6 dígitos do app autenticador.",
    });
    expect(await me()).toMatchObject({ totpEnabled: true, totpLastStep: null });
    expect(await verifyUserTotp(userId, code)).toBe(true); // o código continuou valendo
  });

  it("código já aceito em outra porta é recusado; senha errada gasta o código; nada muda sem os dois", async () => {
    const before = await me();
    const outra = await newSession(userId, "tok-celular");
    // Mesmo passo de 30 s: o código que valeu no saque/chave de API não vale para reconfigurar.
    const code = await codeAt(0);
    expect(await verifyUserTotp(userId, code)).toBe(true);
    expect(await reconfigureTotpAction(undefined, form({ password: PASS, code }))).toEqual({ error: WRONG_CODE });

    const next = await codeAt(1);
    expect(await reconfigureTotpAction(undefined, form({ password: "senha-errada-123", code: next }))).toEqual({
      error: "Senha atual incorreta. Espere o próximo código no app e tente de novo.",
    });
    expect(await verifyUserTotp(userId, next)).toBe(false); // gasto aqui, recusado em qualquer outra porta

    expect(await me()).toMatchObject({ totpEnabled: true, totpSecretEnc: before.totpSecretEnc });
    await expect(beginTotpSetup(userId)).rejects.toThrow(/2FA/); // segredo novo continua trancado
    expect(await sessionIds()).toContain(outra);
  });

  it("senha e código atuais: nada desliga; o QR novo fica pendente nesta sessão e só o código dele troca o segredo", async () => {
    const before = await me();
    const outra = await newSession(userId, "tok-celular");
    const alheio = await newUser(2);
    const sessaoAlheia = await newSession(alheio, "tok-de-outra-loja");
    const sid = sha256Hex(CURRENT);

    await expect(reconfigureTotpAction(undefined, form({ password: PASS, code: await codeAt(0) }))).rejects.toThrow(
      /^NEXT_REDIRECT \/painel\/conta\/2fa$/,
    );
    // Nenhum instante sem 2FA: mesmo segredo ligado, sessões intactas, e quem souber a senha não cadastra o próprio.
    expect(await me()).toMatchObject({ totpEnabled: true, totpSecretEnc: before.totpSecretEnc });
    expect(await sessionIds()).toContain(outra);
    await expect(beginTotpSetup(userId)).rejects.toThrow(/2FA/);
    // O segredo novo vai cifrado num cookie httpOnly só de /painel/conta, preso a este usuário e a esta sessão.
    const pending = jar.extra.get(TOTP_ROTATION_COOKIE);
    expect(jar.opts).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/painel/conta", maxAge: 600 });
    const secret = pendingTotpSecret(userId, sid, pending);
    if (!secret) throw new Error("segredo pendente ausente");
    expect(pending).not.toContain(secret);
    expect(pendingTotpSecret(userId, sha256Hex("tok-celular"), pending)).toBeNull(); // outra sessão
    expect(pendingTotpSecret(alheio, sid, pending)).toBeNull(); // outro usuário
    const [v, iv, tag, ct] = (pending ?? "").split(":");
    expect(pendingTotpSecret(userId, sid, `${v}:${iv}:${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}:${ct}`)).toBeNull(); // adulterado
    expect(renderToStaticMarkup(await TrocarTotpPage())).toContain(secret.slice(0, 4));

    // Código do app antigo não confirma o novo.
    expect(await confirmTotpRotationAction(undefined, form({ code: await codeAt(1) }))).toMatchObject({
      error: expect.stringMatching(/^Código inválido/),
    });
    expect((await me()).totpSecretEnc).toBe(before.totpSecretEnc);

    // Código do app novo: troca numa instrução só, apaga o cookie e encerra as outras sessões desta conta.
    await expect(confirmTotpRotationAction(undefined, form({ code: await codeAt(0, secret) }))).rejects.toThrow(
      /^NEXT_REDIRECT \/painel\/conta\?ok=2fa$/,
    );
    expect(await me()).toMatchObject({ totpEnabled: true });
    expect((await me()).totpSecretEnc).not.toBe(before.totpSecretEnc);
    expect(jar.extra.has(TOTP_ROTATION_COOKIE)).toBe(false);
    expect(await sessionIds()).toEqual([sid, sessaoAlheia].sort());
    expect(await verifyUserTotp(userId, await codeAt(1))).toBe(false); // o app antigo não vale mais
    expect(await verifyUserTotp(userId, await codeAt(1, secret))).toBe(true); // o novo vale
    expect(await verifyUserTotp(userId, await codeAt(0, secret))).toBe(false); // o código da confirmação não serve de novo
  });

  it("QR vencido (10 min) ou sem cookie: nada muda e a tela volta para Minha conta", async () => {
    const before = await me();
    await expect(reconfigureTotpAction(undefined, form({ password: PASS, code: await codeAt(0) }))).rejects.toThrow(
      "NEXT_REDIRECT /painel/conta/2fa",
    );
    const secret = pendingTotpSecret(userId, sha256Hex(CURRENT), jar.extra.get(TOTP_ROTATION_COOKIE));
    if (!secret) throw new Error("segredo pendente ausente");
    vi.setSystemTime((NOW + 601) * 1000);
    await expect(TrocarTotpPage()).rejects.toThrow("NEXT_REDIRECT /painel/conta?erro=2fa-expirado");
    expect(await confirmTotpRotationAction(undefined, form({ code: await generate({ secret, epoch: NOW + 601 }) }))).toMatchObject({
      error: expect.stringMatching(/^Código inválido/),
    });
    expect((await me()).totpSecretEnc).toBe(before.totpSecretEnc);
    jar.extra.clear();
    vi.setSystemTime(NOW * 1000);
    await expect(TrocarTotpPage()).rejects.toThrow("NEXT_REDIRECT /painel/conta?erro=2fa-expirado");
  });

  it("sem sessão nada muda", async () => {
    jar.token = undefined;
    await expect(reconfigureTotpAction(undefined, form({ password: PASS, code: await codeAt(0) }))).rejects.toThrow(
      "NEXT_REDIRECT /entrar",
    );
    expect((await me()).totpEnabled).toBe(true);
  });
});

describe("sessões abertas", () => {
  it("Encerrar: só sessão própria; id de outro usuário ou malformado não apaga nada", async () => {
    const minhaOutra = await newSession(userId, "tok-notebook");
    const sessaoAlheia = await newSession(await newUser(2), "tok-de-outra-loja");

    for (const id of [sessaoAlheia, "nao-e-sessao", sessaoAlheia.toUpperCase()]) {
      await expect(revokeSessionAction(form({ id }))).rejects.toThrow("NEXT_REDIRECT /painel/conta?erro=encerrar");
    }
    expect(await sessionIds()).toEqual([sha256Hex(CURRENT), minhaOutra, sessaoAlheia].sort());

    await expect(revokeSessionAction(form({ id: minhaOutra }))).rejects.toThrow("NEXT_REDIRECT /painel/conta?ok=encerrada");
    expect(await sessionIds()).toEqual([sha256Hex(CURRENT), sessaoAlheia].sort());
  });

  it("Encerrar as outras: fica só a atual (as de outros usuários continuam)", async () => {
    await newSession(userId, "tok-notebook");
    await newSession(userId, "tok-celular", false);
    const sessaoAlheia = await newSession(await newUser(2), "tok-de-outra-loja");
    await expect(revokeOthersAction()).rejects.toThrow("NEXT_REDIRECT /painel/conta?ok=outras");
    expect(await sessionIds()).toEqual([sha256Hex(CURRENT), sessaoAlheia].sort());
  });

  it("sem sessão nada é encerrado", async () => {
    const minhaOutra = await newSession(userId, "tok-notebook");
    jar.token = undefined;
    await expect(revokeSessionAction(form({ id: minhaOutra }))).rejects.toThrow("NEXT_REDIRECT /entrar");
    await expect(revokeOthersAction()).rejects.toThrow("NEXT_REDIRECT /entrar");
    expect(await sessionIds()).toContain(minhaOutra);
  });
});

describe("página Minha conta", () => {
  const page = async (sp: Record<string, string> = {}) =>
    renderToStaticMarkup(await ContaPage({ searchParams: Promise.resolve(sp) }));

  it("documento mascarado, parceiro, links e sessões sem token; Encerrar só nas outras", async () => {
    const notebook = await newSession(userId, "tok-notebook", false);
    const html = await page();

    expect(html).toContain("12.345.678/****-**");
    expect(html).not.toContain("12345678000195");
    expect(html).not.toContain("0001-95");
    expect(html).toContain("Loja 1 LTDA");
    expect(html).toContain("loja1@exemplo.com");
    expect(html).toContain("Banco Central do Brasil"); // aviso RC 16: quem opera as contas
    expect(html).toContain("requer parceiro de Pix"); // agência/conta: plano 2
    expect(html).toContain('href="/conta/senha"');

    expect(html).toContain("Esta sessão");
    expect(html).toContain("Não passou do 2FA"); // entrou com a senha e parou no código
    expect(html).toContain(`value="${notebook}"`); // botão Encerrar da outra sessão
    expect(html).not.toContain(`value="${sha256Hex(CURRENT)}"`); // a atual não tem Encerrar
    expect(html).toContain("Encerrar as outras");
    expect(html).not.toContain(CURRENT);
    expect(html).not.toContain("tok-notebook");
  });

  it("aviso do resultado vem da URL; chave desconhecida não vira aviso", async () => {
    expect(await page({ ok: "outras" })).toContain("Outras sessões encerradas.");
    expect(await page({ erro: "encerrar" })).toContain("Não foi possível encerrar a sessão.");
    expect(await page({ ok: "toString" })).not.toMatch(/role="(status|alert)"/);
    expect(await page()).not.toContain("Encerrar as outras"); // só a atual aberta
  });
});
