import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { repollPayoutAction, requestPayoutReversalAction } from "@/app/admin/saques/actions";
import { GET as exportGET } from "@/app/admin/saques/export/route";
import SaquePage from "@/app/admin/saques/[id]/page";
import SaquesPage from "@/app/admin/saques/page";
import type { AdminRole } from "@/lib/auth/perms";
import { encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, ledgerEntries, merchants, payouts, pendingApprovals, sessions, users } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import { approve, requestApproval } from "@/lib/services/admin/approvals";
import { reversePayoutManual } from "@/lib/services/admin/ledger-admin";
import { listPayoutsOps, payoutDetail, payoutsCsvRows } from "@/lib/services/admin/payouts-ops";
import { createPayout, pollProcessingPayouts, repollPayout } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Guarda de verdade (requireAdmin: sessão + 2FA + papel + `pode`) e step-up de verdade (segredo cifrado no banco,
// anti-replay por passo). Só o cookie da requisição é simulado; notFound lança como no Next.
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
const MIN = 60_000;
const BODY = { amount: 10000, pix_key: "52998224725", pix_key_type: "cpf" };

let d: Db;
let seq = 0;
let step = 0;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  step = 0;
  cookieJar.token = undefined;
  vi.stubEnv("PIX_PROVIDER", "simulator");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  d = await createTestDb();
  setDb(d);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function freshCode(): Promise<string> {
  step += 1;
  vi.setSystemTime((NOW + step * 30) * 1000);
  return generate({ secret: SECRET, epoch: NOW + step * 30 });
}

/** Conta da equipe com 2FA e sessão já passada pelo 2FA; entra com ela (cookie). */
async function staff(adminRole: AdminRole) {
  const email = `${adminRole}${++seq}@vantri.test`;
  const [u] = await d
    .insert(users)
    .values({ email, passwordHash: "x", role: "admin", adminRole, totpSecretEnc: encrypt(SECRET), totpEnabled: true })
    .returning({ id: users.id });
  const token = randomToken();
  await d
    .insert(sessions)
    .values({ id: sha256Hex(token), userId: u.id, mfaPassed: true, expiresAt: new Date(Date.now() + 3_600_000) });
  const as = () => {
    cookieJar.token = token;
  };
  as();
  return { id: u.id, email, as };
}

/** Lojista ativo, com conta no simulador e 14767 disponíveis. */
async function richMerchant(): Promise<string> {
  const m = await newMerchant(d, ++seq);
  await d.update(merchants).set({ status: "active", providerAccountId: `sim_acc_${seq}` }).where(eq(merchants.id, m));
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId: m, amountCents: 14767, bucket: "available", kind: "cash_in", refType: "charge", refId: randomUUID() },
    ]),
  );
  return m;
}

/** Saque gravado direto (lista/exportação), com idade controlada pelo relógio do teste. */
async function payoutRow(merchantId: string, o: Partial<typeof payouts.$inferInsert> = {}) {
  const n = ++seq;
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId,
      amountCents: 1000,
      feeCents: 100,
      pixKey: "ana.souza@exemplo.com",
      pixKeyType: "email",
      status: "processing",
      idempotencyKey: `idem-secreta-${n}`,
      requestHash: `hash-interno-${n}-${"f".repeat(40)}`,
      createdAt: new Date(),
      ...o,
    })
    .returning();
  return p;
}

/** Saque que ficou em processing no parceiro (o simulador responde "processing" e guarda o id). */
async function slowPayout(merchantId: string) {
  vi.spyOn(simulator, "createPayout").mockResolvedValueOnce({ providerPayoutId: `sim_po_lento_${++seq}`, status: "processing" });
  const { payout } = await createPayout(merchantId, BODY, `chave-${seq}`);
  return payout;
}

/** Envio sem resposta do parceiro: debitado, em processamento e sem id lá (o caso do estorno manual). */
async function lostPayout(merchantId: string) {
  vi.spyOn(simulator, "createPayout").mockRejectedValueOnce(new Error("ECONNRESET"));
  const { payout } = await createPayout(merchantId, BODY, `chave-${++seq}`);
  return payout;
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const row = async (id: string) => (await d.select().from(payouts).where(eq(payouts.id, id)))[0];
const reversals = () => d.$count(ledgerEntries, eq(ledgerEntries.kind, "cash_out_reversal"));
const available = async (m: string) => (await getBalance(m)).available;
const audits = (action: string) =>
  d.select({ actorUserId: auditLog.actorUserId, meta: auditLog.meta }).from(auditLog).where(eq(auditLog.action, action));
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { digest?: string }) => e.digest ?? String(e),
  );

describe("repollPayout (um saque) e o cron que o reusa", () => {
  it("processing com id no parceiro: consulta e fecha como completed; audita payout.repoll com o autor", async () => {
    const m = await richMerchant();
    const p = await slowPayout(m);
    expect(p).toMatchObject({ status: "processing", providerPayoutId: expect.stringMatching(/^sim_po_lento_/) });
    const get = vi.spyOn(simulator, "getPayout").mockResolvedValueOnce({ status: "completed", endToEndId: "E123" });
    const send = vi.spyOn(simulator, "createPayout");
    send.mockClear();
    const admin = await staff("operador");

    expect(await repollPayout(p.id, admin.id)).toBe("completed");
    expect(get).toHaveBeenCalledWith(p.providerPayoutId);
    expect(send).not.toHaveBeenCalled(); // tem id no parceiro: consulta, não reenvia
    expect(await row(p.id)).toMatchObject({ status: "completed", endToEndId: "E123" });
    expect(await reversals()).toBe(0);
    expect(await audits("payout.repoll")).toEqual([
      { actorUserId: admin.id, meta: { merchantId: m, payoutId: p.id, status: "completed" } },
    ]);
  });

  it("sem id no parceiro: reenvia com a mesma chave de idempotência; o cron audita sem autor (payout.resend)", async () => {
    const m = await richMerchant();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.spyOn(simulator, "createPayout").mockRejectedValueOnce(new Error("ECONNRESET"));
    const { payout: p } = await createPayout(m, BODY, "chave-x");
    expect(p).toMatchObject({ status: "processing", providerPayoutId: null });

    expect(await repollPayout(p.id)).toBe("completed");
    expect(send.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([p.id, p.id]);
    expect((await row(p.id)).providerPayoutId).toMatch(/^sim_po_/);
    expect(await audits("payout.resend")).toEqual([
      { actorUserId: null, meta: { merchantId: m, payoutId: p.id, status: "completed" } },
    ]);
  });

  it("saque já final ou inexistente: não chama o parceiro e não audita", async () => {
    const m = await richMerchant();
    const done = await payoutRow(m, { status: "completed", providerPayoutId: "sim_po_feito" });
    const get = vi.spyOn(simulator, "getPayout");
    expect(await repollPayout(done.id)).toBe("completed");
    expect(get).not.toHaveBeenCalled();
    expect(await d.$count(auditLog)).toBe(0);
    await expect(repollPayout(randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("o cron em lote reusa repollPayout: conta os que fecharam e cada consulta vira linha do tempo", async () => {
    vi.useRealTimers(); // o now() do banco (PGlite) anda com o Date; parado, nada seria "mais velho que 0 s"
    const m = await richMerchant();
    const p = await slowPayout(m);
    const get = vi.spyOn(simulator, "getPayout").mockResolvedValueOnce({ status: "processing" });
    expect(await pollProcessingPayouts(0)).toBe(0); // consultou e segue em processing: não conta
    get.mockResolvedValueOnce({ status: "failed", failureCode: "pix_key_not_found" });
    expect(await pollProcessingPayouts(0)).toBe(1);
    expect(await row(p.id)).toMatchObject({ status: "failed", failureCode: "pix_key_not_found" });
    expect(await reversals()).toBe(1); // estorno automático, uma vez
    expect((await audits("payout.repoll")).map((a) => [a.actorUserId, (a.meta as { status: string }).status])).toEqual([
      [null, "processing"],
      [null, "failed"],
    ]);
  });
});

describe("listPayoutsOps, payoutDetail e exportação", () => {
  it("presos: só processing com mais de 10 min, o mais antigo primeiro, com a idade em minutos", async () => {
    const a = await newMerchant(d, ++seq);
    const nb = ++seq;
    const b = await newMerchant(d, nb);
    const now = Date.now();
    const old = await payoutRow(a, { createdAt: new Date(now - 11 * MIN) });
    await payoutRow(a, { createdAt: new Date(now - 5 * MIN) }); // novo demais
    await payoutRow(a, { status: "completed", createdAt: new Date(now - 60 * MIN) });
    await payoutRow(a, { status: "failed", createdAt: new Date(now - 30 * MIN) });
    const older = await payoutRow(b, { createdAt: new Date(now - 25 * MIN) });

    const stuck = await listPayoutsOps({ stuck: true, page: 1 });
    expect(stuck.rows.map((r) => [r.payout.id, r.ageMin])).toEqual([
      [older.id, 25],
      [old.id, 11],
    ]);
    expect(stuck.rows[0].tradeName).toBe(`Loja ${nb}`);
    expect(stuck.hasNext).toBe(false);

    const all = await listPayoutsOps({ page: 1 });
    expect(all.rows).toHaveLength(5);
    expect(all.rows[0].payout.createdAt.getTime()).toBe(now - 5 * MIN); // mais novo primeiro
    expect((await listPayoutsOps({ status: "failed", page: 1 })).rows).toHaveLength(1);
    expect((await listPayoutsOps({ merchantId: b, page: 1 })).rows.map((r) => r.payout.id)).toEqual([older.id]);
    expect((await listPayoutsOps({ stuck: true, merchantId: a, page: 1 })).rows.map((r) => r.payout.id)).toEqual([old.id]);
  });

  it("payoutDetail: linha do tempo do audit_log do saque, com pedido de quatro olhos e decisão; id inválido → null", async () => {
    vi.useRealTimers(); // a ordem vem do created_at do banco: com o Date parado, tudo empataria
    const m = await richMerchant();
    const p = await lostPayout(m);
    const other = await lostPayout(await richMerchant());
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const { id: approvalId } = await requestApproval("payout_reversal", { payoutId: p.id, reason: "Parceiro sem resposta" }, op.id);
    await requestApproval("payout_reversal", { payoutId: other.id, reason: "Parceiro sem resposta" }, op.id);
    await approve(approvalId, boss.id);

    const det = await payoutDetail(p.id);
    expect(det?.payout.id).toBe(p.id);
    const [{ tradeName }] = await d.select({ tradeName: merchants.tradeName }).from(merchants).where(eq(merchants.id, m));
    expect(det?.tradeName).toBe(tradeName);
    // Aprovação e efeito gravam na mesma transação (mesmo instante): a decisão vem antes do efeito. O pedido do outro
    // saque não aparece aqui.
    expect(det?.events.map((e) => e.action)).toEqual(["approval.request", "approval.approve", "payout.force_fail"]);
    expect(det?.events[0].actorEmail).toBe(op.email);
    expect(await payoutDetail("nao-e-uuid")).toBeNull();
    expect(await payoutDetail(randomUUID())).toBeNull();
  });

  it("CSV: o filtro inteiro, chave mascarada, sem request_hash nem chave de idempotência", async () => {
    const m = await newMerchant(d, ++seq);
    const p = await payoutRow(m, { createdAt: new Date(Date.now() - 20 * MIN), providerPayoutId: "sim_po_csv" });
    await payoutRow(m, { status: "completed", endToEndId: "E999" });
    const { header, rows } = await payoutsCsvRows({ stuck: true, page: 1 });
    expect(rows).toHaveLength(1);
    const text = JSON.stringify([header, rows]);
    expect(text).toContain(p.id);
    expect(text).toContain("sim_po_csv");
    expect(text).not.toContain(p.requestHash);
    expect(text).not.toContain(p.idempotencyKey);
    expect(text).not.toContain("ana.souza@exemplo.com");
    expect(text).toContain("a•••@exemplo.com");
  });
});

describe("telas e ações do /admin/saques", () => {
  it("suporte lê a operação, mas não opera: ações e exportação dão 404 e nada muda", async () => {
    const m = await richMerchant();
    const p = await slowPayout(m);
    const get = vi.spyOn(simulator, "getPayout");
    await staff("suporte");

    const list = renderToStaticMarkup(await SaquesPage({ searchParams: Promise.resolve({}) }));
    expect(list).toContain(`href="/admin/saques/${p.id}"`);
    expect(list).not.toContain("Exportar CSV");
    const html = renderToStaticMarkup(await SaquePage({ params: Promise.resolve({ id: p.id }) }));
    expect(html).toContain("Linha do tempo");
    expect(html).not.toContain("Consultar no parceiro agora");
    expect(html).not.toContain("Marcar como falho e estornar");

    const code = await freshCode();
    expect(await outcome(repollPayoutAction(undefined, form({ payoutId: p.id, code })))).toMatch(NOT_FOUND);
    expect(
      await outcome(requestPayoutReversalAction(undefined, form({ payoutId: p.id, reason: "Parceiro sem resposta", code }))),
    ).toMatch(NOT_FOUND);
    expect(await outcome(exportGET(new Request("http://x/admin/saques/export")))).toMatch(NOT_FOUND);
    expect(get).not.toHaveBeenCalled();
    expect(await d.$count(pendingApprovals)).toBe(0);
    expect((await row(p.id)).status).toBe("processing");
    expect(await d.$count(auditLog)).toBe(0);
  });

  it("consultar no parceiro agora: pede código 2FA novo, consulta e conta o resultado", async () => {
    const m = await richMerchant();
    const p = await slowPayout(m);
    vi.spyOn(simulator, "getPayout").mockResolvedValueOnce({ status: "completed", endToEndId: "E777" });
    const op = await staff("operador");

    const html = renderToStaticMarkup(await SaquePage({ params: Promise.resolve({ id: p.id }) }));
    expect(html).toContain("Consultar no parceiro agora");
    expect(html).not.toContain("Reenviar ao parceiro"); // já tem id no parceiro
    expect(html).not.toContain("52998224725"); // chave mascarada também no payload
    expect(html).not.toContain(p.requestHash);

    expect(await repollPayoutAction(undefined, form({ payoutId: p.id }))).toEqual(NO_CODE);
    expect((await row(p.id)).status).toBe("processing");
    expect(await repollPayoutAction(undefined, form({ payoutId: p.id, code: await freshCode() }))).toEqual({
      ok: "Consultado no parceiro: saque concluído.",
    });
    expect(await row(p.id)).toMatchObject({ status: "completed", endToEndId: "E777" });
    expect(await audits("payout.repoll")).toEqual([
      { actorUserId: op.id, meta: { merchantId: m, payoutId: p.id, status: "completed" } },
    ]);
    // Já concluído: nada a consultar (e o código não é gasto).
    expect(await repollPayoutAction(undefined, form({ payoutId: p.id }))).toEqual({
      error: "Este saque não está mais em processamento: não há o que consultar.",
    });
  });

  it("marcar como falho e estornar cria pedido de quatro olhos e não estorna na hora", async () => {
    const m = await richMerchant();
    const p = await lostPayout(m);
    const before = await available(m);
    const op = await staff("operador");

    expect(
      await requestPayoutReversalAction(undefined, form({ payoutId: p.id, reason: "x", code: await freshCode() })),
    ).toEqual({ error: "Escreva o motivo (de 3 a 500 caracteres)." });
    expect(
      await requestPayoutReversalAction(
        undefined,
        form({ payoutId: p.id, reason: "Parceiro sem resposta há 2 dias", code: await freshCode() }),
      ),
    ).toEqual({
      ok: "Pedido enviado. O saque só é marcado como falho e estornado quando outro administrador aprovar em Aprovações.",
    });

    const [a] = await d.select().from(pendingApprovals);
    expect(a).toMatchObject({
      kind: "payout_reversal",
      status: "pending",
      requestedBy: op.id,
      merchantId: m,
      amountCents: p.amountCents + p.feeCents,
      payload: { payoutId: p.id },
    });
    // Nada mudou ainda: o saque segue em processamento e o dinheiro não voltou.
    expect((await row(p.id)).status).toBe("processing");
    expect(await reversals()).toBe(0);
    expect(await available(m)).toBe(before);

    // Só com o segundo par de olhos.
    const boss = await staff("admin");
    await approve(a.id, boss.id);
    expect((await row(p.id)).status).toBe("failed");
    expect(await available(m)).toBe(before + p.amountCents + p.feeCents);
  });

  it("com estorno pedido, o saque sem id no parceiro não é reenviado (cron nem tela); se ganhou id no meio, o estorno recusa", async () => {
    const m = await richMerchant();
    const p = await lostPayout(m);
    const op = await staff("operador");
    await requestApproval("payout_reversal", { payoutId: p.id, reason: "Parceiro sem resposta" }, op.id);
    const send = vi.spyOn(simulator, "createPayout");
    send.mockClear(); // o spy é o mesmo do lostPayout: só contam as chamadas daqui em diante
    expect(await repollPayout(p.id)).toBe("processing"); // o cron espera a decisão do pedido
    const boss = await staff("admin");
    expect(await repollPayoutAction(undefined, form({ payoutId: p.id, code: await freshCode() }))).toEqual({
      error: "Há um pedido de estorno deste saque em Aprovações: decida o pedido antes de reenviar.",
    });
    expect(send).not.toHaveBeenCalled();
    // Corrida: um envio em voo terminou e gravou o id no parceiro entre a consulta e o estorno → recusa sob a trava.
    await d.update(payouts).set({ providerPayoutId: "sim_po_corrida" }).where(eq(payouts.id, p.id));
    await expect(d.transaction((tx) => reversePayoutManual(tx, p.id, boss.id))).rejects.toThrow(/chegou ao parceiro/);
    expect((await row(p.id)).status).toBe("processing");
    expect(await reversals()).toBe(0);
  });

  it("estorno manual de saque que o parceiro conhece: pergunta a ele antes; processando ou sem resposta recusa, concluído ou recusado vale o dele", async () => {
    const m = await richMerchant();
    const before = await available(m);
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const ask = async (payoutId: string) =>
      (await requestApproval("payout_reversal", { payoutId, reason: "Parceiro sem resposta" }, op.id)).id;
    const statusOf = async (id: string) => (await d.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)))[0].status;

    const p = await slowPayout(m);
    const a = await ask(p.id);
    // Ainda processando lá: estornar agora pagaria duas vezes se ele concluir depois.
    vi.spyOn(simulator, "getPayout").mockResolvedValueOnce({ status: "processing" });
    await expect(approve(a, boss.id)).rejects.toThrow(/ainda está processando/);
    // Sem resposta do parceiro: também recusa (não dá para saber).
    vi.spyOn(simulator, "getPayout").mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(approve(a, boss.id)).rejects.toThrow(/Não foi possível confirmar/);
    expect((await row(p.id)).status).toBe("processing");
    expect(await reversals()).toBe(0);
    expect(await statusOf(a)).toBe("pending");
    // Concluído lá: vale o dele (fecha como concluído), nada é estornado.
    vi.spyOn(simulator, "getPayout").mockResolvedValueOnce({ status: "completed", endToEndId: "E2E_OK" });
    await expect(approve(a, boss.id)).rejects.toThrow(/concluiu este saque/);
    expect((await row(p.id)).status).toBe("completed");
    expect(await reversals()).toBe(0);

    expect(await available(m)).toBe(before - p.amountCents - p.feeCents); // o saque saiu: nada volta

    // Recusado lá: o estorno automático devolve uma vez só; o manual não soma outro.
    const m2 = await richMerchant();
    const before2 = await available(m2);
    const q = await slowPayout(m2);
    const b = await ask(q.id);
    vi.spyOn(simulator, "getPayout").mockResolvedValueOnce({ status: "failed", failureCode: "pix_key_not_found" });
    await expect(approve(b, boss.id)).rejects.toThrow(/estorno automático já devolveu/);
    expect((await row(q.id)).status).toBe("failed");
    expect(await reversals()).toBe(1);
    expect(await statusOf(b)).toBe("pending"); // o admin recusa o pedido
    expect(await available(m2)).toBe(before2);
  });

  it("exportação: CSV com auditoria export.payouts e sem campo interno", async () => {
    const m = await newMerchant(d, ++seq);
    const p = await payoutRow(m, { createdAt: new Date(Date.now() - 20 * MIN) });
    const admin = await staff("admin");
    const res = await exportGET(new Request("http://x/admin/saques/export?presos=1&de=2027-01-01&ate=2027-01-31"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="saques_2027-01-01_a_2027-01-31.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain(p.id);
    expect(body).not.toContain(p.requestHash);
    expect(body).not.toContain("request_hash");
    expect(body).not.toContain(p.idempotencyKey);
    const [log] = await audits("export.payouts");
    expect(log.actorUserId).toBe(admin.id);
    expect(log.meta).toMatchObject({ stuck: true, from: "2027-01-01", to: "2027-01-31", sha256: expect.any(String) });
  });
});
