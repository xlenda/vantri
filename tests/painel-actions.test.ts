import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChargeAction, simulatePaymentAction } from "@/app/painel/cobrancas/actions";
import { createKeyAction, deleteWebhookAction, resendDeliveryAction } from "@/app/painel/integracoes/actions";
import { createPayoutAction } from "@/app/painel/saques/actions";
import SaquesPage from "@/app/painel/saques/page";
import { brl } from "@/lib/br/money";
import { encrypt } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { apiKeys, charges, merchants, payouts, users, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { createCharge } from "@/lib/services/charges";
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
// `after` real só existe dentro de uma requisição do Next; aqui guarda a tarefa para o teste conferir.
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void afterTasks.push(task),
}));

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
  afterTasks.length = 0;
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
      error: "Lista de IPs inválida: até 20 endereços ou faixas CIDR (IPv4 a partir de /24, IPv6 de /64).",
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

describe("saque pelo painel (createPayoutAction)", () => {
  const PAYOUT = { idempotencyKey: "a".repeat(24), amount: "150,00", pixKeyType: "email", pixKey: "fornecedor@exemplo.com", description: "" };
  const all = () => d.select().from(payouts);

  beforeEach(async () => {
    await d.transaction((tx) =>
      postEntries(tx, [
        {
          merchantId,
          amountCents: 100_000,
          bucket: "available",
          kind: "adjustment",
          refType: "manual",
          refId: "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b",
        },
      ]),
    );
  });

  it("código errado não cria saque nem mexe no saldo", async () => {
    const right = await codeAt(0);
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await createPayoutAction(undefined, form({ ...PAYOUT, code: wrong }))).toMatchObject({
      error: WRONG_CODE,
      values: { amount: "150,00", pixKey: "fornecedor@exemplo.com" },
    });
    expect(await createPayoutAction(undefined, form(PAYOUT))).toMatchObject({
      error: "Digite o código de 6 dígitos do app autenticador.",
    });
    expect(await all()).toHaveLength(0);
    expect((await getBalance(merchantId)).available).toBe(100_000);
    expect(afterTasks).toHaveLength(0);
  });

  it("chave Pix inválida é recusada antes do 2FA e não gasta o código", async () => {
    const code = await codeAt(0);
    expect(await createPayoutAction(undefined, form({ ...PAYOUT, pixKeyType: "cpf", pixKey: "529.982.247-24", code }))).toMatchObject({
      error: "Chave Pix inválida para CPF. Confira e tente de novo.",
    });
    expect(await lastStep()).toBeNull();
    expect(await all()).toHaveLength(0);

    // O mesmo código continua valendo para o saque corrigido.
    await expect(createPayoutAction(undefined, form({ ...PAYOUT, code }))).rejects.toThrow(/^NEXT_REDIRECT \/painel\/saques\?feito=/);
    expect(await all()).toHaveLength(1);
  });

  it("mesma chave de idempotência: aviso de saque repetido e um saque só", async () => {
    await expect(createPayoutAction(undefined, form({ ...PAYOUT, code: await codeAt(0) }))).rejects.toThrow(
      /^NEXT_REDIRECT \/painel\/saques\?feito=[0-9a-f-]{36}$/,
    );
    const [p] = await all();
    // payout.completed do simulador já está na fila: o envio dos webhooks fica agendado para depois da resposta.
    expect(afterTasks).toHaveLength(1);
    expect(await afterTasks[0]()).toEqual({ delivered: 0, failed: 0 }); // é o dispatchDue (sem endpoint: nada a enviar)
    // Reenvio do mesmo formulário (código seguinte): volta o mesmo saque, com o aviso de repetido.
    await expect(createPayoutAction(undefined, form({ ...PAYOUT, code: await codeAt(1) }))).rejects.toThrow(
      `NEXT_REDIRECT /painel/saques?feito=${p.id}&repetido=1`,
    );
    expect(await all()).toHaveLength(1);
    expect(p).toMatchObject({ merchantId, amountCents: 15_000, feeCents: 100, status: "completed" });
    expect((await getBalance(merchantId)).available).toBe(100_000 - 15_000 - 100);

    // Mesma chave com outro valor: recusado com aviso, sem saque novo.
    expect(await createPayoutAction(undefined, form({ ...PAYOUT, amount: "200,00", code: await codeAt(-1) }))).toMatchObject({
      error: WRONG_CODE, // passo anterior ao já usado também não vale
    });
    await d.update(users).set({ totpLastStep: null }).where(eq(users.id, userId));
    expect(await createPayoutAction(undefined, form({ ...PAYOUT, amount: "200,00", code: await codeAt(0) }))).toMatchObject({
      error: "Este formulário já foi usado em outro saque. Recarregue a página para fazer um saque novo.",
    });
    expect(await all()).toHaveLength(1);
  });

  it("sem sessão de lojista nada é sacado", async () => {
    auth.session = null;
    await expect(createPayoutAction(undefined, form({ ...PAYOUT, code: await codeAt(0) }))).rejects.toThrow("NEXT_REDIRECT /entrar");
    expect(await all()).toHaveLength(0);
  });
});

describe("eventos fora do webhook do provedor: envio agendado na hora (after)", () => {
  it("simular pagamento", async () => {
    const { charge } = await createCharge(merchantId, { external_ref: "p1", amount: 14990 });
    const go = () => simulatePaymentAction(form({ id: charge.id }));
    await expect(go()).rejects.toThrow(`NEXT_REDIRECT /painel/cobrancas?id=${charge.id}`);
    expect((await d.select().from(charges))[0].status).toBe("paid");
    expect(afterTasks).toHaveLength(1);
    expect(await afterTasks[0]()).toEqual({ delivered: 0, failed: 0 });
    // Já paga: nada novo a enviar.
    await expect(go()).rejects.toThrow("NEXT_REDIRECT");
    expect(afterTasks).toHaveLength(1);
  });

  it("reenviar entrega", async () => {
    const [w] = await d
      .insert(webhookEndpoints)
      .values({ merchantId, url: "https://loja.example.com/h", secretEnc: "x", events: ["charge.paid"] })
      .returning();
    const [dl] = await d
      .insert(webhookDeliveries)
      .values({ endpointId: w.id, eventId: "evt_1", eventType: "charge.paid", payload: {}, status: "failed", attempts: 7 })
      .returning();
    await expect(resendDeliveryAction(form({ id: "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b" }))).rejects.toThrow(
      "NEXT_REDIRECT /painel/integracoes/entregas?erro=reenviar",
    );
    expect(afterTasks).toHaveLength(0);
    await expect(resendDeliveryAction(form({ id: dl.id }))).rejects.toThrow(
      `NEXT_REDIRECT /painel/integracoes/entregas/${dl.id}?ok=reenviada`,
    );
    expect((await d.select().from(webhookDeliveries))[0].status).toBe("pending");
    expect(afterTasks).toHaveLength(1);
  });
});

it("cobrança de conta de demonstração com o parceiro real ligado: recusada com a mensagem do serviço", async () => {
  vi.stubEnv("PIX_PROVIDER", "parceiro");
  expect(await createChargeAction(undefined, form({ amount: "149,90", description: "", expiresIn: "3600" }))).toMatchObject({
    error: expect.stringMatching(/^Esta conta é do ambiente de demonstração \(Pix simulado\)/),
  });
  expect(await d.select().from(charges)).toHaveLength(0);
});

it("saque concluído: no simulador o aviso diz que foi simulado", async () => {
  await d.transaction((tx) =>
    postEntries(tx, [{ merchantId, amountCents: 100_000, bucket: "available", kind: "adjustment", refType: "manual", refId: merchantId }]),
  );
  const fd = form({ idempotencyKey: "b".repeat(24), amount: "150,00", pixKeyType: "email", pixKey: "fornecedor@exemplo.com", description: "", code: await codeAt(0) });
  await expect(createPayoutAction(undefined, fd)).rejects.toThrow("NEXT_REDIRECT");
  const [p] = await d.select().from(payouts);
  const page = async () => renderToStaticMarkup(await SaquesPage({ searchParams: Promise.resolve({ feito: p.id }) }));

  expect(await page()).toContain(`Saque simulado de ${brl(15_000)} concluído para fornecedor@exemplo.com. Nenhum dinheiro de verdade foi enviado.`);
  vi.stubEnv("PIX_PROVIDER", "parceiro");
  const real = await page();
  expect(real).toContain(`Saque de ${brl(15_000)} enviado para fornecedor@exemplo.com.`);
  expect(real).not.toContain("simulado");
});

it("remover webhook pelo painel: só o próprio; aviso na URL", async () => {
  const [w] = await d
    .insert(webhookEndpoints)
    .values({ merchantId, url: "https://loja.example.com/h", secretEnc: "x", events: ["charge.paid"] })
    .returning();
  const outro = await newMerchant(d, 2);
  const [alheio] = await d
    .insert(webhookEndpoints)
    .values({ merchantId: outro, url: "https://outra.example.com/h", secretEnc: "x", events: ["charge.paid"] })
    .returning();
  await expect(deleteWebhookAction(form({ id: alheio.id }))).rejects.toThrow("NEXT_REDIRECT /painel/integracoes?aba=webhooks&erro=remover");
  await expect(deleteWebhookAction(form({ id: w.id }))).rejects.toThrow("NEXT_REDIRECT /painel/integracoes?aba=webhooks&ok=removido");
  expect((await d.select().from(webhookEndpoints)).map((e) => e.id)).toEqual([alheio.id]);
});
