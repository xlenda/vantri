import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decideApprovalAction } from "@/app/admin/aprovacoes/actions";
import AprovacoesPage from "@/app/admin/aprovacoes/page";
import { merchantStatusAction, requestBalanceAdjustmentAction, updateFeesAction } from "@/app/admin/clientes/actions";
import ClientePage from "@/app/admin/clientes/[id]/page";
import type { AdminRole } from "@/lib/auth/perms";
import { brl } from "@/lib/br/money";
import { encrypt, randomToken, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, feeHistory, merchants, pendingApprovals, sessions, users } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { approve, listPendingApprovals, reject, requestApproval } from "@/lib/services/admin/approvals";
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
const SELF = { error: "Quem pediu não aprova o próprio pedido: outro administrador precisa aprovar." };
const DECIDED = { error: "Este pedido já foi decidido." };
const APPROVED = { ok: "Pedido aprovado e aplicado." };
const REJECTED = { ok: "Pedido recusado. Nada foi aplicado." };
const ADJUST_ASKED = { ok: "Pedido de ajuste enviado. O saldo só muda quando outro administrador aprovar em Aprovações." };
const FEES_ASKED = {
  ok: "Pedido de mudança de taxa enviado. As taxas só mudam quando outro administrador aprovar em Aprovações.",
};
const REACTIVATE_ASKED = {
  ok: "Pedido de reativação enviado. O cliente só volta a ativo quando outro administrador aprovar em Aprovações.",
};

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

/** Conta da equipe com 2FA e sessão já passada pelo 2FA; entra com ela (cookie). `as()` volta a ela depois. */
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

/** Lojista ativo (já aprovado) com `cents` disponíveis. */
async function activeMerchant(cents = 0) {
  const m = await newMerchant(d, ++seq);
  await d
    .update(merchants)
    .set({ status: "active", approvedAt: new Date(), documentEnc: encrypt("11222333000181") })
    .where(eq(merchants.id, m));
  if (cents) {
    await d.transaction((tx) =>
      postEntries(tx, [
        { merchantId: m, amountCents: cents, bucket: "available", kind: "cash_in", refType: "charge", refId: randomUUID() },
      ]),
    );
  }
  return m;
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const available = async (m: string) => (await getBalance(m)).available;
const merchantRow = async (id: string) => (await d.select().from(merchants).where(eq(merchants.id, id)))[0];
const feesOf = async (id: string) => {
  const m = await merchantRow(id);
  return [m.feeInBps, m.feeInFixedCents, m.feeOutBps, m.feeOutFixedCents];
};
const pending = () => d.select().from(pendingApprovals);
const audits = async () =>
  (await d.select({ actorUserId: auditLog.actorUserId, action: auditLog.action, meta: auditLog.meta }).from(auditLog)).sort(
    (a, b) => a.action.localeCompare(b.action),
  );
/** "ok" ou o digest do erro do Next (notFound/redirect). */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { digest?: string }) => e.digest ?? String(e),
  );
/** Código do erro do serviço; "ok" se não lançou. */
const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );

const askAdjust = async (merchantId: string, direction: "credito" | "debito", amount: string) =>
  requestBalanceAdjustmentAction(
    undefined,
    form({ merchantId, direction, amount, reason: "Acerto de tarifa de outubro", code: await freshCode() }),
  );
const decide = async (id: string, op: "approve" | "reject", reason = "") =>
  decideApprovalAction(undefined, form({ id, op, reason, code: await freshCode() }));

describe("quatro olhos no ajuste de saldo", () => {
  it("operador pede com código novo, nada muda até outro admin aprovar; aprovado, credita uma vez e audita os dois", async () => {
    const m = await activeMerchant(300);
    const boss = await staff("admin");
    const op = await staff("operador");

    expect(await askAdjust(m, "credito", "5,00")).toEqual(ADJUST_ASKED);
    expect(await available(m)).toBe(300);
    const [p] = await listPendingApprovals();
    expect(p).toMatchObject({
      kind: "balance_adjustment",
      merchantId: m,
      amountCents: 500,
      reason: "Acerto de tarifa de outubro",
      requestedBy: op.id,
      requesterEmail: op.email,
      tradeName: (await merchantRow(m)).tradeName,
    });

    boss.as();
    expect(await decide(p.id, "approve")).toEqual(APPROVED);
    expect(await available(m)).toBe(800);
    expect(await listPendingApprovals()).toEqual([]);
    const log = await audits();
    expect(log.map((a) => [a.action, a.actorUserId])).toEqual([
      ["approval.approve", boss.id],
      ["approval.request", op.id],
      ["balance.adjust", boss.id],
    ]);
    // O porquê fica na trilha (motivo); o lançamento aponta para o pedido pelo resultRefId.
    expect(log[1].meta).toEqual({
      approvalId: p.id,
      kind: "balance_adjustment",
      merchantId: m,
      amountCents: 500,
      reason: "Acerto de tarifa de outubro",
    });
    const refId = (await pending())[0].resultRefId;
    expect(log[0].meta).toEqual({ approvalId: p.id, kind: "balance_adjustment", merchantId: m, requestedBy: op.id, resultRefId: refId });
    expect(log[2].meta).toEqual({ merchantId: m, amountCents: 500, refId });
  });

  it("quem pediu não aprova o próprio pedido, nem forjando o id (self_approval); outro admin aprova", async () => {
    const m = await activeMerchant(1000);
    const a = await staff("admin");
    expect(await askAdjust(m, "debito", "2,00")).toEqual(ADJUST_ASKED);
    const [{ id }] = await listPendingApprovals();

    expect(await decide(id, "approve")).toEqual(SELF);
    expect(await errorCode(approve(id, a.id))).toBe("self_approval");
    expect(await available(m)).toBe(1000);
    expect((await pending())[0]).toMatchObject({ status: "pending", decidedBy: null });

    await staff("admin");
    expect(await decide(id, "approve")).toEqual(APPROVED);
    expect(await available(m)).toBe(800);
  });

  it("segundo approve vê already_decided e não aplica de novo; pedido recusado nunca aplica", async () => {
    const m = await activeMerchant(300);
    await staff("operador");
    await askAdjust(m, "credito", "5,00");
    await askAdjust(m, "credito", "7,00");
    const [first, second] = await listPendingApprovals();

    const boss = await staff("admin");
    expect(await decide(first.id, "approve")).toEqual(APPROVED);
    expect(await decide(first.id, "approve")).toEqual(DECIDED); // POST repetido/forjado
    expect(await errorCode(approve(first.id, boss.id))).toBe("already_decided");
    expect(await available(m)).toBe(800);

    expect(await decide(second.id, "reject")).toEqual({ error: "Escreva o motivo da recusa (de 3 a 500 caracteres)." });
    expect(await decide(second.id, "reject", "Valor já acertado no pedido anterior")).toEqual(REJECTED);
    expect(await decide(second.id, "approve")).toEqual(DECIDED);
    expect(await errorCode(reject(second.id, boss.id, "De novo"))).toBe("already_decided");
    expect(await available(m)).toBe(800);
    expect((await pending()).find((r) => r.id === second.id)).toMatchObject({ status: "rejected", decidedBy: boss.id });
    expect((await audits()).find((a) => a.action === "approval.reject")?.meta).toMatchObject({
      approvalId: second.id,
      reason: "Valor já acertado no pedido anterior",
    });
  });

  it("operador cria pedido mas não aprova nem recusa: notFound na action, forbidden no serviço", async () => {
    const m = await activeMerchant(300);
    await staff("operador");
    expect(await askAdjust(m, "credito", "5,00")).toEqual(ADJUST_ASKED);
    const [{ id }] = await listPendingApprovals();

    const other = await staff("operador"); // outro operador: não é o caso de self_approval
    expect(await outcome(decide(id, "approve"))).toMatch(NOT_FOUND);
    expect(await outcome(decide(id, "reject", "Não concordo"))).toMatch(NOT_FOUND);
    expect(await outcome(AprovacoesPage())).toMatch(NOT_FOUND);
    expect(await errorCode(approve(id, other.id))).toBe("forbidden");
    expect(await errorCode(reject(id, other.id, "Não concordo"))).toBe("forbidden");
    expect(await available(m)).toBe(300);
    expect((await pending())[0].status).toBe("pending");
  });

  it("suporte não pede dinheiro nem mexe em taxa ou status: notFound na action, forbidden no serviço, nada gravado", async () => {
    const m = await activeMerchant(300);
    const sup = await staff("suporte");
    const code = await freshCode();
    expect(
      await outcome(
        requestBalanceAdjustmentAction(
          undefined,
          form({ merchantId: m, direction: "credito", amount: "5,00", reason: "Acerto", code }),
        ),
      ),
    ).toMatch(NOT_FOUND);
    const fees = { feeInPercent: "9", feeInFixed: "0", feeOutPercent: "0", feeOutFixed: "0" };
    expect(
      await outcome(updateFeesAction(undefined, form({ merchantId: m, ...fees, reason: "Acerto", code }))),
    ).toMatch(NOT_FOUND);
    expect(await outcome(merchantStatusAction(undefined, form({ merchantId: m, op: "suspend" })))).toMatch(NOT_FOUND);
    expect(await outcome(AprovacoesPage())).toMatch(NOT_FOUND);

    expect(
      await errorCode(requestApproval("balance_adjustment", { merchantId: m, amountCents: 500, reason: "Acerto" }, sup.id)),
    ).toBe("forbidden");
    expect(await errorCode(requestApproval("payout_reversal", { payoutId: randomUUID(), reason: "Acerto" }, sup.id))).toBe(
      "forbidden",
    );
    expect(await pending()).toEqual([]);
    expect(await merchantRow(m)).toMatchObject({ status: "active", feeInBps: 149 });
    expect(await available(m)).toBe(300);
    expect(await audits()).toEqual([]);
  });

  it("sem código 2FA novo (ausente, errado ou repetido) nada é pedido nem aprovado; pedido malformado não gasta o código", async () => {
    const m = await activeMerchant(300);
    const boss = await staff("admin");
    await staff("operador");
    const base = { merchantId: m, direction: "credito", amount: "5,00", reason: "Acerto de tarifa" };
    const right = await freshCode();
    const wrong = right === "000000" ? "111111" : "000000";

    expect(await requestBalanceAdjustmentAction(undefined, form(base))).toEqual(NO_CODE);
    expect(await requestBalanceAdjustmentAction(undefined, form({ ...base, code: wrong }))).toEqual(WRONG_CODE);
    expect(await requestBalanceAdjustmentAction(undefined, form({ ...base, reason: "", code: right }))).toEqual({
      error: "Escreva o motivo (de 3 a 500 caracteres).",
    });
    expect(await requestBalanceAdjustmentAction(undefined, form({ ...base, amount: "0", code: right }))).toEqual({
      error: "Valor inválido: use de R$ 0,01 a R$ 1.000.000,00, com até 2 casas (ex.: 150,00).",
    });
    expect(await pending()).toEqual([]);
    expect(await requestBalanceAdjustmentAction(undefined, form({ ...base, code: right }))).toEqual(ADJUST_ASKED);
    expect(await requestBalanceAdjustmentAction(undefined, form({ ...base, code: right }))).toEqual(WRONG_CODE);
    expect(await pending()).toHaveLength(1);

    boss.as();
    const [{ id }] = await listPendingApprovals();
    expect(await decideApprovalAction(undefined, form({ id, op: "approve" }))).toEqual(NO_CODE);
    expect(await decideApprovalAction(undefined, form({ id, op: "approve", code: wrong }))).toEqual(WRONG_CODE);
    expect(await available(m)).toBe(300);
    expect((await pending())[0].status).toBe("pending");
  });
});

describe("quatro olhos em taxa e reativação", () => {
  const FEES = { feeInPercent: "1,99", feeInFixed: "0,50", feeOutPercent: "0", feeOutFixed: "2,00" };

  it("taxa de cliente ativo (ou que já foi ativo) vira pedido; aprovada, muda e grava a vigência; cliente nunca ativado muda na hora", async () => {
    const m = await activeMerchant();
    const suspended = await activeMerchant();
    await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, suspended));
    const fresh = await newMerchant(d, ++seq); // pendente, nunca aprovado
    const boss = await staff("admin");
    await staff("operador");

    expect(await updateFeesAction(undefined, form({ merchantId: fresh, ...FEES }))).toEqual({ ok: "Taxas atualizadas." });
    expect(await feesOf(fresh)).toEqual([199, 50, 0, 200]);

    expect(await updateFeesAction(undefined, form({ merchantId: m, ...FEES, reason: "Plano novo combinado" }))).toEqual(
      NO_CODE,
    );
    expect(
      await updateFeesAction(undefined, form({ merchantId: suspended, ...FEES, reason: "Plano novo combinado" })),
    ).toEqual(NO_CODE);
    expect(
      await updateFeesAction(
        undefined,
        form({ merchantId: m, ...FEES, reason: "Plano novo combinado", code: await freshCode() }),
      ),
    ).toEqual(FEES_ASKED);
    expect(await feesOf(m)).toEqual([149, 0, 0, 100]);
    const [p] = await listPendingApprovals();
    expect(p).toMatchObject({
      kind: "fee_change",
      amountCents: null,
      payload: { feeInBps: 199, feeInFixedCents: 50, feeOutBps: 0, feeOutFixedCents: 200 },
    });

    boss.as();
    expect(await decide(p.id, "approve")).toEqual(APPROVED);
    expect(await feesOf(m)).toEqual([199, 50, 0, 200]);
    const history = await d.select().from(feeHistory).where(eq(feeHistory.merchantId, m));
    expect(history).toEqual([expect.objectContaining({ feeInBps: 199, actorUserId: boss.id })]);
  });

  it("reativar vira pedido; aprovado, o cliente volta a ativo; reativar quem não está suspenso é recusado", async () => {
    const m = await activeMerchant();
    await d.update(merchants).set({ status: "suspended" }).where(eq(merchants.id, m));
    const other = await activeMerchant();
    const boss = await staff("admin");
    await staff("operador");

    const reactivate = async (merchantId: string, reason = "Documentação regularizada") =>
      merchantStatusAction(undefined, form({ merchantId, op: "reactivate", reason, code: await freshCode() }));
    expect(await reactivate(m, "")).toEqual({ error: "Escreva o motivo (de 3 a 500 caracteres)." });
    expect(await reactivate(other)).toEqual({ error: "Ação não permitida no status atual do cliente." });
    expect(await reactivate(m)).toEqual(REACTIVATE_ASKED);
    expect((await merchantRow(m)).status).toBe("suspended");

    boss.as();
    const [p] = await listPendingApprovals();
    expect(p).toMatchObject({ kind: "merchant_reactivate", merchantId: m });
    expect(await decide(p.id, "approve")).toEqual(APPROVED);
    expect((await merchantRow(m)).status).toBe("active");
    expect((await audits()).find((a) => a.action === "merchant.reactivate")).toMatchObject({ actorUserId: boss.id });
  });
});

describe("telas", () => {
  it("Aprovações lista quem pediu, o quê, por quê, valor e lojista; o próprio pedido fica sem o botão Aprovar", async () => {
    const m = await activeMerchant(1000);
    const boss = await staff("admin");
    expect(await askAdjust(m, "credito", "5,00")).toEqual(ADJUST_ASKED);
    const op = await staff("operador");
    expect(await askAdjust(m, "debito", "3,00")).toEqual(ADJUST_ASKED);

    boss.as();
    const html = renderToStaticMarkup(await AprovacoesPage());
    const { tradeName } = await merchantRow(m);
    expect(html).toContain(tradeName);
    expect(html).toContain(`href="/admin/clientes/${m}"`);
    expect(html).toContain(boss.email);
    expect(html).toContain(op.email);
    expect(html).toContain("Acerto de tarifa de outubro");
    expect(html).toContain(`Crédito de ${brl(500)}`);
    expect(html).toContain(`Débito de ${brl(300)}`);
    expect(html.match(/value="approve"/g)).toHaveLength(1); // só no pedido do operador
    expect(html.match(/value="reject"/g)).toHaveLength(2);
    expect(html).toContain("Pedido seu: outro administrador precisa aprovar.");
  });

  it("página do cliente: Ajustar saldo só para quem move dinheiro; taxa de cliente ativo pede motivo e código", async () => {
    const m = await activeMerchant();
    const page = async () => renderToStaticMarkup(await ClientePage({ params: Promise.resolve({ id: m }) }));
    await staff("operador");
    let html = await page();
    expect(html).toContain("Ajustar saldo");
    expect(html).toContain('name="direction"');
    expect(html).toContain("Pedir mudança de taxa");

    await staff("suporte");
    html = await page();
    expect(html).not.toContain("Ajustar saldo");
    expect(html).not.toContain('name="direction"');
    expect(html).not.toContain("Pedir mudança de taxa");
  });
});
