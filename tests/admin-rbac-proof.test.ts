import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { generate } from "otplib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as exportAccess } from "@/app/admin/acessos/export/route";
import { decideApprovalAction } from "@/app/admin/aprovacoes/actions";
import { GET as exportAudit } from "@/app/admin/auditoria/export/route";
import {
  createMerchantAction,
  merchantStatusAction,
  requestBalanceAdjustmentAction,
  updateFeesAction,
} from "@/app/admin/clientes/actions";
import { setRoleAction, userOpAction } from "@/app/admin/equipe/actions";
import { addMedNoteAction, closeMedAction, openTestMedAction } from "@/app/admin/med/actions";
import { repollPayoutAction, requestPayoutReversalAction } from "@/app/admin/saques/actions";
import { archiveFeePlanAction, assignFeePlanAction, createFeePlanAction } from "@/app/admin/tarifas/actions";
import { GET as exportTransactions } from "@/app/admin/transacoes/export/route";
import { disableEndpointAction, resendFailedBatchAction, resendOneAction } from "@/app/admin/webhooks/actions";
import { verifyPassword } from "@/lib/auth/password";
import type { AdminRole } from "@/lib/auth/perms";
import { encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import {
  charges,
  feeHistory,
  feePlans,
  medCases,
  merchants,
  payouts,
  pendingApprovals,
  sessions,
  users,
  webhookDeliveries,
  webhookEndpoints,
} from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import { requestApproval } from "@/lib/services/admin/approvals";
import { applyMedOpened } from "@/lib/services/med";
import { createPayout } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Prova do controle no servidor (T16): POST forjado direto em cada Server Action / route handler sensível do admin,
// com formulário válido e até código 2FA válido, por quem NÃO tem a permissão. O guarda é o de verdade (sessão no
// banco → checkAccess → requireAdmin → pode) e o step-up também; só o cookie da requisição é simulado. O critério
// é o banco inteiro: a impressão digital de TODAS as tabelas antes e depois tem de ser igual.

const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vantri_session" && cookieJar.token ? { name, value: cookieJar.token } : undefined),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
// Perto da hora real (o timer do PGlite estoura com o Date meses à frente); meio do passo de 30 s.
const NOW = Math.floor(Date.now() / 30_000) * 30 + 15;
const NOT_FOUND = /^NEXT_HTTP_ERROR_FALLBACK;404/;

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
  vi.stubEnv("PIX_PROVIDER", "simulator");
  d = await createTestDb();
  setDb(d);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Código novo do app (o mesmo segredo para toda a equipe): o relógio anda um passo a cada chamada. */
async function freshCode(): Promise<string> {
  step += 1;
  vi.setSystemTime((NOW + step * 30) * 1000);
  return generate({ secret: SECRET, epoch: NOW + step * 30 });
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/** "ok" (não lançou) ou o digest do erro do Next (notFound/redirect). */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { digest?: string }) => e.digest ?? String(e),
  );

/**
 * Impressão digital do banco: todas as tabelas do schema public, linha a linha. `actor`: ignora só o passo do código
 * 2FA dessa pessoa (e o contador do limite), para as ações em que o papel passa e quem barra é o serviço depois do
 * step-up — o código consumido é o anti-replay dela, não um efeito da ação.
 */
async function fingerprint(actor?: string): Promise<string> {
  const rows = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;
  const tables = rows(await d.execute(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`));
  const out: Record<string, unknown> = {};
  for (const { tablename } of tables as { tablename: string }[]) {
    if (actor && tablename === "rate_limits") continue;
    const all = rows(await d.execute(sql.raw(`select * from "${tablename}" order by 1`)));
    out[tablename] = all.map((r) => (tablename === "users" && r.id === actor ? { ...r, totp_last_step: "(passo de quem opera)" } : r));
  }
  return JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function staff(adminRole: AdminRole) {
  const [u] = await d
    .insert(users)
    .values({
      email: `${adminRole}${++seq}@vantri.test`,
      passwordHash: "x",
      role: "admin",
      adminRole,
      totpSecretEnc: encrypt(SECRET),
      totpEnabled: true,
    })
    .returning({ id: users.id });
  const token = randomToken();
  await d
    .insert(sessions)
    .values({ id: sha256Hex(token), userId: u.id, mfaPassed: true, expiresAt: new Date(Date.now() + 86_400_000) });
  return { id: u.id, as: () => void (cookieJar.token = token) };
}

async function merchantUser(merchantId: string) {
  const [u] = await d
    .insert(users)
    .values({
      email: `loja${++seq}@exemplo.com`,
      passwordHash: "x",
      role: "merchant",
      merchantId,
      totpSecretEnc: encrypt(SECRET),
      totpEnabled: true,
    })
    .returning({ id: users.id });
  await d.insert(sessions).values({ id: sha256Hex(randomToken()), userId: u.id, mfaPassed: true, expiresAt: new Date(Date.now() + 86_400_000) });
  return u.id;
}

/** Cenário completo: alvos VÁLIDOS para cada ação, para que a ação gravasse de verdade se o guarda falhasse. */
async function world() {
  const [boss, second, op, sup] = [await staff("admin"), await staff("admin"), await staff("operador"), await staff("suporte")];

  const active = await newMerchant(d, ++seq);
  await d
    .update(merchants)
    .set({ status: "active", approvedAt: new Date(), providerAccountId: `sim_acc_${seq}` })
    .where(eq(merchants.id, active));
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId: active, amountCents: 100_000, bucket: "available", kind: "cash_in", refType: "charge", refId: randomUUID() },
    ]),
  );
  const lojista = await merchantUser(active);

  // Pendente com CPF de verdade e usuário: aprovar daria certo (simulador abre a conta) se o guarda falhasse.
  const pending = await newMerchant(d, ++seq);
  await d.update(merchants).set({ documentType: "cpf", documentEnc: encrypt("52998224725") }).where(eq(merchants.id, pending));
  await merchantUser(pending);

  const suspended = await newMerchant(d, ++seq);
  await d.update(merchants).set({ status: "suspended", approvedAt: new Date() }).where(eq(merchants.id, suspended));

  // Saque sem resposta do parceiro (debitado, em processamento, sem id lá): reenviar ou estornar mexeria nele.
  vi.spyOn(simulator, "createPayout").mockRejectedValueOnce(new Error("ECONNRESET"));
  const { payout } = await createPayout(active, { amount: 10_000, pix_key: "52998224725", pix_key_type: "cpf" }, `prova-${seq}`);

  const [plan] = await d
    .insert(feePlans)
    .values({ name: "Plano Escala", feeInBps: 99, feeInFixedCents: 10, feeOutBps: 0, feeOutFixedCents: 50 })
    .returning({ id: feePlans.id });
  const { id: approvalId } = await requestApproval(
    "balance_adjustment",
    { merchantId: active, amountCents: 5_000, reason: "Acerto de tarifa de outubro" },
    boss.id,
  );

  const [endpoint] = await d
    .insert(webhookEndpoints)
    .values({ merchantId: active, url: "https://hooks.exemplo.com/vantri", secretEnc: encrypt("whsec_x"), events: ["payout.completed"] })
    .returning({ id: webhookEndpoints.id });
  const [delivery] = await d
    .insert(webhookDeliveries)
    .values({ endpointId: endpoint.id, eventId: "evt_prova", eventType: "payout.completed", payload: {}, status: "failed", attempts: 7 })
    .returning({ id: webhookDeliveries.id });

  const [charge] = await d
    .insert(charges)
    .values({
      merchantId: active,
      txid: `tx${seq}`,
      externalRef: `ref${seq}`,
      amountCents: 10_000,
      feeCents: 149,
      status: "paid",
      brcode: "000201",
      providerChargeId: `sim_ch_${seq}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      paidAt: new Date(),
    })
    .returning({ id: charges.id, providerChargeId: charges.providerChargeId });
  expect(await applyMedOpened(simulator.simulateMed(charge.providerChargeId, 1_000))).toBe("opened");
  const [med] = await d.select({ id: medCases.id }).from(medCases).where(eq(medCases.chargeId, charge.id));

  return {
    boss,
    second,
    op,
    sup,
    active,
    lojista,
    pending,
    suspended,
    payoutId: payout.id,
    planId: plan.id,
    approvalId,
    endpointId: endpoint.id,
    deliveryId: delivery.id,
    chargeId: charge.id,
    medCaseId: med.id,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const FEES = { feeInPercent: "9,99", feeInFixed: "9,00", feeOutPercent: "9,99", feeOutFixed: "9,00" };
let actingAs = ""; // id de quem forja (o "virar admin" tenta promover a si mesmo)

// Cada ação sensível, com um formulário que funcionaria para quem tem a permissão.
const FORGED: Record<string, (w: World) => Promise<unknown>> = {
  "mudar taxa (taxas:editar)": async (w) =>
    updateFeesAction(undefined, form({ merchantId: w.pending, ...FEES, reason: "Forjado", code: await freshCode() })),
  "aprovar cliente (clientes:cadastro)": async (w) =>
    merchantStatusAction(undefined, form({ merchantId: w.pending, op: "approve", manualCheck: "", reason: "", code: await freshCode() })),
  "pedir reativação de cliente (clientes:cadastro)": async (w) =>
    merchantStatusAction(
      undefined,
      form({ merchantId: w.suspended, op: "reactivate", manualCheck: "", reason: "Pedido forjado", code: await freshCode() }),
    ),
  "criar cliente (clientes:cadastro)": async () =>
    createMerchantAction(
      undefined,
      form({ legalName: "Forjada LTDA", tradeName: "Forjada", documentType: "cpf", document: "11144477735", segment: "cursos", email: "forjada@exemplo.com" }),
    ),
  "pedir ajuste de saldo (dinheiro:mover)": async (w) =>
    requestBalanceAdjustmentAction(
      undefined,
      form({ merchantId: w.active, direction: "credito", amount: "1000,00", reason: "Pedido forjado", code: await freshCode() }),
    ),
  "pedir estorno de saque (dinheiro:mover)": async (w) =>
    requestPayoutReversalAction(undefined, form({ payoutId: w.payoutId, reason: "Pedido forjado", code: await freshCode() })),
  "aprovar quatro olhos (quatro_olhos:aprovar)": async (w) =>
    decideApprovalAction(undefined, form({ approvalId: w.approvalId, op: "approve", reason: "", code: await freshCode() })),
  "recusar quatro olhos (quatro_olhos:aprovar)": async (w) =>
    decideApprovalAction(undefined, form({ approvalId: w.approvalId, op: "reject", reason: "Recusa forjada", code: await freshCode() })),
  "virar admin (equipe:gerir)": async () =>
    setRoleAction(undefined, form({ userId: actingAs, role: "admin", code: await freshCode() })),
  "criar plano de tarifa (tarifas:gerir)": async () =>
    createFeePlanAction(undefined, form({ name: "Plano forjado", ...FEES })),
  "aplicar plano (tarifas:gerir)": async (w) =>
    assignFeePlanAction(undefined, form({ merchantId: w.pending, planId: w.planId, reason: "", code: await freshCode() })),
  "arquivar plano (tarifas:gerir)": async (w) => archiveFeePlanAction(undefined, form({ planId: w.planId })),
  "consultar/reenviar saque (saques:operar)": async (w) =>
    repollPayoutAction(undefined, form({ payoutId: w.payoutId, code: await freshCode() })),
  "reenviar webhook (webhooks:operar)": async (w) => resendOneAction(undefined, form({ id: w.deliveryId })),
  "reenviar webhooks em lote (webhooks:operar)": async () =>
    resendFailedBatchAction(undefined, form({ cliente: "", endpoint: "", evento: "", de: "", ate: "" })),
  "desativar endpoint (webhooks:operar)": async (w) => disableEndpointAction(undefined, form({ id: w.endpointId })),
  "abrir MED de teste (med:operar)": async (w) => openTestMedAction(undefined, form({ chargeId: w.chargeId, amount: "1,00" })),
  "encerrar MED (med:operar)": async (w) =>
    closeMedAction(undefined, form({ caseId: w.medCaseId, outcome: "payer_refunded" })),
  "anotar MED (med:operar)": async (w) => addMedNoteAction(undefined, form({ caseId: w.medCaseId, note: "Nota forjada" })),
  "exportar transações (transacoes:exportar)": async () =>
    exportTransactions(new Request("http://localhost/admin/transacoes/export?tipo=saques")),
  "exportar auditoria (auditoria:exportar)": async () => exportAudit(new Request("http://localhost/admin/auditoria/export")),
  "exportar acessos (acessos:exportar)": async () => exportAccess(new Request("http://localhost/admin/acessos/export")),
};

const SUPORTE_SEM_PERMISSAO = Object.keys(FORGED);
const OPERADOR_SEM_PERMISSAO = [
  "aprovar quatro olhos (quatro_olhos:aprovar)",
  "recusar quatro olhos (quatro_olhos:aprovar)",
  "virar admin (equipe:gerir)",
];

describe.each([
  ["suporte", SUPORTE_SEM_PERMISSAO],
  ["operador", OPERADOR_SEM_PERMISSAO],
] as const)("%s forjando o POST (com código 2FA válido): 404 e o banco inteiro igual", (role, names) => {
  it.each(names)("%s", async (name) => {
    const w = await world();
    const who = role === "suporte" ? w.sup : w.op;
    actingAs = who.id;
    who.as();
    const before = await fingerprint();
    expect(await outcome(FORGED[name](w))).toMatch(NOT_FOUND);
    expect(await fingerprint()).toBe(before);
  });
});

describe("o papel passa, o serviço barra (depois do step-up)", () => {
  it("suporte e operador zerando 2FA / senha / sessões de uma conta da EQUIPE: 404 e nada além do passo do próprio código", async () => {
    const w = await world();
    for (const who of [w.sup, w.op]) {
      who.as();
      for (const op of ["reset2fa", "senha", "sessoes", "desbloquear"]) {
        const before = await fingerprint(who.id);
        expect(await outcome(userOpAction(undefined, form({ userId: w.boss.id, op, reason: "", code: await freshCode() })))).toMatch(
          NOT_FOUND,
        );
        expect(await fingerprint(who.id)).toBe(before);
      }
    }
  });

  it("admin aprovando o próprio pedido de quatro olhos: recusado, nada aplicado", async () => {
    const w = await world();
    w.boss.as();
    const before = await fingerprint(w.boss.id);
    expect(await decideApprovalAction(undefined, form({ approvalId: w.approvalId, op: "approve", reason: "", code: await freshCode() }))).toEqual({
      error: "Quem pediu não aprova o próprio pedido: outro administrador precisa aprovar.",
    });
    expect(await fingerprint(w.boss.id)).toBe(before);
  });

  it("controle positivo: outro admin aprova e o saldo muda (a impressão digital pega qualquer gravação)", async () => {
    const w = await world();
    const balance = (await getBalance(w.active)).available;
    w.second.as();
    const before = await fingerprint(w.second.id);
    expect(await decideApprovalAction(undefined, form({ approvalId: w.approvalId, op: "approve", reason: "", code: await freshCode() }))).toEqual({
      ok: "Pedido aprovado e aplicado.",
    });
    expect(await fingerprint(w.second.id)).not.toBe(before);
    expect((await getBalance(w.active)).available).toBe(balance + 5_000);
  });

  it("operador com permissão de pedir: só nasce o pedido; saldo, saque, taxa, plano e status ficam iguais", async () => {
    const w = await world();
    const effects = async () =>
      JSON.stringify([
        await d.select().from(merchants).orderBy(merchants.id),
        (await getBalance(w.active)).available,
        await d.select().from(feeHistory),
        await d.select({ id: payouts.id, status: payouts.status }).from(payouts).orderBy(payouts.id),
      ]);
    const before = await effects();
    w.op.as();
    // Em sequência: o código 2FA vale só no passo de 30 s em que é gerado.
    const asks: Array<() => Promise<unknown>> = [
      async () =>
        requestBalanceAdjustmentAction(
          undefined,
          form({ merchantId: w.active, direction: "credito", amount: "1000,00", reason: "Acerto pedido", code: await freshCode() }),
        ),
      async () =>
        requestPayoutReversalAction(undefined, form({ payoutId: w.payoutId, reason: "Parceiro sem resposta", code: await freshCode() })),
      async () => updateFeesAction(undefined, form({ merchantId: w.active, ...FEES, reason: "Renegociação", code: await freshCode() })),
      async () =>
        assignFeePlanAction(undefined, form({ merchantId: w.active, planId: w.planId, reason: "Migração de plano", code: await freshCode() })),
      async () =>
        merchantStatusAction(
          undefined,
          form({ merchantId: w.suspended, op: "reactivate", manualCheck: "", reason: "Regularizou", code: await freshCode() }),
        ),
    ];
    for (const ask of asks) expect(await ask()).toMatchObject({ ok: expect.stringMatching(/[Pp]edido/) });
    expect(await effects()).toBe(before);
    const kinds = (await d.select().from(pendingApprovals).where(eq(pendingApprovals.requestedBy, w.op.id))).map((a) => a.kind).sort();
    expect(kinds).toEqual(["balance_adjustment", "fee_change", "fee_change", "merchant_reactivate", "payout_reversal"]);
  });

  it("plano aplicado a cliente ativo vira pedido com o plano junto; aprovado por outro admin, vale e o histórico guarda o plano", async () => {
    const w = await world();
    w.op.as();
    expect(await assignFeePlanAction(undefined, form({ merchantId: w.active, planId: w.planId, reason: "", code: "" }))).toEqual({
      error: "Escreva o motivo (de 3 a 500 caracteres).",
    });
    expect(
      await assignFeePlanAction(undefined, form({ merchantId: w.active, planId: w.planId, reason: "Migração de plano", code: await freshCode() })),
    ).toMatchObject({ ok: expect.stringContaining("pedido de troca de plano enviado") });
    const [a] = await d.select().from(pendingApprovals).where(eq(pendingApprovals.kind, "fee_change"));
    expect(a.payload).toMatchObject({ planId: w.planId, feeInBps: 99 });
    w.second.as();
    expect(await decideApprovalAction(undefined, form({ approvalId: a.id, op: "approve", reason: "", code: await freshCode() }))).toEqual({
      ok: "Pedido aprovado e aplicado.",
    });
    const [m] = await d.select().from(merchants).where(eq(merchants.id, w.active));
    expect(m).toMatchObject({ feeInBps: 99, feeInFixedCents: 10, feeOutBps: 0, feeOutFixedCents: 50 });
    expect(await d.select().from(feeHistory)).toEqual([expect.objectContaining({ merchantId: w.active, planId: w.planId })]);

    // Pedido com planId e taxas que não são as do plano: valem as do plano (o histórico nunca atribui taxa avulsa a um plano).
    const forged = { merchantId: w.active, feeInBps: 9_999, feeInFixedCents: 0, feeOutBps: 9_999, feeOutFixedCents: 0 };
    const { id } = await requestApproval("fee_change", { ...forged, planId: w.planId, reason: "Plano de novo" }, w.op.id);
    const [again] = await d.select().from(pendingApprovals).where(eq(pendingApprovals.id, id));
    expect(again.payload).toEqual({ feeInBps: 99, feeInFixedCents: 10, feeOutBps: 0, feeOutFixedCents: 50, planId: w.planId });
    await expect(
      requestApproval("fee_change", { ...forged, planId: randomUUID(), reason: "Plano inexistente" }, w.op.id),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("pedido de quem perdeu o papel depois de pedir não vale: recusado na aprovação, nada aplicado", async () => {
    const w = await world();
    w.op.as();
    await requestBalanceAdjustmentAction(
      undefined,
      form({ merchantId: w.active, direction: "credito", amount: "500,00", reason: "Acerto pedido", code: await freshCode() }),
    );
    const [a] = await d.select().from(pendingApprovals).where(eq(pendingApprovals.requestedBy, w.op.id));
    await d.update(users).set({ adminRole: "suporte" }).where(eq(users.id, w.op.id)); // rebaixado
    const balance = (await getBalance(w.active)).available;
    w.second.as();
    expect(await decideApprovalAction(undefined, form({ approvalId: a.id, op: "approve", reason: "", code: await freshCode() }))).toEqual({
      error: "Quem pediu não tem mais permissão para este pedido. Recuse-o.",
    });
    expect((await getBalance(w.active)).available).toBe(balance);
  });
});

describe("tomada de conta (senha + 2FA na mesma conta) só por quatro olhos", () => {
  it("suporte zera o 2FA do lojista, mas senha nova nessa conta é recusada; pede recuperação; só outro admin aprova e recebe a senha", async () => {
    const w = await world();
    w.sup.as();
    expect(await userOpAction(undefined, form({ userId: w.lojista, op: "reset2fa", reason: "", code: await freshCode() }))).toMatchObject({
      ok: expect.stringContaining("2FA resetado"),
    });
    const before = await fingerprint(w.sup.id);
    expect(await userOpAction(undefined, form({ userId: w.lojista, op: "senha", reason: "", code: await freshCode() }))).toEqual({
      error: expect.stringContaining("Esta conta está sem 2FA"),
    });
    expect(await fingerprint(w.sup.id)).toBe(before); // nenhuma senha nova; só o passo do código de quem opera andou

    expect(
      await userOpAction(
        undefined,
        form({ userId: w.lojista, op: "recuperar", reason: "Perdeu celular e senha; identidade conferida", code: await freshCode() }),
      ),
    ).toMatchObject({ ok: expect.stringContaining("Pedido de recuperação enviado") });
    const [req] = await d.select().from(pendingApprovals).where(eq(pendingApprovals.kind, "account_recovery"));
    expect(req).toMatchObject({ status: "pending", requestedBy: w.sup.id, merchantId: w.active, payload: { userId: w.lojista } });
    expect(await outcome(decideApprovalAction(undefined, form({ approvalId: req.id, op: "approve", reason: "", code: await freshCode() })))).toMatch(
      NOT_FOUND,
    );

    w.second.as();
    const res = await decideApprovalAction(undefined, form({ approvalId: req.id, op: "approve", reason: "", code: await freshCode() }));
    const temp = /Senha temporária \(aparece só agora\): ([0-9A-Za-z]{16})\./.exec((res as { ok?: string }).ok ?? "")?.[1];
    if (!temp) throw new Error(`sem senha temporária na resposta: ${JSON.stringify(res)}`);
    const [u] = await d.select().from(users).where(eq(users.id, w.lojista));
    expect((res as { ok: string }).ok).toContain(`E-mail de acesso: ${u.email}.`); // quem aprova sabe a quem entregar
    expect(u).toMatchObject({ totpEnabled: false, totpSecretEnc: null, mustChangePassword: true });
    expect(await verifyPassword(u.passwordHash, temp)).toBe(true);
    expect(await d.select().from(sessions).where(eq(sessions.userId, w.lojista))).toHaveLength(0);
  });

  it("na ordem inversa também: senha temporária pendente bloqueia zerar o 2FA; na conta da equipe, nem o admin faz as duas", async () => {
    const w = await world();
    w.sup.as();
    expect(await userOpAction(undefined, form({ userId: w.lojista, op: "senha", reason: "", code: await freshCode() }))).toMatchObject({
      tempPassword: expect.any(String),
    });
    const before = await fingerprint(w.sup.id);
    expect(await userOpAction(undefined, form({ userId: w.lojista, op: "reset2fa", reason: "", code: await freshCode() }))).toEqual({
      error: expect.stringContaining("senha temporária pendente"),
    });
    expect(await fingerprint(w.sup.id)).toBe(before);

    w.boss.as();
    expect(await userOpAction(undefined, form({ userId: w.second.id, op: "reset2fa", reason: "", code: await freshCode() }))).toMatchObject({
      ok: expect.any(String),
    });
    const team = await fingerprint(w.boss.id);
    expect(await userOpAction(undefined, form({ userId: w.second.id, op: "senha", reason: "", code: await freshCode() }))).toEqual({
      error: expect.stringContaining("Conta da equipe"),
    });
    expect(await fingerprint(w.boss.id)).toBe(team);
  });
});
