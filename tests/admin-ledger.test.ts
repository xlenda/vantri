import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import {
  auditLog,
  ledgerEntries,
  merchants,
  payouts,
  pendingApprovals,
  users,
  webhookDeliveries,
  webhookEndpoints,
} from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { approve, requestApproval } from "@/lib/services/admin/approvals";
import { reversePayoutManual } from "@/lib/services/admin/ledger-admin";
import { applyPayoutResult } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Dinheiro manual pelo caminho de verdade: pedido (requestApproval) → aprovação de outro admin (approve), que lança
// no razão via postEntries com lockMerchant. Sem guarda de tela aqui (o serviço é o que move o dinheiro).

let d: Db;
let queries: string[];
let seq = 0;

beforeEach(async () => {
  queries = [];
  d = await createTestDb({ logger: (q) => queries.push(q) });
  setDb(d);
});

async function staff(adminRole: "admin" | "operador") {
  const [u] = await d
    .insert(users)
    .values({ email: `${adminRole}${++seq}@vantri.test`, passwordHash: "x", role: "admin", adminRole })
    .returning({ id: users.id });
  return u.id;
}

/** Lojista ativo com `cents` disponíveis (cobrança paga lançada direto no razão). */
async function merchantWith(cents: number) {
  const m = await newMerchant(d, ++seq);
  await d.update(merchants).set({ status: "active", approvedAt: new Date() }).where(eq(merchants.id, m));
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId: m, amountCents: cents, bucket: "available", kind: "cash_in", refType: "charge", refId: randomUUID() },
    ]),
  );
  return m;
}

/** Saque de R$ 10,00 + R$ 1,00 de tarifa já debitado; `failed` passa pelo estorno automático do provedor. */
async function payoutOf(merchantId: string, status: "processing" | "failed" | "completed") {
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId,
      amountCents: 1000,
      feeCents: 100,
      pixKey: "pix@exemplo.com",
      pixKeyType: "email",
      status: "processing",
      idempotencyKey: `k${++seq}`,
      requestHash: "h",
    })
    .returning({ id: payouts.id });
  const ref = { merchantId, bucket: "available", refType: "payout", refId: p.id } as const;
  await d.transaction((tx) =>
    postEntries(tx, [
      { ...ref, kind: "cash_out", amountCents: -1000 },
      { ...ref, kind: "fee_out", amountCents: -100 },
    ]),
  );
  if (status !== "processing") await applyPayoutResult(p.id, { status });
  return p.id;
}

const available = async (m: string) => (await getBalance(m)).available;
const entries = (m: string, kind: "adjustment" | "cash_out_reversal") =>
  d
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.merchantId, m), eq(ledgerEntries.kind, kind)));
const approval = async (id: string) => (await d.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)))[0];
const payoutStatus = async (id: string) => (await d.select().from(payouts).where(eq(payouts.id, id)))[0].status;
const actions = async () => (await d.select().from(auditLog)).map((a) => a.action).sort();
/** Código do erro do serviço; "ok" se não lançou. */
const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );

const adjust = (merchantId: string, amountCents: number, by: string) =>
  requestApproval("balance_adjustment", { merchantId, amountCents, reason: "Acerto combinado com o cliente" }, by);

describe("ajuste de saldo", () => {
  it("crédito de +500 aprovado: um lançamento adjustment (manual, disponível) e o disponível sobe 500", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(300);
    const { id } = await adjust(m, 500, op);
    expect(await available(m)).toBe(300); // o pedido sozinho não move dinheiro
    expect(await entries(m, "adjustment")).toEqual([]);

    await approve(id, boss);
    expect(await available(m)).toBe(800);
    const adj = await entries(m, "adjustment");
    expect(adj).toEqual([expect.objectContaining({ amountCents: 500, bucket: "available", refType: "manual" })]);
    const row = await approval(id);
    expect(row).toMatchObject({ status: "approved", decidedBy: boss, resultRefId: adj[0].refId });
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(await actions()).toEqual(["approval.approve", "approval.request", "balance.adjust"]);
  });

  it("débito de −500 com 300 disponíveis: invalid_request, nada lançado, o pedido segue pendente", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(300);
    const { id } = await adjust(m, -500, op);

    expect(await errorCode(approve(id, boss))).toBe("invalid_request");
    expect(await entries(m, "adjustment")).toEqual([]);
    expect(await available(m)).toBe(300);
    expect(await approval(id)).toMatchObject({ status: "pending", decidedBy: null, resultRefId: null });
    expect(await actions()).toEqual(["approval.request"]); // nada de balance.adjust nem approval.approve
  });

  it("débito que zera o disponível passa: o limite é não ficar negativo", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(300);
    await approve((await adjust(m, -300, op)).id, boss);
    expect(await available(m)).toBe(0);
    expect(await entries(m, "adjustment")).toEqual([expect.objectContaining({ amountCents: -300 })]);
  });

  it("aprovar o mesmo pedido duas vezes credita uma vez", async () => {
    const [op, boss, boss2] = [await staff("operador"), await staff("admin"), await staff("admin")];
    const m = await merchantWith(300);
    const { id } = await adjust(m, 500, op);
    await approve(id, boss);
    expect(await errorCode(approve(id, boss))).toBe("already_decided");
    expect(await errorCode(approve(id, boss2))).toBe("already_decided");
    expect(await entries(m, "adjustment")).toHaveLength(1);
    expect(await available(m)).toBe(800);
    expect((await approval(id)).decidedBy).toBe(boss);
  });

  it("dois pedidos iguais são dois ajustes: a chave do razão é nova por pedido, nunca colide", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(300);
    await approve((await adjust(m, 500, op)).id, boss);
    await approve((await adjust(m, 500, op)).id, boss);
    expect(await entries(m, "adjustment")).toHaveLength(2);
    expect(await available(m)).toBe(1300);
  });

  it("trava o lojista antes de ler o saldo do débito", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(300);
    const { id } = await adjust(m, -100, op);
    queries.length = 0;
    await approve(id, boss);
    const lock = queries.findIndex((q) => /from "merchants".* for update/i.test(q));
    const sum = queries.findIndex((q) => /sum\("amount_cents"\).* from "ledger_entries"/i.test(q));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(sum).toBeGreaterThan(lock);
  });
});

describe("estorno manual de saque", () => {
  const reverse = (payoutId: string, by: string) =>
    requestApproval("payout_reversal", { payoutId, reason: "Parceiro não confirma o saque" }, by);

  it("saque failed já estornado: o pedido é recusado e o razão não lança outro estorno", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(5000);
    const p = await payoutOf(m, "failed"); // o estorno automático já devolveu valor + tarifa
    expect(await available(m)).toBe(5000);

    expect(await errorCode(reverse(p, op))).toBe("invalid_request");
    expect(await d.$count(pendingApprovals)).toBe(0);
    // Mesmo chamado direto (só a aprovação chama), a trava do razão não deixa estornar de novo.
    expect(await errorCode(d.transaction((tx) => reversePayoutManual(tx, p, boss)))).toBe("invalid_request");
    expect(await entries(m, "cash_out_reversal")).toHaveLength(1);
    expect(await available(m)).toBe(5000);
  });

  it("pedido feito antes do estorno automático: a aprovação depois dele não estorna de novo", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(5000);
    const p = await payoutOf(m, "processing");
    const { id } = await reverse(p, op);
    await applyPayoutResult(p, { status: "failed" }); // o parceiro respondeu antes da aprovação

    expect(await errorCode(approve(id, boss))).toBe("invalid_request");
    expect(await entries(m, "cash_out_reversal")).toHaveLength(1);
    expect(await available(m)).toBe(5000);
    expect((await approval(id)).status).toBe("pending");
  });

  it("saque em processamento: marca falho, estorna valor + tarifa uma vez e avisa o lojista; resposta tardia do parceiro não estorna de novo", async () => {
    const [op, boss] = [await staff("operador"), await staff("admin")];
    const m = await merchantWith(5000);
    await d
      .insert(webhookEndpoints)
      .values({ merchantId: m, url: "https://exemplo.com/hook", secretEnc: "x", events: ["payout.failed"] });
    const p = await payoutOf(m, "processing");
    expect(await available(m)).toBe(3900);

    const { id } = await reverse(p, op);
    expect(await approval(id)).toMatchObject({ kind: "payout_reversal", merchantId: m, amountCents: 1100 });
    expect(await available(m)).toBe(3900); // só o pedido: nada muda

    await approve(id, boss);
    expect(await payoutStatus(p)).toBe("failed");
    expect(await available(m)).toBe(5000);
    expect(await entries(m, "cash_out_reversal")).toEqual([
      expect.objectContaining({ amountCents: 1100, bucket: "available", refType: "payout", refId: p }),
    ]);
    expect((await approval(id)).resultRefId).toBe(p);
    const hooks = await d.select().from(webhookDeliveries);
    expect(hooks.map((h) => h.eventType)).toEqual(["payout.failed"]);
    expect(await actions()).toEqual(["approval.approve", "approval.request", "payout.force_fail"]);

    // O parceiro responde depois (falhou ou concluiu): o saque não está mais em processamento, nada muda.
    await applyPayoutResult(p, { status: "failed" });
    await applyPayoutResult(p, { status: "completed" });
    expect(await payoutStatus(p)).toBe("failed");
    expect(await entries(m, "cash_out_reversal")).toHaveLength(1);
    expect(await available(m)).toBe(5000);
  });

  it("saque concluído não é estornado; saque inexistente dá not_found", async () => {
    const op = await staff("operador");
    const m = await merchantWith(5000);
    const p = await payoutOf(m, "completed");
    expect(await errorCode(reverse(p, op))).toBe("invalid_request");
    expect(await errorCode(reverse(randomUUID(), op))).toBe("not_found");
    expect(await d.$count(pendingApprovals)).toBe(0);
    expect(await entries(m, "cash_out_reversal")).toEqual([]);
  });
});
