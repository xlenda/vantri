import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "@/lib/auth/password";
import { brl } from "@/lib/br/money";
import { type Db, setDb } from "@/lib/db/client";
import { charges, medCases, medFiles, merchants, payouts, users } from "@/lib/db/schema";
import { getBalance } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import { signupMerchant } from "@/lib/services/merchants";
import { seedAdmin } from "@/scripts/seed-admin";
import { createTestDb } from "@/tests/helpers/db";
import { newMerchant } from "@/tests/helpers/factories";
import { csvResponse } from "./admin-lib";
import ClientePage from "./clientes/[id]/page";
import { createMerchantAction, merchantStatusAction, updateFeesAction } from "./clientes/actions";
import AdminLayout from "./layout";
import { parsePercent, percent, reais, todayDate, todayStart } from "./format";
import { GET as downloadFile } from "./med/arquivo/[id]/route";
import { closeMedAction, openTestMedAction } from "./med/actions";
import AdminHome from "./page";
import { adminOverview, listChargesAdmin, listPayoutsAdmin, parseTxFilters } from "./queries";

// Guarda de verdade testado em tests/auth.test.ts; aqui só "logado como admin" ou "não logado" (redirect lança).
const auth = vi.hoisted(
  () => ({ user: null as null | { id: string; role: "admin"; adminRole?: "admin" | "operador" | "suporte" | null; email?: string } }),
);
vi.mock("@/lib/auth/guards", () => ({
  requireUser: vi.fn(async (opts: { role: string }) => {
    if (!auth.user || opts.role !== "admin") throw new Error("NEXT_REDIRECT");
    return { user: auth.user };
  }),
  // A permissão do papel é testada com o guarda de verdade em tests/perms.test.ts e tests/med-queue.test.ts.
  requireAdmin: vi.fn(async () => {
    if (!auth.user) throw new Error("NEXT_REDIRECT");
    return { user: auth.user };
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// BrasilAPI de mentira: por padrão fora do ar (cada teste escolhe a resposta).
const receita = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@/lib/br/cnpj-lookup", () => ({ lookupCnpj: receita.lookup }));

let d: Db;
let seq = 0;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  vi.stubEnv("PIX_PROVIDER", "simulator");
  receita.lookup.mockReset().mockResolvedValue({ ok: false });
  d = await createTestDb();
  setDb(d);
  // Direto no banco (sem argon2 a cada teste); o seedAdmin tem os testes dele abaixo.
  const [u] = await d
    .insert(users)
    .values({ email: "admin@vantri.test", passwordHash: "x", role: "admin" })
    .returning({ id: users.id });
  auth.user = { id: u.id, role: "admin" };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function merchant(status: (typeof merchants.$inferSelect)["status"] = "active") {
  const id = await newMerchant(d, ++seq);
  await d.update(merchants).set({ status }).where(eq(merchants.id, id));
  return id;
}

async function charge(merchantId: string, o: Partial<typeof charges.$inferInsert> = {}) {
  const n = ++seq;
  const [c] = await d
    .insert(charges)
    .values({
      merchantId,
      txid: `tx${n}`,
      externalRef: `ref${n}`,
      amountCents: 10000,
      feeCents: 149,
      status: "paid",
      brcode: "000201",
      providerChargeId: `sim_ch_${n}`,
      expiresAt: new Date(Date.now() + 3600_000),
      paidAt: new Date(),
      ...o,
    })
    .returning();
  return c;
}

async function payout(merchantId: string, o: Partial<typeof payouts.$inferInsert> = {}) {
  const n = ++seq;
  await d.insert(payouts).values({
    merchantId,
    amountCents: 1000,
    feeCents: 100,
    pixKey: "pix@exemplo.com",
    pixKeyType: "email",
    status: "processing",
    idempotencyKey: `k${n}`,
    requestHash: "h",
    ...o,
  });
}

async function medCase(merchantId: string, chargeId: string, status: (typeof medCases.$inferSelect)["status"] = "open") {
  const [c] = await d
    .insert(medCases)
    .values({
      merchantId,
      chargeId,
      providerCaseId: `sim_med_${++seq}`,
      amountCents: 5000,
      reason: "teste",
      status,
      defenseDeadline: new Date(Date.now() + 86_400_000),
    })
    .returning();
  return c;
}

describe("formato", () => {
  it("percentual com vírgula (até 2 casas) vira pontos-base", () => {
    expect(parsePercent("1,49")).toBe(149);
    expect(parsePercent("1.49")).toBe(149);
    expect(parsePercent("2,5")).toBe(250);
    expect(parsePercent(" 0 ")).toBe(0);
    expect(parsePercent("100")).toBe(10000);
    expect(parsePercent("1,49%")).toBe(149);
    for (const bad of ["1,999", "abc", "", "-1", "1,", ",5", "1e2", "1.000,00"]) expect(parsePercent(bad)).toBeNull();
  });

  it("mostra bps e centavos no formato dos campos", () => {
    expect(percent(149)).toBe("1,49");
    expect(percent(0)).toBe("0,00");
    expect(reais(100)).toBe("1,00");
    expect(reais(123456)).toBe("1234,56");
  });

  it("início do dia em Brasília (UTC−3)", () => {
    // 02:00 UTC do dia 16 = 23:00 do dia 15 em Brasília
    expect(todayStart(Date.parse("2026-10-16T02:00:00Z"))).toBe(Date.parse("2026-10-15T03:00:00Z"));
    expect(todayStart(Date.parse("2026-10-16T03:00:00Z"))).toBe(Date.parse("2026-10-16T03:00:00Z"));
    expect(todayDate(Date.parse("2026-10-16T02:00:00Z"))).toBe("2026-10-15");
    expect(todayDate(Date.parse("2026-10-16T03:00:00Z"))).toBe("2026-10-16");
  });
});

describe("seed do admin", () => {
  it("cria admin com senha temporária e troca obrigatória", async () => {
    const r = await seedAdmin("  Nova.Admin@Vantri.TEST ");
    expect(r.email).toBe("nova.admin@vantri.test");
    expect(r.tempPassword).toMatch(/^[0-9A-Za-z]{16}$/);
    const [u] = await d.select().from(users).where(eq(users.email, "nova.admin@vantri.test"));
    expect(u.role).toBe("admin");
    expect(u.mustChangePassword).toBe(true);
    expect(u.merchantId).toBeNull();
    expect(await verifyPassword(u.passwordHash, r.tempPassword)).toBe(true);
  });

  it("recusa e-mail que já existe, sem mexer no usuário", async () => {
    const [before] = await d.select().from(users).where(eq(users.email, "admin@vantri.test"));
    await expect(seedAdmin("ADMIN@vantri.test")).rejects.toThrow(/já existe/i);
    const all = await d.select().from(users);
    expect(all).toHaveLength(1);
    expect(all[0].passwordHash).toBe(before.passwordHash);
  });

  it("recusa e-mail inválido", async () => {
    await expect(seedAdmin("não-é-email")).rejects.toThrow(/e-mail inválido/i);
    await expect(seedAdmin("")).rejects.toThrow(/e-mail inválido/i);
  });
});

describe("início", () => {
  it("conta pendentes, volume pago hoje, saques em processamento e MEDs em aberto", async () => {
    const now = Date.now();
    const m = await merchant("active");
    await merchant("pending");
    await merchant("suspended");
    const c1 = await charge(m, { amountCents: 10000, paidAt: new Date(now) });
    await charge(m, { amountCents: 5000, paidAt: new Date(todayStart(now)) });
    await charge(m, { amountCents: 7000, paidAt: new Date(todayStart(now) - 1) }); // ontem
    await charge(m, { amountCents: 3000, status: "pending", paidAt: null });
    await payout(m, { amountCents: 2000 });
    await payout(m, { amountCents: 1000 });
    await payout(m, { amountCents: 500, status: "completed" });
    await medCase(m, c1.id, "open");
    await medCase(m, c1.id, "defended");
    await medCase(m, c1.id, "merchant_won");

    expect(await adminOverview(now)).toEqual({
      pendingMerchants: 1,
      paidToday: { count: 2, cents: 15000 },
      processingPayouts: { count: 2, cents: 3000 },
      openMeds: 2,
    });
  });

  it("produção sem o par de chaves do Turnstile: cartão de alerta no início", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const card = "Proteção contra robôs (Turnstile) desligada — configure as duas chaves";
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "chave-publica");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(renderToStaticMarkup(await AdminHome())).not.toContain(card); // fora de produção
    vi.stubEnv("VERCEL_ENV", "production");
    expect(renderToStaticMarkup(await AdminHome())).toContain(card);
    vi.stubEnv("TURNSTILE_SECRET_KEY", "segredo");
    expect(renderToStaticMarkup(await AdminHome())).not.toContain(card);
  });

  it("banco vazio dá zeros", async () => {
    expect(await adminOverview()).toEqual({
      pendingMerchants: 0,
      paidToday: { count: 0, cents: 0 },
      processingPayouts: { count: 0, cents: 0 },
      openMeds: 0,
    });
  });
});

describe("transações", () => {
  const day = (s: string) => new Date(`${s}-03:00`);

  it("filtra cobranças por cliente, status e período, mais novas primeiro, paginadas", async () => {
    const a = await merchant();
    const b = await merchant();
    const old = await charge(a, { createdAt: day("2026-10-01T10:00:00") });
    const mid = await charge(a, { createdAt: day("2026-10-10T23:59:00"), status: "pending", paidAt: null });
    const last = await charge(a, { createdAt: day("2026-10-11T00:00:00") });
    const other = await charge(b, { createdAt: day("2026-10-10T12:00:00") });

    const all = await listChargesAdmin({ page: 1 });
    expect(all.rows.map((r) => r.charge.id)).toEqual([last.id, mid.id, other.id, old.id]);
    expect(all.rows[0].tradeName).toMatch(/^Loja /);
    expect(all.hasNext).toBe(false);

    expect((await listChargesAdmin({ page: 1, merchantId: b })).rows.map((r) => r.charge.id)).toEqual([other.id]);
    expect((await listChargesAdmin({ page: 1, status: "paid", merchantId: a })).rows.map((r) => r.charge.id)).toEqual([
      last.id,
      old.id,
    ]);
    // `to` inclusivo, dia de Brasília
    const range = await listChargesAdmin({ page: 1, from: "2026-10-10", to: "2026-10-10" });
    expect(range.rows.map((r) => r.charge.id)).toEqual([mid.id, other.id]);

    const p1 = await listChargesAdmin({ page: 1 }, 3);
    expect(p1.rows).toHaveLength(3);
    expect(p1.hasNext).toBe(true);
    const p2 = await listChargesAdmin({ page: 2 }, 3);
    expect(p2.rows.map((r) => r.charge.id)).toEqual([old.id]);
    expect(p2.hasNext).toBe(false);
  });

  it("com o filtro paga, o período é pelo dia do pagamento (o Recebido hoje do início)", async () => {
    const a = await merchant();
    const lateBuyer = await charge(a, {
      createdAt: day("2026-10-09T22:00:00"),
      paidAt: day("2026-10-10T09:00:00"),
    });
    await charge(a, { createdAt: day("2026-10-10T08:00:00"), paidAt: day("2026-10-11T10:00:00") });
    const tenth = { page: 1, from: "2026-10-10", to: "2026-10-10" };
    expect((await listChargesAdmin({ ...tenth, status: "paid" })).rows.map((r) => r.charge.id)).toEqual([lateBuyer.id]);
    // sem o filtro de status, continua pelo dia da criação
    expect((await listChargesAdmin(tenth)).rows.map((r) => r.charge.id)).not.toContain(lateBuyer.id);
  });

  it("pendente vencida conta como expirada", async () => {
    const a = await merchant();
    const due = await charge(a, { status: "pending", paidAt: null, expiresAt: new Date(Date.now() - 1000) });
    const live = await charge(a, { status: "pending", paidAt: null });
    expect((await listChargesAdmin({ page: 1, status: "expired" })).rows.map((r) => r.charge.id)).toEqual([due.id]);
    expect((await listChargesAdmin({ page: 1, status: "pending" })).rows.map((r) => r.charge.id)).toEqual([live.id]);
  });

  it("filtra saques por status", async () => {
    const a = await merchant();
    await payout(a, { status: "completed" });
    await payout(a, { status: "processing" });
    const r = await listPayoutsAdmin({ page: 1, status: "processing" });
    expect(r.rows.map((x) => x.payout.status)).toEqual(["processing"]);
    expect((await listPayoutsAdmin({ page: 1 })).rows).toHaveLength(2);
  });

  it("filtros da URL: só a lista branca, valor inválido é ignorado", () => {
    expect(
      parseTxFilters({ tipo: "x", status: "hack", cliente: "não-uuid", de: "2026-13-45", ate: "ontem", pagina: "-3", extra: "1" }),
    ).toEqual({ tipo: "cobrancas", page: 1 });
    const id = "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b";
    expect(parseTxFilters({ tipo: "saques", status: "failed", cliente: id, de: "2026-10-01", pagina: ["2", "9"] })).toEqual({
      tipo: "saques",
      status: "failed",
      merchantId: id,
      from: "2026-10-01",
      page: 2,
    });
    // status de cobrança não vale para saque
    expect(parseTxFilters({ tipo: "saques", status: "paid" })).toEqual({ tipo: "saques", page: 1 });
  });
});

const CPF = "52998224725";
const CNPJ = "11222333000181";
const newClient = (over: Record<string, string> = {}) =>
  form({
    legalName: "Maria da Silva",
    tradeName: "Curso da Maria",
    documentType: "cpf",
    document: CPF,
    segment: "cursos",
    email: "Maria@Exemplo.com",
    ...over,
  });

describe("ações de clientes", () => {
  it("criar cliente devolve e-mail e senha temporária uma vez", async () => {
    const s = await createMerchantAction(undefined, newClient());
    if (!s || !("created" in s)) throw new Error(`esperava criado, veio ${JSON.stringify(s)}`);
    expect(s.created.email).toBe("maria@exemplo.com");
    expect(s.created.tempPassword).toMatch(/^[0-9A-Za-z]{16}$/);
    const [m] = await d.select().from(merchants).where(eq(merchants.id, s.created.merchantId));
    expect(m.status).toBe("active");
    const [u] = await d.select().from(users).where(eq(users.merchantId, m.id));
    expect(u.mustChangePassword).toBe(true);
    expect(await verifyPassword(u.passwordHash, s.created.tempPassword)).toBe(true);
  });

  it("criar cliente com e-mail repetido: mensagem em PT e campos de volta", async () => {
    await createMerchantAction(undefined, newClient());
    const s = await createMerchantAction(undefined, newClient({ document: "11144477735" }));
    expect(s).toMatchObject({ error: "Já existe um cadastro com este e-mail.", values: { legalName: "Maria da Silva" } });
  });

  it("falha no parceiro: mensagem em PT, nunca a causa", async () => {
    vi.spyOn(simulator, "createAccount").mockRejectedValue(new Error("detalhe interno do parceiro"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await createMerchantAction(undefined, newClient());
    expect(s).toMatchObject({ error: "Não foi possível abrir a conta no parceiro. Tente de novo." });
    expect(JSON.stringify(s)).not.toContain("detalhe");
    expect(await d.select().from(merchants)).toHaveLength(0);
  });

  it("taxas em % e R$ viram bps e centavos", async () => {
    const id = await merchant();
    const s = await updateFeesAction(
      undefined,
      form({ merchantId: id, feeInPercent: "1,99", feeInFixed: "0,50", feeOutPercent: "0", feeOutFixed: "2,00" }),
    );
    expect(s).toEqual({ ok: "Taxas atualizadas." });
    const [m] = await d.select().from(merchants).where(eq(merchants.id, id));
    expect([m.feeInBps, m.feeInFixedCents, m.feeOutBps, m.feeOutFixedCents]).toEqual([199, 50, 0, 200]);
  });

  it("taxa fora da faixa ou mal escrita é recusada antes do serviço", async () => {
    const id = await merchant();
    const base = { merchantId: id, feeInPercent: "1,49", feeInFixed: "0", feeOutPercent: "0", feeOutFixed: "1,00" };
    for (const [field, value, msg] of [
      ["feeInPercent", "100,01", /^Taxa percentual inválida/],
      ["feeOutPercent", "1,999", /^Taxa percentual inválida/],
      ["feeInFixed", "1.000,01", /^Taxa fixa inválida/],
      ["feeOutFixed", "abc", /^Taxa fixa inválida/],
      ["feeOutFixed", "-1", /^Taxa fixa inválida/],
    ] as const) {
      const s = await updateFeesAction(undefined, form({ ...base, [field]: value }));
      expect(s && "error" in s ? s.error : s).toMatch(msg);
    }
    const [m] = await d.select().from(merchants).where(eq(merchants.id, id));
    expect([m.feeInBps, m.feeInFixedCents, m.feeOutBps, m.feeOutFixedCents]).toEqual([149, 0, 0, 100]);
  });

  const reviewCnpj = async () =>
    (
      await signupMerchant(
        { legalName: "Escola LTDA", tradeName: "Escola", documentType: "cnpj", document: CNPJ, segment: "cursos", email: "e@x.com", password: "senha-bem-longa-123" },
        { lookup: async () => ({ ok: false }) },
      )
    ).merchantId;
  const statusOf = async (id: string) => (await d.select().from(merchants).where(eq(merchants.id, id)))[0].status;

  it("aprovar cliente em revisão manual com a Receita ainda fora do ar exige a confirmação", async () => {
    const merchantId = await reviewCnpj();
    const s1 = await merchantStatusAction(undefined, form({ merchantId, op: "approve" }));
    expect(s1).toEqual({
      error:
        "A Receita continua sem responder. Confira o CNPJ completo e os CNAEs na Receita e marque “Conferi o CNPJ e o CNAE manualmente” para aprovar.",
    });
    expect(receita.lookup).toHaveBeenCalledWith(CNPJ);
    expect(await statusOf(merchantId)).toBe("pending");

    const s2 = await merchantStatusAction(undefined, form({ merchantId, op: "approve", manualCheck: "sim" }));
    expect(s2).toEqual({ ok: "Cliente aprovado." });
    expect(await statusOf(merchantId)).toBe("active");
  });

  it("CNPJ de apostas que caiu em revisão é recusado na aprovação quando a Receita volta", async () => {
    const merchantId = await reviewCnpj();
    receita.lookup.mockResolvedValue({ ok: true, legalName: "ESCOLA LTDA", cnaes: ["8599604", "9200399"], active: true });
    expect(await merchantStatusAction(undefined, form({ merchantId, op: "approve", manualCheck: "sim" }))).toEqual({
      error: "Este CNPJ tem CNAE de apostas. Não atendemos apostas nem jogos de azar.",
    });
    expect(await statusOf(merchantId)).toBe("pending");

    receita.lookup.mockResolvedValue({ ok: true, legalName: "ESCOLA LTDA", cnaes: ["8599604"], active: true });
    expect(await merchantStatusAction(undefined, form({ merchantId, op: "approve" }))).toEqual({ ok: "Cliente aprovado." });
    expect((await d.select().from(merchants).where(eq(merchants.id, merchantId)))[0]).toMatchObject({
      status: "active",
      needsManualReview: false,
    });
  });

  it("página do cliente: CNPJ completo só pendente em revisão manual; lembrete dos 30 dias na taxa de cliente ativo", async () => {
    const merchantId = await reviewCnpj();
    const page = async () => renderToStaticMarkup(await ClientePage({ params: Promise.resolve({ id: merchantId }) }));
    const reminder = "Os termos prometem aviso com 30 dias de antecedência antes de mudar a tarifa de um cliente ativo";

    const pending = await page();
    expect(pending).toContain("11.222.333/0001-81");
    expect(pending).not.toContain(reminder); // ainda não é cliente ativo

    receita.lookup.mockResolvedValue({ ok: true, legalName: "ESCOLA LTDA", cnaes: ["8599604"], active: true });
    await merchantStatusAction(undefined, form({ merchantId, op: "approve" }));
    const active = await page();
    expect(active).toContain("11.222.333/****-**");
    expect(active).not.toContain("11.222.333/0001-81");
    expect(active).toContain(reminder);
  });

  it("aprova sem confirmação quando não precisa de revisão; transições inválidas dão erro em PT", async () => {
    const { merchantId } = await signupMerchant({
      legalName: "Maria",
      tradeName: "Curso",
      documentType: "cpf",
      document: CPF,
      segment: "cursos",
      email: "m@x.com",
      password: "senha-bem-longa-123",
    });
    expect(await merchantStatusAction(undefined, form({ merchantId, op: "reactivate" }))).toEqual({
      error: "Ação não permitida no status atual do cliente.",
    });
    expect(await merchantStatusAction(undefined, form({ merchantId, op: "approve" }))).toEqual({ ok: "Cliente aprovado." });
    expect(await merchantStatusAction(undefined, form({ merchantId, op: "suspend" }))).toEqual({ ok: "Cliente suspenso." });
    expect(await merchantStatusAction(undefined, form({ merchantId, op: "reactivate" }))).toEqual({
      ok: "Cliente reativado.",
    });
    expect(await merchantStatusAction(undefined, form({ merchantId, op: "delete" }))).toEqual({
      error: "Pedido inválido.",
    });
  });

  it("sem sessão de admin nenhuma ação roda", async () => {
    const id = await merchant("pending");
    auth.user = null;
    await expect(createMerchantAction(undefined, newClient())).rejects.toThrow("NEXT_REDIRECT");
    await expect(
      updateFeesAction(undefined, form({ merchantId: id, feeInPercent: "9", feeInFixed: "0", feeOutPercent: "0", feeOutFixed: "0" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    await expect(merchantStatusAction(undefined, form({ merchantId: id, op: "reject" }))).rejects.toThrow("NEXT_REDIRECT");
    const [m] = await d.select().from(merchants).where(eq(merchants.id, id));
    expect([m.status, m.feeInBps]).toEqual(["pending", 149]);
    expect(await d.select().from(merchants)).toHaveLength(1);
  });
});

describe("MED", () => {
  it("abre MED de teste só em cobrança paga e com valor até o da cobrança", async () => {
    const m = await merchant();
    const pending = await charge(m, { status: "pending", paidAt: null });
    const paid = await charge(m, { amountCents: 10000 });

    expect(await openTestMedAction(undefined, form({ chargeId: pending.id, amount: "10,00" }))).toEqual({
      error: "Só dá para abrir MED numa cobrança paga.",
    });
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "100,01" }))).toEqual({
      error: "O valor do MED vai de R$ 0,01 até o valor da cobrança.",
    });
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "0" }))).toEqual({
      error: "O valor do MED vai de R$ 0,01 até o valor da cobrança.",
    });
    // "1.000" é ambíguo (milhar ou decimal?): a regra única de lib/br/money recusa
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "1.000" }))).toEqual({
      error: "Valor inválido. Escreva, por exemplo, 40,00 ou 1.000,00.",
    });
    expect(await openTestMedAction(undefined, form({ chargeId: "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b", amount: "1" }))).toEqual({
      error: "Cobrança não encontrada.",
    });
    expect(await d.select().from(medCases)).toHaveLength(0);

    const s = await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "40,00" }));
    expect(s).toEqual({ ok: `MED de teste aberto. ${brl(4000)} bloqueados no saldo do cliente.` });
    const [c] = await d.select().from(medCases);
    expect([c.chargeId, c.amountCents, c.status]).toEqual([paid.id, 4000, "open"]);
    expect((await getBalance(m)).blocked).toBe(4000);
  });

  it("a soma dos MEDs da cobrança (qualquer status) não passa do valor dela", async () => {
    const m = await merchant();
    const paid = await charge(m, { amountCents: 10000 });
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "60,00" }))).toMatchObject({
      ok: expect.any(String),
    });
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "50,00" }))).toEqual({
      error: `A soma dos MEDs desta cobrança passaria do valor dela. Ainda cabe até ${brl(4000)}.`,
    });
    // encerrado também conta
    const [first] = await d.select().from(medCases);
    await closeMedAction(undefined, form({ caseId: first.id, outcome: "merchant_won" }));
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "40,01" }))).toMatchObject({
      error: expect.stringMatching(/^A soma dos MEDs/),
    });
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "40,00" }))).toMatchObject({
      ok: expect.any(String),
    });
    expect(await d.select().from(medCases)).toHaveLength(2);
  });

  it("MED de teste só com o simulador", async () => {
    vi.stubEnv("PIX_PROVIDER", "parceiro");
    const paid = await charge(await merchant());
    expect(await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "1" }))).toEqual({
      error: "MED de teste só existe no ambiente de simulação.",
    });
  });

  it("encerra a favor do lojista ou do pagador, uma vez só", async () => {
    const m = await merchant();
    const paid = await charge(m);
    await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "50,00" }));
    const [c] = await d.select().from(medCases);

    expect(await closeMedAction(undefined, form({ caseId: c.id, outcome: "talvez" }))).toEqual({ error: "Pedido inválido." });
    expect(await closeMedAction(undefined, form({ caseId: c.id, outcome: "merchant_won" }))).toEqual({
      ok: "MED encerrado a favor do lojista.",
    });
    expect((await d.select().from(medCases))[0].status).toBe("merchant_won");
    expect(await getBalance(m)).toMatchObject({ blocked: 0 });
    expect(await closeMedAction(undefined, form({ caseId: c.id, outcome: "payer_refunded" }))).toEqual({
      error: "Este MED já está encerrado.",
    });

    await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "30,00" }));
    const open = (await d.select().from(medCases).where(eq(medCases.status, "open")))[0];
    expect(await closeMedAction(undefined, form({ caseId: open.id, outcome: "payer_refunded" }))).toEqual({
      ok: "MED encerrado com devolução ao pagador.",
    });
    // A cobrança do teste não lançou crédito: só sobra o débito do MED devolvido.
    expect(await getBalance(m)).toMatchObject({ blocked: 0, available: -3000 });
  });

  it("encerrar MED pelo admin só com o simulador", async () => {
    const paid = await charge(await merchant());
    await openTestMedAction(undefined, form({ chargeId: paid.id, amount: "10,00" }));
    const [c] = await d.select().from(medCases);
    vi.stubEnv("PIX_PROVIDER", "parceiro");
    expect(await closeMedAction(undefined, form({ caseId: c.id, outcome: "merchant_won" }))).toEqual({
      error: "Encerrar MED pelo admin só existe no ambiente de simulação; com o parceiro, o desfecho vem dele.",
    });
    expect((await d.select().from(medCases))[0].status).toBe("open");
  });

  it("sem sessão de admin as ações de MED não rodam", async () => {
    const paid = await charge(await merchant());
    auth.user = null;
    await expect(openTestMedAction(undefined, form({ chargeId: paid.id, amount: "1" }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(closeMedAction(undefined, form({ caseId: paid.id, outcome: "merchant_won" }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(await d.select().from(medCases)).toHaveLength(0);
  });
});

describe("download de anexo", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const get = (id: string) => downloadFile(new Request("http://localhost/x"), { params: Promise.resolve({ id }) });

  async function file(filename: string) {
    const m = await merchant();
    const c = await medCase(m, (await charge(m)).id, "defended");
    const [f] = await d
      .insert(medFiles)
      .values({ medCaseId: c.id, filename, mime: "application/pdf", sizeBytes: PDF.length, data: PDF })
      .returning({ id: medFiles.id });
    return f.id;
  }

  it("baixa como anexo, com o tipo guardado e nome codificado", async () => {
    const res = await get(await file("comprovante ação'(1).pdf"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''comprovante%20a%C3%A7%C3%A3o%27%281%29.pdf",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });

  it("id desconhecido ou inválido: 404", async () => {
    expect((await get("6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b")).status).toBe(404);
    expect((await get("../../etc")).status).toBe(404);
  });

  it("sem sessão de admin não baixa", async () => {
    const id = await file("a.pdf");
    auth.user = null;
    await expect(get(id)).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("casca do admin", () => {
  // AdminLayout é async; resolvemos antes de passar para renderToStaticMarkup.
  const renderAs = async (adminRole: "admin" | "operador" | "suporte") => {
    auth.user = { id: "u1", role: "admin", adminRole, email: "ana@vantri.test" };
    return renderToStaticMarkup(await AdminLayout({ children: null }));
  };

  it("admin vê todos os itens e o selo do papel", async () => {
    const html = await renderAs("admin");
    for (const label of ["Visão do suporte", "Clientes e sellers", "Transações PIX", "Saques", "Webhooks", "MED", "Equipe e papéis", "Aprovações", "Tarifas", "Saúde"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Administrador"); // selo do papel
    expect(html).toContain("ana@vantri.test");
  });

  it("suporte não vê Tarifas, Aprovações nem Equipe, mas tem o selo e os itens de leitura", async () => {
    const html = await renderAs("suporte");
    for (const hidden of ["Tarifas", "Aprovações", "Equipe e papéis"]) expect(html).not.toContain(hidden);
    for (const seen of ["Visão do suporte", "Clientes e sellers", "Transações PIX", "MED", "Auditoria", "Saúde"]) {
      expect(html).toContain(seen);
    }
    expect(html).toContain("Suporte"); // selo do papel
  });

  it("mostra a busca global e o indicador de ambiente", async () => {
    const html = await renderAs("admin");
    expect(html).toContain("Localizar operação");
    expect(html).toContain("/admin/busca");
    expect(html).toContain("Ambiente: Demonstração"); // PIX_PROVIDER=simulator no beforeEach
  });
});

describe("csvResponse", () => {
  it("monta CSV com BOM, ponto-e-vírgula, CRLF, anexo e no-store; neutraliza injeção", async () => {
    const res = csvResponse("x.csv", ["Nome", "Valor"], [["=1+1", 'a;"b"']]);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="x.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    // .text() descarta o BOM (spec do fetch); conferimos nos bytes com ignoreBOM.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text).toBe('﻿Nome;Valor\r\n\'=1+1;"a;""b"""\r\n');
  });
});
