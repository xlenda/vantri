import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyAction } from "@/app/painel/integracoes/actions";
import { encrypt } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { apiKeys, merchants, users } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Ações do painel com a sessão simulada (o guarda de verdade é testado em tests/auth.test.ts); o 2FA é o de
// verdade: segredo cifrado no banco e anti-replay por passo. redirect lança como o real.
const auth = vi.hoisted(() => ({ session: null as null | { user: { id: string }; merchant: { id: string } } }));
vi.mock("@/lib/auth/guards", () => ({
  requireUser: vi.fn(async (opts: { role: string }) => {
    if (!auth.session || opts.role !== "merchant") throw new Error("NEXT_REDIRECT /entrar");
    return auth.session;
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

const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
// Relógio fixo no meio de um passo de 30 s: códigos determinísticos (só o Date é falso).
const NOW = 1_800_000_015;
const codeAt = (stepsFromNow: number) => generate({ secret: TOTP_SECRET, epoch: NOW + stepsFromNow * 30 });

let d: Db;
let merchantId: string;
let userId: string;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  vi.stubEnv("PIX_PROVIDER", "simulator");
  d = await createTestDb();
  setDb(d);
  merchantId = await newMerchant(d, 1);
  const [m] = await d
    .update(merchants)
    .set({ status: "active", providerAccountId: "sim_acc_1" })
    .where(eq(merchants.id, merchantId))
    .returning();
  const [u] = await d
    .insert(users)
    .values({
      email: "loja@exemplo.com",
      passwordHash: "x",
      role: "merchant",
      merchantId,
      totpSecretEnc: encrypt(TOTP_SECRET),
      totpEnabled: true,
    })
    .returning();
  userId = u.id;
  auth.session = { user: u, merchant: m };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const form = (o: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
};
const lastStep = async () => (await d.select({ s: users.totpLastStep }).from(users).where(eq(users.id, userId)))[0].s;
const WRONG_CODE = "Código de verificação inválido ou já usado. Espere o próximo código no app e tente de novo.";

describe("criar chave de API (createKeyAction)", () => {
  const KEY = { name: "Loja principal", scopes: ["payouts:write", "balance:read"], ips: "" };
  const keys = () => d.select().from(apiKeys);

  it("sem código ou com código errado não cria chave; com o código certo cria uma vez", async () => {
    expect(await createKeyAction(undefined, form(KEY))).toMatchObject({
      error: "Digite o código de 6 dígitos do app autenticador.",
      values: { name: "Loja principal" },
    });
    const right = await codeAt(0);
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await createKeyAction(undefined, form({ ...KEY, code: wrong }))).toMatchObject({ error: WRONG_CODE });
    expect(await keys()).toHaveLength(0);

    const ok = await createKeyAction(undefined, form({ ...KEY, code: right }));
    expect(ok).toMatchObject({ name: "Loja principal", key: expect.stringMatching(/^vk_live_[0-9A-Za-z]{40}$/) });
    // Mesmo código de novo (replay): recusado, nenhuma chave a mais.
    expect(await createKeyAction(undefined, form({ ...KEY, code: right }))).toMatchObject({ error: WRONG_CODE });
    const rows = await keys();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ merchantId, scopes: ["payouts:write", "balance:read"] });
  });

  it("formato inválido (IP) é recusado antes do 2FA e não gasta o código", async () => {
    const code = await codeAt(0);
    expect(await createKeyAction(undefined, form({ ...KEY, ips: "1.2.3.999", code }))).toMatchObject({
      error: "Lista de IPs inválida: use até 20 endereços IPv4 ou IPv6.",
    });
    expect(await lastStep()).toBeNull();
    expect(await keys()).toHaveLength(0);

    expect(await createKeyAction(undefined, form({ ...KEY, ips: "203.0.113.10", code }))).toMatchObject({
      key: expect.stringMatching(/^vk_live_/),
    });
    expect((await keys())[0].ipAllowlist).toEqual(["203.0.113.10"]);
  });

  it("sem sessão de lojista nada é criado", async () => {
    auth.session = null;
    await expect(createKeyAction(undefined, form({ ...KEY, code: await codeAt(0) }))).rejects.toThrow("NEXT_REDIRECT");
    expect(await keys()).toHaveLength(0);
  });
});
