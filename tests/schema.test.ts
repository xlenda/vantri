import { beforeEach, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { charges, ledgerEntries, merchants } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
});

async function newMerchant(n: number): Promise<string> {
  const [m] = await d
    .insert(merchants)
    .values({
      legalName: `Loja ${n} LTDA`,
      tradeName: `Loja ${n}`,
      documentType: "cnpj",
      documentEnc: "v1:x:y:z",
      documentHash: `hash-${n}`,
      segment: "cursos",
    })
    .returning({ id: merchants.id });
  return m.id;
}

function charge(merchantId: string, n: number) {
  return {
    merchantId,
    txid: `txid${n}`,
    externalRef: "pedido-1",
    amountCents: 14990,
    feeCents: 223,
    status: "pending" as const,
    brcode: "000201...",
    providerChargeId: `sim_ch_${n}`,
    expiresAt: new Date(Date.now() + 3600_000),
  };
}

// 23505 = unique_violation (drizzle embrulha o erro do driver em `cause`).
async function expectUniqueViolation(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: { code?: string; cause?: { code?: string } }) => e,
  );
  expect(err?.cause?.code ?? err?.code).toBe("23505");
}

it("rejects duplicate external_ref per merchant", async () => {
  const m = await newMerchant(1);
  await d.insert(charges).values(charge(m, 1));
  await expectUniqueViolation(d.insert(charges).values(charge(m, 2)));
});

it("rejects duplicate ledger entry for same kind/ref/bucket", async () => {
  const m = await newMerchant(1);
  const entry = {
    merchantId: m,
    amountCents: 14990,
    bucket: "available" as const,
    kind: "cash_in" as const,
    refType: "charge" as const,
    refId: "00000000-0000-4000-8000-000000000001",
  };
  await d.insert(ledgerEntries).values(entry);
  await expectUniqueViolation(d.insert(ledgerEntries).values(entry));
});

it("allows same external_ref for different merchants", async () => {
  const a = await newMerchant(1);
  const b = await newMerchant(2);
  await d.insert(charges).values(charge(a, 1));
  await d.insert(charges).values(charge(b, 2));
  expect(await d.$count(charges)).toBe(2);
});
