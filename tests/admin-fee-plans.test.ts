import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveFeePlanAction, assignFeePlanAction, createFeePlanAction } from "@/app/admin/tarifas/actions";
import { GET as exportFeeHistory } from "@/app/admin/tarifas/export/route";
import TarifasPage from "@/app/admin/tarifas/page";
import { brl } from "@/lib/br/money";
import { sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, feeHistory as feeHistoryTable, feePlans, merchants, sessions, users } from "@/lib/db/schema";
import {
  archiveFeePlan,
  assignPlanToMerchant,
  createFeePlan,
  feeHistory,
  listFeePlans,
  simulateFee,
} from "@/lib/services/admin/fee-plans";
import { updateFees } from "@/lib/services/merchants";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Único ponto simulado: o cookie da requisição. Sessão, 2FA, papel e permissão são de verdade
// (linha em `sessions` + requireAdmin inteiro), então "suporte não gere tarifas" prova o guarda do servidor.
const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vantri_session" && cookieJar.token ? { name, value: cookieJar.token } : undefined),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Hash de senha com cara de segredo: nenhuma exportação pode trazê-lo.
const PASSWORD_HASH = "$argon2id$segredo-que-nao-pode-vazar";
const FEES = { feeInBps: 199, feeInFixedCents: 50, feeOutBps: 10, feeOutFixedCents: 150 };
const DEFAULT_FEES = { feeInBps: 149, feeInFixedCents: 0, feeOutBps: 0, feeOutFixedCents: 100 }; // padrão do cadastro
const NOT_FOUND = /^NEXT_HTTP_ERROR_FALLBACK;404/;

let d: Db;
let seq = 0;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  cookieJar.token = undefined;
  seq = 0; // o 1º login de cada teste é sempre admin1@vantri.test
});

afterEach(() => {
  vi.useRealTimers();
});

/** Admin com sessão que já passou pelo 2FA; o cookie da requisição passa a ser o dele. */
async function loginAs(adminRole: "admin" | "operador" | "suporte"): Promise<string> {
  const n = ++seq;
  const [u] = await d
    .insert(users)
    .values({ email: `${adminRole}${n}@vantri.test`, passwordHash: PASSWORD_HASH, role: "admin", adminRole, totpEnabled: true })
    .returning({ id: users.id });
  const token = `sessao-${n}`;
  await d
    .insert(sessions)
    .values({ id: sha256Hex(token), userId: u.id, mfaPassed: true, expiresAt: new Date(Date.now() + 3_600_000) });
  cookieJar.token = token;
  return u.id;
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const plan = (over: Record<string, unknown> = {}) => ({ name: "Padrão", ...FEES, ...over });

async function feesOf(merchantId: string) {
  const [m] = await d
    .select({
      feeInBps: merchants.feeInBps,
      feeInFixedCents: merchants.feeInFixedCents,
      feeOutBps: merchants.feeOutBps,
      feeOutFixedCents: merchants.feeOutFixedCents,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  return m;
}

const actions = async () => (await d.select().from(auditLog)).map((r) => r.action);

const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: { code?: string }) => e.code,
  );

/** digest do erro do Next (notFound/redirect); "ok" se não lançou. */
const digest = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { digest?: string }) => e.digest ?? String(e),
  );

const exportReq = (cliente: string) => exportFeeHistory(new Request(`http://localhost/admin/tarifas/export?cliente=${cliente}`));
const csvText = async (res: Response) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());

describe("planos de tarifa (serviço)", () => {
  it("criar plano e atribuir muda as 4 taxas do cliente e grava fee_history com planId e autor", async () => {
    const adminId = await loginAs("admin");
    const m = await newMerchant(d, 1);
    const { id: planId } = await createFeePlan(plan(), adminId);

    const [p] = await d.select().from(feePlans);
    expect(p).toMatchObject({ id: planId, name: "Padrão", ...FEES, archivedAt: null });

    await assignPlanToMerchant(m, planId, adminId);
    expect(await feesOf(m)).toEqual(FEES);
    expect(await d.select().from(feeHistoryTable)).toEqual([
      expect.objectContaining({ merchantId: m, ...FEES, planId, actorUserId: adminId, effectiveFrom: expect.any(Date) }),
    ]);

    // Uma linha de auditoria por ação, com o autor; a mudança de taxa diz de qual plano veio.
    const rows = await d.select({ actorUserId: auditLog.actorUserId, action: auditLog.action, meta: auditLog.meta }).from(auditLog);
    expect(rows).toEqual([
      { actorUserId: adminId, action: "fee_plan.create", meta: { planId, name: "Padrão", ...FEES } },
      { actorUserId: adminId, action: "merchant.update_fees", meta: { merchantId: m, ...FEES, planId } },
    ]);
  });

  it("plano inválido é recusado sem gravar nada", async () => {
    const adminId = await loginAs("admin");
    for (const bad of [
      plan({ feeInBps: 10_001 }),
      plan({ feeOutFixedCents: 100_001 }),
      plan({ feeOutBps: -1 }),
      plan({ feeInBps: 1.5 }),
      plan({ name: " x " }),
      plan({ name: "a".repeat(61) }),
      plan({ name: "Plano\u0000nulo" }),
      plan({ archivedAt: null }), // campo fora da lista branca
      { name: "Sem taxas" },
    ]) {
      expect(await errorCode(createFeePlan(bad, adminId))).toBe("invalid_request");
    }
    expect(await d.select().from(feePlans)).toHaveLength(0);
    expect(await actions()).toEqual([]);
  });

  it("plano arquivado não é atribuído; arquivar vale uma vez só e o plano continua listado", async () => {
    const adminId = await loginAs("admin");
    const m = await newMerchant(d, 1);
    const { id: planId } = await createFeePlan(plan(), adminId);

    await archiveFeePlan(planId, adminId);
    expect(await errorCode(assignPlanToMerchant(m, planId, adminId))).toBe("not_found");
    expect(await errorCode(archiveFeePlan(planId, adminId))).toBe("not_found");
    expect(await errorCode(archiveFeePlan("nao-e-uuid", adminId))).toBe("not_found");
    expect(await errorCode(assignPlanToMerchant(m, "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b", adminId))).toBe("not_found");

    expect(await feesOf(m)).toEqual(DEFAULT_FEES);
    expect(await d.select().from(feeHistoryTable)).toHaveLength(0);
    expect(await listFeePlans()).toEqual([expect.objectContaining({ id: planId, archivedAt: expect.any(Date) })]);
    expect(await actions()).toEqual(["fee_plan.create", "fee_plan.archive"]);

    // Cliente que não existe: o erro é do updateFees, nada gravado.
    const { id: other } = await createFeePlan(plan({ name: "Outro" }), adminId);
    expect(await errorCode(assignPlanToMerchant("6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b", other, adminId))).toBe("not_found");
    expect(await d.select().from(feeHistoryTable)).toHaveLength(0);
  });

  it("updateFees passa a gravar o histórico (taxa personalizada: sem plano)", async () => {
    const adminId = await loginAs("admin");
    const m = await newMerchant(d, 1);

    expect(await errorCode(updateFees(m, { ...FEES, feeInBps: 10_001 }, adminId))).toBe("invalid_request");
    expect(await d.select().from(feeHistoryTable)).toHaveLength(0);

    await updateFees(m, FEES, adminId);
    expect(await d.select().from(feeHistoryTable)).toEqual([
      expect.objectContaining({ merchantId: m, ...FEES, planId: null, actorUserId: adminId, effectiveFrom: expect.any(Date) }),
    ]);
    // A auditoria da taxa personalizada continua igual (sem planId).
    expect((await d.select().from(auditLog))[0].meta).toEqual({ merchantId: m, ...FEES });
  });

  it("feeHistory lista do mais novo para o mais antigo, com plano e autor, só do cliente pedido", async () => {
    const adminId = await loginAs("admin");
    const m = await newMerchant(d, 1);
    const other = await newMerchant(d, 2);
    const { id: planId } = await createFeePlan(plan({ name: "Escala" }), adminId);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    await updateFees(m, DEFAULT_FEES, adminId);
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    await assignPlanToMerchant(m, planId, adminId);
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    await updateFees(m, { ...FEES, feeInBps: 99 }, adminId);
    await updateFees(other, FEES, adminId);
    vi.useRealTimers();

    const h = await feeHistory(m);
    expect(h.map((r) => [r.effectiveFrom.toISOString(), r.feeInBps, r.planName, r.actorEmail])).toEqual([
      ["2026-10-09T12:00:00.000Z", 99, null, "admin1@vantri.test"],
      ["2026-10-05T12:00:00.000Z", 199, "Escala", "admin1@vantri.test"],
      ["2026-10-01T12:00:00.000Z", 149, null, "admin1@vantri.test"],
    ]);
    expect(h[1]).toMatchObject({ ...FEES, planId });
    expect(JSON.stringify(h)).not.toContain(PASSWORD_HASH);
    expect(await feeHistory(other)).toHaveLength(1);
    expect(await feeHistory("nao-e-uuid")).toEqual([]);
  });

  it("simulateFee: o lojista recebe a venda menos a tarifa, a mesma conta da cobrança", () => {
    // 1,49% de R$ 197,00 = R$ 2,9353 → R$ 2,94 (arredonda como computeFee) → recebe R$ 194,06
    expect(simulateFee(19_700, { feeInBps: 149, feeInFixedCents: 0 })).toBe(19_406);
    expect(simulateFee(19_700, { feeInBps: 149, feeInFixedCents: 100 })).toBe(19_306);
    expect(simulateFee(10_000, { feeInBps: 0, feeInFixedCents: 0 })).toBe(10_000);
    expect(simulateFee(100, { feeInBps: 0, feeInFixedCents: 150 })).toBe(-50); // venda não cobre a tarifa
  });
});

describe("tela e ações de tarifas", () => {
  it("suporte não gere tarifas: tela, ações e exportação dão 404 no servidor e nada é gravado; operador pode", async () => {
    const adminId = await loginAs("admin");
    const m = await newMerchant(d, 1);
    const { id: planId } = await createFeePlan(plan(), adminId);
    const newPlan = { name: "Forjado", feeInPercent: "0", feeInFixed: "0", feeOutPercent: "0", feeOutFixed: "0" };

    await loginAs("suporte");
    expect(await digest(TarifasPage({ searchParams: Promise.resolve({}) }))).toMatch(NOT_FOUND);
    expect(await digest(createFeePlanAction(undefined, form(newPlan)))).toMatch(NOT_FOUND);
    expect(await digest(archiveFeePlanAction(undefined, form({ planId })))).toMatch(NOT_FOUND);
    expect(await digest(assignFeePlanAction(undefined, form({ merchantId: m, planId })))).toMatch(NOT_FOUND);
    expect(await digest(exportReq(m))).toMatch(NOT_FOUND);

    cookieJar.token = undefined; // sem sessão: vai para o login
    expect(await digest(assignFeePlanAction(undefined, form({ merchantId: m, planId })))).toMatch(/^NEXT_REDIRECT/);

    expect(await d.select().from(feePlans)).toEqual([expect.objectContaining({ id: planId, archivedAt: null })]);
    expect(await feesOf(m)).toEqual(DEFAULT_FEES);
    expect(await d.select().from(feeHistoryTable)).toHaveLength(0);
    expect(await actions()).toEqual(["fee_plan.create"]);

    const operadorId = await loginAs("operador");
    expect(await assignFeePlanAction(undefined, form({ merchantId: m, planId }))).toEqual({
      ok: "Plano aplicado. As novas taxas valem para as próximas transações.",
    });
    expect(await feesOf(m)).toEqual(FEES);
    expect((await d.select().from(feeHistoryTable))[0]).toMatchObject({ planId, actorUserId: operadorId });
  });

  it("ações: criar com % e R$, aplicar e arquivar; erro em PT sem gravar", async () => {
    await loginAs("admin");
    const m = await newMerchant(d, 1);
    const fields = { name: " Escala 2026 ", feeInPercent: "1,99", feeInFixed: "0,50", feeOutPercent: "0,1", feeOutFixed: "1,50" };

    expect(await createFeePlanAction(undefined, form({ ...fields, feeInPercent: "100,01" }))).toEqual({
      error: "Taxa percentual inválida: use de 0 a 100, com até 2 casas (ex.: 1,49).",
    });
    expect(await createFeePlanAction(undefined, form({ ...fields, feeOutFixed: "1.000,01" }))).toEqual({
      error: "Taxa fixa inválida: use de R$ 0,00 a R$ 1.000,00, com até 2 casas (ex.: 1,00).",
    });
    expect(await createFeePlanAction(undefined, form({ ...fields, name: "" }))).toEqual({
      error: "Confira o plano: nome com 2 a 60 caracteres e taxas dentro dos limites.",
    });
    expect(await d.select().from(feePlans)).toHaveLength(0);

    expect(await createFeePlanAction(undefined, form(fields))).toEqual({ ok: "Plano criado." });
    const [p] = await d.select().from(feePlans);
    expect(p).toMatchObject({ name: "Escala 2026", ...FEES });

    expect(await assignFeePlanAction(undefined, form({ merchantId: m, planId: p.id }))).toMatchObject({ ok: expect.any(String) });
    expect(await feesOf(m)).toEqual(FEES);
    expect(await assignFeePlanAction(undefined, form({ merchantId: "nao-e-uuid", planId: p.id }))).toEqual({
      error: "Cliente não encontrado.",
    });

    expect(await archiveFeePlanAction(undefined, form({ planId: p.id }))).toEqual({
      ok: "Plano arquivado. Quem já usa continua com as mesmas taxas.",
    });
    expect(await archiveFeePlanAction(undefined, form({ planId: p.id }))).toEqual({
      error: "Plano não encontrado ou arquivado.",
    });
    expect(await assignFeePlanAction(undefined, form({ merchantId: m, planId: p.id }))).toEqual({
      error: "Plano não encontrado ou arquivado.",
    });
    expect(await feesOf(m)).toEqual(FEES); // arquivar não mexe em quem já usa
  });

  it("exportação do histórico: CSV neutro contra injeção, sem segredo e registrada na auditoria", async () => {
    const adminId = await loginAs("admin");
    const m = await newMerchant(d, 1);
    const { id: planId } = await createFeePlan(plan({ name: '=HYPERLINK("http://x")' }), adminId);
    await updateFees(m, DEFAULT_FEES, adminId);
    await assignPlanToMerchant(m, planId, adminId);

    const res = await exportReq(m);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="historico-tarifas-${m}.csv"`);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await csvText(res);
    expect(text.startsWith("﻿")).toBe(true);
    const lines = text.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Vigente desde (Brasília);Pix recebido (%);Pix recebido fixo (R$);Pix enviado (%);Pix enviado fixo (R$);Plano;Alterado por",
    );
    expect(lines).toHaveLength(3); // mais novo primeiro
    expect(lines[1]).toMatch(/;1,99;0,50;0,10;1,50;"'=HYPERLINK\(""http:\/\/x""\)";admin1@vantri\.test$/);
    expect(lines[2]).toMatch(/;1,49;0,00;0,00;1,00;Personalizada;admin1@vantri\.test$/);
    expect(text).not.toContain(PASSWORD_HASH);

    const [log] = (await d.select().from(auditLog)).filter((r) => r.action === "export.fee_history");
    expect(log).toMatchObject({ actorUserId: adminId, meta: { merchantId: m, rows: 2 } });

    // Cliente fora do formato: 404 sem arquivo nem auditoria.
    expect((await exportReq("nao-e-uuid")).status).toBe(404);
    expect((await actions()).filter((a) => a === "export.fee_history")).toHaveLength(1);
  });

  it("a tela mostra os planos com o simulador e o histórico do cliente escolhido", async () => {
    const adminId = await loginAs("admin");
    const m = await newMerchant(d, 1);
    const { id: planId } = await createFeePlan(plan({ name: "Padrão 1,49", feeInBps: 149, feeInFixedCents: 0 }), adminId);
    const { id: oldId } = await createFeePlan(plan({ name: "Plano antigo" }), adminId);
    await archiveFeePlan(oldId, adminId);
    await assignPlanToMerchant(m, planId, adminId);

    const page = async (sp: Record<string, string>) =>
      renderToStaticMarkup(await TarifasPage({ searchParams: Promise.resolve(sp) }));

    // Sem valor: a venda de exemplo de R$ 197,00.
    const base = await page({});
    expect(base).toContain("Padrão 1,49");
    expect(base).toContain(brl(19_406));
    expect(base).toContain("Plano antigo"); // arquivado continua visível (separado)

    const html = await page({ valor: "1.000,00", cliente: m });
    expect(html).toContain(brl(100_000 - 1_490));
    expect(html).toContain(`/admin/tarifas/export?cliente=${m}`);
    expect(html).toContain("admin1@vantri.test"); // autor da mudança
    expect(html).not.toContain(PASSWORD_HASH);
  });
});
