import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import {
  charges,
  cronRuns,
  feeHistory,
  feePlans,
  medCases,
  medEvents,
  merchants,
  pendingApprovals,
  users,
} from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Cria um admin mínimo (users exige email/hash/role).
async function newUser(d: Db): Promise<string> {
  const [u] = await d
    .insert(users)
    .values({
      email: `admin-${crypto.randomUUID()}@vantri.test`,
      passwordHash: "x",
      role: "admin",
      adminRole: "admin",
    })
    .returning({ id: users.id });
  return u.id;
}

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
});

// 23503 = foreign_key_violation (drizzle embrulha o erro do driver em `cause`).
async function expectFkViolation(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: { code?: string; cause?: { code?: string } }) => e,
  );
  expect(err?.cause?.code ?? err?.code).toBe("23503");
}

it("insere um pedido de quatro olhos com status default 'pending'", async () => {
  const m = await newMerchant(d, 1);
  const userId = await newUser(d);
  const [row] = await d
    .insert(pendingApprovals)
    .values({
      kind: "balance_adjustment",
      merchantId: m,
      payload: { amountCents: 500, bucket: "available" },
      reason: "ajuste manual",
      amountCents: 500,
      requestedBy: userId,
    })
    .returning();
  expect(row.status).toBe("pending");
  expect(row.decidedBy).toBeNull();
  expect(row.decidedAt).toBeNull();
  expect(row.resultRefId).toBeNull();
});

it("recusa pending_approvals com merchant inexistente (FK)", async () => {
  const userId = await newUser(d);
  await expectFkViolation(
    d.insert(pendingApprovals).values({
      kind: "fee_change",
      merchantId: "00000000-0000-4000-8000-000000000999",
      payload: {},
      reason: "x",
      requestedBy: userId,
    }),
  );
});

it("insere um plano de taxa e um histórico ligado a ele", async () => {
  const m = await newMerchant(d, 1);
  const userId = await newUser(d);
  const [plan] = await d
    .insert(feePlans)
    .values({ name: "Padrão", feeInBps: 149, feeInFixedCents: 0, feeOutBps: 0, feeOutFixedCents: 100 })
    .returning();
  expect(plan.archivedAt).toBeNull();
  const [hist] = await d
    .insert(feeHistory)
    .values({
      merchantId: m,
      feeInBps: 149,
      feeInFixedCents: 0,
      feeOutBps: 0,
      feeOutFixedCents: 100,
      planId: plan.id,
      effectiveFrom: new Date(),
      actorUserId: userId,
    })
    .returning();
  expect(hist.planId).toBe(plan.id);
});

it("permite fee_history com plan_id e actor nulos", async () => {
  const m = await newMerchant(d, 1);
  const [hist] = await d
    .insert(feeHistory)
    .values({
      merchantId: m,
      feeInBps: 149,
      feeInFixedCents: 0,
      feeOutBps: 0,
      feeOutFixedCents: 100,
      effectiveFrom: new Date(),
    })
    .returning();
  expect(hist.planId).toBeNull();
  expect(hist.actorUserId).toBeNull();
});

it("insere uma rodada de cron com finished_at/result/error nulos", async () => {
  const [run] = await d
    .insert(cronRuns)
    .values({ step: "webhook_dispatch", startedAt: new Date() })
    .returning();
  expect(run.finishedAt).toBeNull();
  expect(run.result).toBeNull();
  expect(run.error).toBeNull();
});

it("med_events aceita os tipos novos do backoffice e grava source", async () => {
  const m = await newMerchant(d, 1);
  const [ch] = await d
    .insert(charges)
    .values({
      merchantId: m,
      txid: "txid1",
      externalRef: "pedido-1",
      amountCents: 14990,
      feeCents: 223,
      status: "paid",
      brcode: "000201...",
      providerChargeId: "sim_ch_1",
      expiresAt: new Date(Date.now() + 3600_000),
    })
    .returning();
  const [mc] = await d
    .insert(medCases)
    .values({
      merchantId: m,
      chargeId: ch.id,
      providerCaseId: "sim_med_1",
      amountCents: 14990,
      reason: "fraude",
      status: "open",
      defenseDeadline: new Date(Date.now() + 86_400_000),
    })
    .returning();
  const [ev] = await d
    .insert(medEvents)
    .values({ medCaseId: mc.id, type: "funds_blocked", source: "admin" })
    .returning();
  expect(ev.type).toBe("funds_blocked");
  expect(ev.source).toBe("admin");
});

it("merchants aceita rejection_reason e cnpj_lookup (nulos por padrão)", async () => {
  const m = await newMerchant(d, 1);
  const [before] = await d.select().from(merchants).where(eq(merchants.id, m));
  expect(before.rejectionReason).toBeNull();
  expect(before.cnpjLookup).toBeNull();
  await d
    .update(merchants)
    .set({ rejectionReason: "documento inválido", cnpjLookup: { situacao: "ATIVA" } })
    .where(eq(merchants.id, m));
  const [after] = await d.select().from(merchants).where(eq(merchants.id, m));
  expect(after.rejectionReason).toBe("documento inválido");
  expect(after.cnpjLookup).toEqual({ situacao: "ATIVA" });
});
