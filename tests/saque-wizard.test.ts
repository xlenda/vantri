import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBatchPayoutAction, createPayoutAction, previewPayoutAction, resumeBatchAction } from "@/app/painel/saques/actions";
import NovoSaquePage from "@/app/painel/saques/novo/page";
import SaquesPage from "@/app/painel/saques/page";
import { brl } from "@/lib/br/money";
import { encrypt } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { merchants, payoutBatches, payouts, users } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import { createBatchPayout } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Assistente de saque (Dados → Revisão → Verificação → Confirmação) e o lote parcelado. Mesmo arranjo de
// tests/painel-actions.test.ts: sessão simulada, 2FA de verdade (segredo cifrado, anti-replay por passo), redirect
// lança como o real. Teto de R$ 150,00 para lotes pequenos: R$ 400,00 → 150 + 150 + 100, tarifa R$ 1,00 por parcela.
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
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void afterTasks.push(task),
}));

const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = 1_800_000_015; // meio de um passo de 30 s
const codeAt = (stepsFromNow: number) => generate({ secret: TOTP_SECRET, epoch: NOW + stepsFromNow * 30 });
const WRONG_CODE = "Código de verificação inválido ou já usado. Espere o próximo código no app e tente de novo.";
const SAME_FORM = "Este formulário já foi usado em outro saque. Recarregue a página para fazer um saque novo.";
const STUCK =
  "falhou com a chave Pix informada e não pode ser tentada de novo automaticamente; abra um novo saque para o valor restante.";

let d: Db;
let merchantId: string;
let userId: string;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  afterTasks.length = 0;
  cache.revalidatePath.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  vi.stubEnv("PIX_PROVIDER", "simulator");
  vi.stubEnv("PAYOUT_CEILING_CENTS", "15000");
  d = await createTestDb();
  setDb(d);
  merchantId = await activeMerchant(1);
  const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Lojista ativo (tarifa padrão de saque: R$ 1,00 fixo) com R$ 1.000,00 disponíveis. */
async function activeMerchant(n: number): Promise<string> {
  const id = await newMerchant(d, n);
  await d.update(merchants).set({ status: "active", providerAccountId: `sim_acc_${n}` }).where(eq(merchants.id, id));
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId: id, amountCents: 100_000, bucket: "available", kind: "adjustment", refType: "manual", refId: randomUUID() },
    ]),
  );
  return id;
}

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.append(k, v);
  return fd;
};
const SAQUE = { idempotencyKey: "a".repeat(24), amount: "150,00", pixKeyType: "email", pixKey: "fornecedor@exemplo.com", description: "" };
const LOTE = { ...SAQUE, amount: "400,00" };

const lastStep = async () => (await d.select({ s: users.totpLastStep }).from(users).where(eq(users.id, userId)))[0].s;
const available = async () => (await getBalance(merchantId)).available;
const parcels = () =>
  d.select({ i: payouts.batchIndex, status: payouts.status }).from(payouts).orderBy(payouts.batchIndex);
const page = async (sp: Record<string, string>) =>
  renderToStaticMarkup(await NovoSaquePage({ searchParams: Promise.resolve(sp) }));

/** Ação que termina em redirect: devolve o destino (resolver sem redirect falha o teste). */
async function redirectOf(action: Promise<unknown>): Promise<string> {
  const err = await action.then(
    (r) => {
      throw new Error(`sem redirect: ${JSON.stringify(r)}`);
    },
    (e: Error) => e,
  );
  expect(err.message).toMatch(/^NEXT_REDIRECT /);
  return err.message.slice("NEXT_REDIRECT ".length);
}
const batchIdOf = (to: string) => /\?lote=([0-9a-f-]{36})/.exec(to)![1];

describe("passo Revisão (previewPayoutAction)", () => {
  it("tarifa e saldo depois, sem ler o código 2FA nem gravar nada", async () => {
    const r = await previewPayoutAction(undefined, form({ ...SAQUE, pixKeyType: "phone", pixKey: "(11) 98765-4321", code: await codeAt(0) }));
    expect(r).toMatchObject({
      preview: {
        amountCents: 15_000, // teto exato = saque avulso
        feeCents: 100,
        totalCents: 15_100,
        availableCents: 100_000,
        afterCents: 84_900,
        pixKey: "+5511987654321",
        parcels: null,
      },
      values: { amount: "150,00", pixKey: "(11) 98765-4321" },
    });
    expect(await lastStep()).toBeNull();
    expect(await d.$count(payouts)).toBe(0);
    expect(await d.$count(payoutBatches)).toBe(0);
    expect(await available()).toBe(100_000);
  });

  it("acima do teto: prévia das parcelas com a tarifa de cada uma, igual ao que o lote debita", async () => {
    const r = await previewPayoutAction(undefined, form(LOTE));
    expect(r && "preview" in r && r.preview).toMatchObject({
      amountCents: 40_000,
      feeCents: 300,
      totalCents: 40_300,
      afterCents: 59_700,
      ceilingCents: 15_000,
      parcels: [
        { amountCents: 15_000, feeCents: 100 },
        { amountCents: 15_000, feeCents: 100 },
        { amountCents: 10_000, feeCents: 100 },
      ],
    });
    await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, code: await codeAt(0) })));
    expect(await available()).toBe(100_000 - 40_300); // um número só: o total da prévia é o que saiu do saldo
  });

  it("acima de R$ 50.000 o assistente aceita (o lote vai até R$ 1.000.000) e divide no teto por transferência", async () => {
    const r = await previewPayoutAction(undefined, form({ ...SAQUE, amount: "60.000,00" }));
    const p = r && "preview" in r ? r.preview : null;
    expect(p?.amountCents).toBe(6_000_000);
    expect(p?.parcels).toHaveLength(400); // 400 × R$ 150,00 (o teto deste teste)
    expect(await previewPayoutAction(undefined, form({ ...SAQUE, amount: "1.000.000,01" }))).toMatchObject({
      error: "O valor máximo por saque é R$ 1.000.000,00.",
    });
  });

  it("chave inválida volta com o erro; valor + tarifas acima do saldo aparece como saldo depois negativo", async () => {
    expect(await previewPayoutAction(undefined, form({ ...SAQUE, pixKeyType: "cpf", pixKey: "529.982.247-24" }))).toMatchObject({
      error: "Chave Pix inválida para CPF. Confira e tente de novo.",
      values: { pixKey: "529.982.247-24" },
    });
    // R$ 1.000,00 = 6 × 150 + 100 → 7 tarifas de R$ 1,00: passa do saldo de R$ 1.000,00.
    expect(await previewPayoutAction(undefined, form({ ...SAQUE, amount: "1.000,00" }))).toMatchObject({
      preview: { totalCents: 100_700, afterCents: -700 },
    });
  });
});

describe("lote pelo assistente (createBatchPayoutAction)", () => {
  it("campos e teto conferidos antes do 2FA; código errado não cria nada", async () => {
    const code = await codeAt(0);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await createBatchPayoutAction(undefined, form({ ...LOTE, pixKeyType: "cpf", pixKey: "529.982.247-24", code }))).toMatchObject({
      error: "Chave Pix inválida para CPF. Confira e tente de novo.",
    });
    expect(await createBatchPayoutAction(undefined, form({ ...SAQUE, code }))).toMatchObject({
      error: "Este valor cabe numa transferência só. Volte à revisão e envie de novo.",
    });
    expect(await lastStep()).toBeNull(); // nenhum dos dois gastou o código
    expect(await createBatchPayoutAction(undefined, form({ ...LOTE, code: wrong }))).toMatchObject({
      error: WRONG_CODE,
      values: { amount: "400,00" },
    });
    expect(await d.$count(payoutBatches)).toBe(0);
    expect(await d.$count(payouts)).toBe(0);
    expect(await available()).toBe(100_000);
    expect(afterTasks).toHaveLength(0);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("envia as parcelas, agenda os webhooks, atualiza o saldo da lateral e confirma na tela do lote", async () => {
    const to = await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, code: await codeAt(0) })));
    expect(to).toMatch(/^\/painel\/saques\/novo\?lote=[0-9a-f-]{36}$/);
    expect(await parcels()).toEqual([
      { i: 0, status: "completed" },
      { i: 1, status: "completed" },
      { i: 2, status: "completed" },
    ]);
    expect(afterTasks).toHaveLength(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/painel", "layout");

    const html = await page({ lote: batchIdOf(to) });
    expect(html).toContain("Lote enviado");
    expect(html).not.toContain("parcialmente");
    expect(html).not.toContain("Retomar parcelas pendentes");
    expect(html).toContain(`<span class="valor-sensivel tabular-nums">${brl(40_000)}</span>`);
  });

  it("mesma chave de idempotência: o mesmo lote com aviso de repetido; outro conteúdo é recusado", async () => {
    const first = await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, code: await codeAt(0) })));
    const again = await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, code: await codeAt(1) })));
    expect(again).toBe(`${first}&repetido=1`);
    expect(await d.$count(payoutBatches)).toBe(1);
    expect(await available()).toBe(100_000 - 40_300);
    expect(await page({ lote: batchIdOf(first), repetido: "1" })).toContain("Este lote já tinha sido enviado (mesma solicitação).");

    vi.setSystemTime((NOW + 60) * 1000); // passo seguinte para ter código novo
    expect(await createBatchPayoutAction(undefined, form({ ...LOTE, amount: "300,00", code: await codeAt(2) }))).toMatchObject({
      error: SAME_FORM,
    });
    expect(await d.$count(payoutBatches)).toBe(1);
  });

  it("um código aceito numa porta é recusado nas outras no mesmo passo (2FA anti-replay compartilhado)", async () => {
    const code = await codeAt(0);
    const to = await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, pixKey: "falha@teste.com", code })));
    expect(await createPayoutAction(undefined, form({ ...SAQUE, idempotencyKey: "b".repeat(24), code }))).toMatchObject({
      error: WRONG_CODE,
    });
    expect(await createBatchPayoutAction(undefined, form({ ...LOTE, idempotencyKey: "c".repeat(24), code }))).toMatchObject({
      error: WRONG_CODE,
    });
    expect(await resumeBatchAction(undefined, form({ id: batchIdOf(to), code }))).toMatchObject({ error: WRONG_CODE });
    expect(await d.$count(payoutBatches)).toBe(1);
    expect(await d.$count(payouts)).toBe(1); // só a parcela 0 do lote, que falhou e estornou
    expect(await available()).toBe(100_000);
  });

  it("saque avulso acima do teto é recusado antes do 2FA: só sai em parcelas", async () => {
    expect(await createPayoutAction(undefined, form({ ...LOTE, code: await codeAt(0) }))).toMatchObject({
      error: `Valor acima do limite de ${brl(15_000)} por transferência. Use Nova transferência para enviar em parcelas.`,
    });
    expect(await lastStep()).toBeNull();
    expect(await d.$count(payouts)).toBe(0);
  });
});

describe("retomar lote (resumeBatchAction) e a tela do lote", () => {
  it("retoma do ponto salvo no banco, com código novo, sem pagar de novo a parcela concluída", async () => {
    // Parcela 1 cai em merchant_inactive (rollback, sem linha): o spy suspende o lojista no envio da parcela 0.
    const real = simulator.createPayout.bind(simulator);
    vi.spyOn(simulator, "createPayout").mockImplementationOnce(async (arg) => {
      const r = await real(arg);
      await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, merchantId));
      return r;
    });
    const to = await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, code: await codeAt(0) })));
    const id = batchIdOf(to);
    expect(await parcels()).toEqual([{ i: 0, status: "completed" }]);
    expect(await available()).toBe(100_000 - 15_100);

    const partial = await page({ lote: id });
    expect(partial).toContain("Lote enviado parcialmente");
    expect(partial).toContain("Não enviada");
    expect(partial).toContain("Retomar parcelas pendentes");
    expect(partial).not.toContain(STUCK);

    await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, merchantId));
    // O código do envio já foi consumido: retomar com ele é recusado e nada muda.
    expect(await resumeBatchAction(undefined, form({ id, code: await codeAt(0) }))).toMatchObject({ error: WRONG_CODE });
    expect(await parcels()).toHaveLength(1);

    expect(await redirectOf(resumeBatchAction(undefined, form({ id, code: await codeAt(1) })))).toBe(`/painel/saques/novo?lote=${id}`);
    expect(await parcels()).toEqual([
      { i: 0, status: "completed" },
      { i: 1, status: "completed" },
      { i: 2, status: "completed" },
    ]);
    expect(await available()).toBe(100_000 - 40_300); // parcela 0 debitada uma vez só
    expect(afterTasks).toHaveLength(2);
    expect(await page({ lote: id })).not.toContain("Retomar parcelas pendentes");

    // Retomar de novo: lote concluído, recusado antes do código (não gasta).
    const step = await lastStep();
    vi.setSystemTime((NOW + 60) * 1000);
    expect(await resumeBatchAction(undefined, form({ id, code: await codeAt(2) }))).toMatchObject({
      error: "Este lote não tem parcelas pendentes para retomar.",
    });
    expect(await lastStep()).toBe(step);
  });

  it("parcela que falhou de vez: a tela explica e não oferece retomar", async () => {
    const to = await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, pixKey: "falha@teste.com", code: await codeAt(0) })));
    const html = await page({ lote: batchIdOf(to) });
    expect(html).toContain("Lote enviado parcialmente");
    expect(html).toContain(STUCK);
    expect(html).not.toContain("Retomar parcelas pendentes");
    expect(await available()).toBe(100_000); // a parcela que falhou estornou valor e tarifa
  });

  it("a lista de saques linka de volta o lote que não terminou (só os deste lojista)", async () => {
    const to = await redirectOf(createBatchPayoutAction(undefined, form({ ...LOTE, pixKey: "falha@teste.com", code: await codeAt(0) })));
    const outro = await activeMerchant(2);
    const { batchId: alheio } = await createBatchPayout(outro, { amount: 40_000, pix_key: "falha@teste.com", pix_key_type: "email" }, "lote-outro");
    const html = renderToStaticMarkup(await SaquesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(`href="/painel/saques/novo?lote=${batchIdOf(to)}"`);
    expect(html).toContain("parou numa parcela");
    expect(html).not.toContain(alheio);
  });

  it("lote de outro lojista: retomar não acha (sem gastar o código) e a URL dá 404", async () => {
    const outro = await activeMerchant(2);
    const { batchId } = await createBatchPayout(outro, { amount: 40_000, pix_key: "falha@teste.com", pix_key_type: "email" }, "lote-outro");
    expect((await d.select().from(payoutBatches))[0]).toMatchObject({ id: batchId, status: "partial" });

    const code = await codeAt(0);
    expect(await resumeBatchAction(undefined, form({ id: batchId, code }))).toMatchObject({ error: "Lote não encontrado." });
    expect(await resumeBatchAction(undefined, form({ id: "nao-e-uuid", code }))).toMatchObject({ error: "Lote não encontrado." });
    expect(await lastStep()).toBeNull();
    await expect(page({ lote: batchId })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("assistente novo abre no passo Dados com a chave de idempotência do render, sem campo de código", async () => {
    const html = await page({});
    expect(html).toMatch(/name="idempotencyKey" value="[A-Za-z0-9]{24}"/);
    expect(html).toMatch(/<li aria-current="step"[^>]*>.*?Dados/);
    expect(html).not.toContain('name="code"');
  });
});
