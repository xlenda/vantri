import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "@/lib/auth/password";
import { lookupCnpj } from "@/lib/br/cnpj-lookup";
import { formatCnpj, isValidCnpj, isValidCpf, maskDocument } from "@/lib/br/documents";
import { decrypt, hmacHex, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, merchants, users } from "@/lib/db/schema";
import { simulator } from "@/lib/provider/simulator";
import {
  adminCreateMerchant,
  approveMerchant,
  reactivateMerchant,
  rejectMerchant,
  signupMerchant,
  suspendMerchant,
  updateFees,
} from "@/lib/services/merchants";
import { createTestDb } from "./helpers/db";

let d: Db;
let adminId: string;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.PIX_PROVIDER = "simulator";
  process.env.SIMULATOR_WEBHOOK_SECRET = "segredo-de-teste";
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  const [a] = await d
    .insert(users)
    .values({ email: "admin@vantri.test", passwordHash: "x", role: "admin" })
    .returning({ id: users.id });
  adminId = a.id;
});

afterEach(() => vi.restoreAllMocks());

const CPF = "52998224725";
const CNPJ = "11222333000181";

const cpfInput = (over: Record<string, unknown> = {}) => ({
  legalName: "Maria da Silva",
  tradeName: "Curso da Maria",
  documentType: "cpf",
  document: CPF,
  segment: "cursos",
  email: "maria@exemplo.com",
  password: "senha-bem-longa-123",
  ...over,
});

const cnpjInput = (over: Record<string, unknown> = {}) =>
  cpfInput({ legalName: "Escola Online LTDA", documentType: "cnpj", document: CNPJ, ...over });

// Admin não manda senha: ela é gerada.
const adminInput = (over: Record<string, unknown> = {}) => {
  const input: Record<string, unknown> = cpfInput(over);
  delete input.password;
  return input;
};

const lookupOk =(cnaes: string[], active = true) => async () =>
  ({ ok: true, legalName: "ESCOLA ONLINE LTDA", cnaes, active }) as const;

async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: { code?: string }) => e.code,
  );
}

const counts = async () => ({
  merchants: (await d.select().from(merchants)).length,
  users: (await d.select().from(users)).length - 1, // menos o admin
});

const actions = async () => (await d.select().from(auditLog)).map((r) => r.action);

describe("documents", () => {
  it("valida CPF e CNPJ pelo dígito verificador", () => {
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("52998224724")).toBe(false);
    expect(isValidCnpj("11222333000181")).toBe(true);
    expect(isValidCnpj("11222333000180")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
    // CNPJ alfanumérico (Receita, desde jul/2026): letra vale código ASCII − 48; DVs continuam numéricos.
    expect(isValidCnpj("12ABC34501DE35")).toBe(true);
    expect(isValidCnpj("12ABC34501DE36")).toBe(false);
    expect(isValidCnpj("12ABC34501DEA5")).toBe(false);
    expect(isValidCpf("5299822472A")).toBe(false);
  });

  it("mascara CPF e CNPJ", () => {
    expect(maskDocument("12345678901")).toBe("***.456.789-**");
    expect(maskDocument("12345678000195")).toBe("12.345.678/****-**");
    expect(maskDocument("12.abc.345/01de-35")).toBe("12.ABC.345/****-**");
  });

  it("formatCnpj mostra o CNPJ completo e nunca outro documento por inteiro", () => {
    expect(formatCnpj("11222333000181")).toBe("11.222.333/0001-81");
    expect(formatCnpj("12.abc.345/01de-35")).toBe("12.ABC.345/01DE-35");
    expect(formatCnpj("52998224725")).toBe("***.982.247-**");
  });

  it("hmacHex é determinístico, separado por finalidade e não é sha256 puro", () => {
    expect(hmacHex("document", CPF)).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex("document", CPF)).toBe(hmacHex("document", CPF));
    expect(hmacHex("document", CPF)).not.toBe(hmacHex("outra", CPF));
    expect(hmacHex("document", CPF)).not.toBe(sha256Hex(CPF));
  });
});

describe("lookupCnpj", () => {
  const brasilApi = (status: number, body: unknown) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

  it("lê razão social, CNAEs (com zero à esquerda) e situação", async () => {
    const fetcher = brasilApi(200, {
      razao_social: "ESCOLA ONLINE LTDA",
      cnae_fiscal: 8599604,
      cnaes_secundarios: [{ codigo: 111301 }, { codigo: 9200399 }],
      descricao_situacao_cadastral: "ATIVA",
    });
    expect(await lookupCnpj("11.222.333/0001-81", fetcher)).toEqual({
      ok: true,
      legalName: "ESCOLA ONLINE LTDA",
      cnaes: ["8599604", "0111301", "9200399"],
      active: true,
    });
    expect(String(fetcher.mock.calls[0][0])).toBe("https://brasilapi.com.br/api/cnpj/v1/11222333000181");
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    await lookupCnpj("12.abc.345/01de-35", fetcher);
    expect(String(fetcher.mock.calls[1][0])).toBe("https://brasilapi.com.br/api/cnpj/v1/12ABC34501DE35");
  });

  it("devolve ok:false em 404, erro de rede ou corpo inesperado", async () => {
    expect(await lookupCnpj(CNPJ, brasilApi(404, { message: "CNPJ não encontrado" }))).toEqual({ ok: false });
    expect(await lookupCnpj(CNPJ, brasilApi(200, { razao_social: "X" }))).toEqual({ ok: false });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await lookupCnpj(CNPJ, down)).toEqual({ ok: false });
  });
});

describe("signupMerchant", () => {
  it("signup rejects betting CNAE (principal ou secundário)", async () => {
    const lookup = lookupOk(["9200399"]);
    await expect(signupMerchant(cnpjInput(), { lookup })).rejects.toMatchObject({
      code: "betting_cnae",
      message: "Não atendemos apostas.",
    });
    const secundario = lookupOk(["8599604", "92.00-3-01"]);
    expect(await errorCode(signupMerchant(cnpjInput(), { lookup: secundario }))).toBe("betting_cnae");
    expect(await counts()).toEqual({ merchants: 0, users: 0 });
  });

  it("signup rejects inactive CNPJ", async () => {
    expect(await errorCode(signupMerchant(cnpjInput(), { lookup: lookupOk(["8599604"], false) }))).toBe(
      "cnpj_inactive",
    );
    expect(await counts()).toEqual({ merchants: 0, users: 0 });
  });

  it("signup rejects segment 'apostas'", async () => {
    expect(await errorCode(signupMerchant(cpfInput({ segment: "apostas" })))).toBe("segment_not_allowed");
    expect(await counts()).toEqual({ merchants: 0, users: 0 });
  });

  it("signup rejects invalid document", async () => {
    expect(await errorCode(signupMerchant(cpfInput({ document: "111.111.111-11" })))).toBe("invalid_document");
    expect(await errorCode(signupMerchant(cpfInput({ document: "5299822472a5" })))).toBe("invalid_document");
    expect(await errorCode(signupMerchant(cnpjInput({ document: CPF })))).toBe("invalid_document");
  });

  it("signup ignores extra fields (zod strict rejeita)", async () => {
    const input = cpfInput({ role: "admin", status: "active", fee_in_bps: 0 });
    expect(await errorCode(signupMerchant(input))).toBe("invalid_request");
    expect(await errorCode(signupMerchant(cpfInput({ password: "curta" })))).toBe("invalid_request");
    expect(await counts()).toEqual({ merchants: 0, users: 0 });
  });

  it("signup stores document encrypted", async () => {
    const { merchantId, userId } = await signupMerchant(cpfInput({ document: "529.982.247-25" }));
    const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(m.documentEnc).not.toContain(CPF);
    expect(decrypt(m.documentEnc)).toBe(CPF);
    expect(m.documentHash).toBe(hmacHex("document", CPF));
    expect(m).toMatchObject({ status: "pending", needsManualReview: false, providerAccountId: null, feeInBps: 149 });
    const [u] = await d.select().from(users).where(eq(users.id, userId));
    expect(u).toMatchObject({ role: "merchant", merchantId, mustChangePassword: false });
    expect(await verifyPassword(u.passwordHash, "senha-bem-longa-123")).toBe(true);
  });

  it("signup aceita CNPJ alfanumérico e grava a forma normalizada", async () => {
    const lookup = vi.fn(lookupOk(["8599604"]));
    const { merchantId } = await signupMerchant(cnpjInput({ document: "12.abc.345/01de-35" }), { lookup });
    expect(lookup).toHaveBeenCalledWith("12ABC34501DE35");
    const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(decrypt(m.documentEnc)).toBe("12ABC34501DE35");
    expect(m.documentHash).toBe(hmacHex("document", "12ABC34501DE35"));

    const upper = cnpjInput({ document: "12ABC34501DE35", email: "outra@exemplo.com" });
    expect(await errorCode(signupMerchant(upper, { lookup }))).toBe("document_taken");
  });

  it("signup with lookup down sets needs_manual_review", async () => {
    const { merchantId } = await signupMerchant(cnpjInput(), { lookup: async () => ({ ok: false }) });
    const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(m).toMatchObject({ status: "pending", needsManualReview: true });

    const ok = await signupMerchant(cnpjInput({ document: "11444777000161", email: "b@exemplo.com" }), {
      lookup: lookupOk(["8599604"]),
    });
    const [m2] = await d.select().from(merchants).where(eq(merchants.id, ok.merchantId));
    expect(m2.needsManualReview).toBe(false);
  });

  it("signup normaliza e-mail e recusa documento ou e-mail repetido, inclusive em corrida", async () => {
    const { userId } = await signupMerchant(cpfInput({ email: "  Maria@Exemplo.COM " }));
    const [u] = await d.select().from(users).where(eq(users.id, userId));
    expect(u.email).toBe("maria@exemplo.com");

    expect(await errorCode(signupMerchant(cpfInput({ email: "outra@exemplo.com" })))).toBe("document_taken");
    expect(await errorCode(signupMerchant(cnpjInput({ email: "MARIA@exemplo.com" }), { lookup: lookupOk([]) }))).toBe(
      "email_taken",
    );

    const raced = await Promise.allSettled([
      signupMerchant(cnpjInput({ email: "a@corrida.com" }), { lookup: lookupOk([]) }),
      signupMerchant(cnpjInput({ email: "b@corrida.com" }), { lookup: lookupOk([]) }),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = raced.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.code).toBe("document_taken");
    expect(await counts()).toEqual({ merchants: 2, users: 2 });
  });
});

describe("admin", () => {
  it("approve calls provider.createAccount and sets active + provider_account_id", async () => {
    const spy = vi.spyOn(simulator, "createAccount");
    const { merchantId } = await signupMerchant(cpfInput());
    await approveMerchant(merchantId, adminId);

    expect(spy).toHaveBeenCalledWith({
      merchantId,
      legalName: "Maria da Silva",
      document: CPF,
      documentType: "cpf",
      email: "maria@exemplo.com",
    });
    const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(m.status).toBe("active");
    expect(m.providerAccountId).toMatch(/^sim_acc_/);
    expect(m.approvedAt).toBeInstanceOf(Date);
    const [log] = await d.select().from(auditLog);
    expect(log).toMatchObject({ actorUserId: adminId, action: "merchant.approve", meta: { merchantId } });

    expect(await errorCode(approveMerchant(merchantId, adminId))).toBe("invalid_status");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("approve com provedor fora do ar deixa o lojista pending", async () => {
    vi.spyOn(simulator, "createAccount").mockRejectedValueOnce(new Error("provedor fora do ar"));
    const { merchantId } = await signupMerchant(cpfInput());
    await expect(approveMerchant(merchantId, adminId)).rejects.toMatchObject({
      code: "provider_error",
      message: "Não foi possível abrir a conta no parceiro. Tente de novo.",
      cause: { message: "provedor fora do ar" },
    });
    const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(m).toMatchObject({ status: "pending", providerAccountId: null, approvedAt: null });
    expect(await actions()).toEqual([]);
  });

  it("CNPJ em revisão manual: a aprovação consulta a Receita de novo e aplica CNAE 9200 e inativo", async () => {
    const spy = vi.spyOn(simulator, "createAccount");
    const down = vi.fn(async () => ({ ok: false }) as const);
    const { merchantId } = await signupMerchant(cnpjInput(), { lookup: down });
    const row = async () => (await d.select().from(merchants).where(eq(merchants.id, merchantId)))[0];

    // A Receita voltou e o CNPJ é de apostas: recusado mesmo com a confirmação manual marcada.
    const betting = vi.fn(lookupOk(["8599604", "9200399"]));
    expect(await errorCode(approveMerchant(merchantId, adminId, { lookup: betting, manualCheck: true }))).toBe("betting_cnae");
    expect(betting).toHaveBeenCalledWith(CNPJ);
    expect(await errorCode(approveMerchant(merchantId, adminId, { lookup: lookupOk(["8599604"], false) }))).toBe(
      "cnpj_inactive",
    );
    // Continua fora do ar: sem a confirmação do admin, não aprova.
    expect(await errorCode(approveMerchant(merchantId, adminId, { lookup: down }))).toBe("manual_check_required");
    expect(await row()).toMatchObject({ status: "pending", needsManualReview: true, providerAccountId: null });
    expect(spy).not.toHaveBeenCalled();
    expect(await actions()).toEqual([]);

    // A Receita responde e está tudo certo: aprova sem a confirmação e limpa a revisão.
    await approveMerchant(merchantId, adminId, { lookup: lookupOk(["8599604"]) });
    expect(await row()).toMatchObject({ status: "active", needsManualReview: false });
    expect((await d.select().from(auditLog))[0].meta).toEqual({ merchantId, cnpjCheck: "receita" });
  });

  it("Receita fora do ar também na aprovação: só com a confirmação manual, registrada no audit_log", async () => {
    const down = async () => ({ ok: false }) as const;
    const { merchantId } = await signupMerchant(cnpjInput(), { lookup: down });
    await approveMerchant(merchantId, adminId, { lookup: down, manualCheck: true });
    const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(m).toMatchObject({ status: "active", needsManualReview: true }); // a Receita nunca confirmou este CNPJ
    expect((await d.select().from(auditLog))[0].meta).toEqual({ merchantId, cnpjCheck: "manual" });

    // Sem revisão manual (CPF, ou CNPJ conferido no cadastro), a aprovação não consulta nada.
    const lookup = vi.fn(down);
    const cpf = (await signupMerchant(cpfInput({ email: "cpf@exemplo.com", document: "11144477735" }))).merchantId;
    const ok = (await signupMerchant(cnpjInput({ email: "ok@exemplo.com", document: "11444777000161" }), { lookup: lookupOk([]) }))
      .merchantId;
    await approveMerchant(cpf, adminId, { lookup });
    await approveMerchant(ok, adminId, { lookup });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("adminCreateMerchant returns temp password that verifies and must_change_password=true", async () => {
    const spy = vi.spyOn(simulator, "createAccount");
    const r = await adminCreateMerchant(adminInput({ email: " Cliente@Exemplo.com" }), adminId);

    expect(r.email).toBe("cliente@exemplo.com");
    expect(r.tempPassword).toMatch(/^[0-9A-Za-z]{16}$/);
    const [u] = await d.select().from(users).where(eq(users.email, r.email));
    expect(u).toMatchObject({ role: "merchant", merchantId: r.merchantId, mustChangePassword: true });
    expect(await verifyPassword(u.passwordHash, r.tempPassword)).toBe(true);

    const [m] = await d.select().from(merchants).where(eq(merchants.id, r.merchantId));
    expect(m.status).toBe("active");
    expect(m.providerAccountId).toMatch(/^sim_acc_/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await actions()).toEqual(["merchant.create"]);

    // Senha no input do admin é campo desconhecido.
    expect(await errorCode(adminCreateMerchant(cpfInput({ email: "x@y.com" }), adminId))).toBe("invalid_request");
  });

  it("adminCreateMerchant com provedor fora do ar não grava nada", async () => {
    vi.spyOn(simulator, "createAccount").mockRejectedValueOnce(new Error("provedor fora do ar"));
    expect(await errorCode(adminCreateMerchant(adminInput(), adminId))).toBe("provider_error");
    expect(await counts()).toEqual({ merchants: 0, users: 0 });
  });

  it("adminCreateMerchant nunca ativa CNPJ sem a checagem de apostas", async () => {
    const spy = vi.spyOn(simulator, "createAccount");
    const input = adminInput({ legalName: "Escola Online LTDA", documentType: "cnpj", document: CNPJ });

    const betting = { lookup: lookupOk(["8599604", "9200399"]) };
    expect(await errorCode(adminCreateMerchant(input, adminId, betting))).toBe("betting_cnae");

    const down = { lookup: async () => ({ ok: false }) as const };
    await expect(adminCreateMerchant(input, adminId, down)).rejects.toMatchObject({
      code: "cnpj_lookup_unavailable",
      message: "Não foi possível consultar o CNPJ na Receita agora. Tente de novo em instantes.",
    });

    expect(spy).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ merchants: 0, users: 0 });
    expect(await actions()).toEqual([]);

    const ok = await adminCreateMerchant(input, adminId, { lookup: lookupOk(["8599604"]) });
    const [m] = await d.select().from(merchants).where(eq(merchants.id, ok.merchantId));
    expect(m).toMatchObject({ status: "active", needsManualReview: false });
  });

  it("reject, suspend e reactivate só a partir do status certo", async () => {
    const a = (await signupMerchant(cpfInput())).merchantId;
    const b = (await signupMerchant(cnpjInput({ email: "b@exemplo.com" }), { lookup: lookupOk([]) })).merchantId;
    const status = async (id: string) =>
      (await d.select({ s: merchants.status }).from(merchants).where(eq(merchants.id, id)))[0].s;

    expect(await errorCode(suspendMerchant(a, adminId))).toBe("invalid_status");
    await rejectMerchant(a, adminId);
    expect(await status(a)).toBe("rejected");
    expect(await errorCode(approveMerchant(a, adminId))).toBe("invalid_status");

    await approveMerchant(b, adminId);
    await suspendMerchant(b, adminId);
    expect(await status(b)).toBe("suspended");
    await reactivateMerchant(b, adminId);
    expect(await status(b)).toBe("active");

    expect(await errorCode(rejectMerchant("00000000-0000-4000-8000-000000000000", adminId))).toBe("not_found");
    expect(await errorCode(rejectMerchant("nao-e-uuid", adminId))).toBe("not_found");
    expect(await actions()).toEqual([
      "merchant.reject",
      "merchant.approve",
      "merchant.suspend",
      "merchant.reactivate",
    ]);
  });

  it("updateFees rejects 10001 bps", async () => {
    const { merchantId } = await signupMerchant(cpfInput());
    const fees = { feeInBps: 199, feeInFixedCents: 50, feeOutBps: 0, feeOutFixedCents: 150 };

    expect(await errorCode(updateFees(merchantId, { ...fees, feeInBps: 10001 }, adminId))).toBe("invalid_request");
    expect(await errorCode(updateFees(merchantId, { ...fees, feeOutFixedCents: 100001 }, adminId))).toBe(
      "invalid_request",
    );
    expect(await errorCode(updateFees(merchantId, { ...fees, feeInBps: 1.5 }, adminId))).toBe("invalid_request");
    expect(await errorCode(updateFees(merchantId, { ...fees, feeOutBps: -1 }, adminId))).toBe("invalid_request");
    expect(await actions()).toEqual([]);

    await updateFees(merchantId, fees, adminId);
    const [m] = await d.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(m).toMatchObject(fees);
    const [log] = await d.select().from(auditLog);
    expect(log).toMatchObject({ actorUserId: adminId, action: "merchant.update_fees", meta: { merchantId, ...fees } });
  });
});
