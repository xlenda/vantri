import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import {
  charges,
  medCases,
  medEvents,
  payoutBatches,
  payouts,
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
} from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
});

// 23505 = unique_violation (drizzle embrulha o erro do driver em `cause`).
async function expectUniqueViolation(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: { code?: string; cause?: { code?: string } }) => e,
  );
  expect(err?.cause?.code ?? err?.code).toBe("23505");
}

function batch(merchantId: string) {
  return {
    merchantId,
    totalCents: 30000,
    chunkCents: 10000,
    count: 3,
    pixKey: "loja@teste.com",
    pixKeyType: "email" as const,
    status: "processing" as const,
    idempotencyKey: "lote-0001",
    requestHash: "hash-0001",
  };
}

it("rejects duplicate batch idempotency_key per merchant", async () => {
  const m = await newMerchant(d, 1);
  await d.insert(payoutBatches).values(batch(m));
  await expectUniqueViolation(d.insert(payoutBatches).values(batch(m)));
});

it("allows null batch_id on standalone payout", async () => {
  const m = await newMerchant(d, 1);
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId: m,
      amountCents: 10000,
      feeCents: 100,
      pixKey: "loja@teste.com",
      pixKeyType: "email",
      status: "processing",
      idempotencyKey: "avulso-0001",
      requestHash: "hash-avulso",
    })
    .returning();
  expect(p.batchId).toBeNull();
  expect(p.batchIndex).toBeNull();
});

it("cascades webhook_attempts on delivery delete", async () => {
  const m = await newMerchant(d, 1);
  const [ep] = await d
    .insert(webhookEndpoints)
    .values({ merchantId: m, url: "https://loja.example.com/h", secretEnc: "x", events: ["charge.paid"] })
    .returning();
  const [dl] = await d
    .insert(webhookDeliveries)
    .values({ endpointId: ep.id, eventId: "evt_1", eventType: "charge.paid", payload: {}, status: "failed" })
    .returning();
  await d.insert(webhookAttempts).values({ deliveryId: dl.id, n: 1, statusCode: 500, latencyMs: 42 });
  expect(await d.$count(webhookAttempts)).toBe(1);
  await d.delete(webhookDeliveries).where(eq(webhookDeliveries.id, dl.id));
  expect(await d.$count(webhookAttempts)).toBe(0);
});

it("cascades med_events on case delete", async () => {
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
  await d.insert(medEvents).values({ medCaseId: mc.id, type: "opened" });
  expect(await d.$count(medEvents)).toBe(1);
  await d.delete(medCases).where(eq(medCases.id, mc.id));
  expect(await d.$count(medEvents)).toBe(0);
});
