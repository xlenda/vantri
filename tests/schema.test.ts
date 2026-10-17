import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { charges, ledgerEntries } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
});

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
  const m = await newMerchant(d, 1);
  await d.insert(charges).values(charge(m, 1));
  await expectUniqueViolation(d.insert(charges).values(charge(m, 2)));
});

it("rejects duplicate ledger entry for same kind/ref/bucket", async () => {
  const m = await newMerchant(d, 1);
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
  const a = await newMerchant(d, 1);
  const b = await newMerchant(d, 2);
  await d.insert(charges).values(charge(a, 1));
  await d.insert(charges).values(charge(b, 2));
  expect(await d.$count(charges)).toBe(2);
});

it("migration 0004: sem os papéis do Supabase não faz nada; com eles, tira todo privilégio de anon/authenticated", async () => {
  const revoke = readFileSync(new URL("../drizzle/0004_revoke_anon.sql", import.meta.url), "utf8");
  const pg = new PGlite();
  await pg.exec(revoke); // PGlite/Postgres comum: os papéis não existem, nada acontece
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE TABLE merchants (id serial PRIMARY KEY);
    GRANT ALL ON merchants TO anon, authenticated;
    GRANT ALL ON SEQUENCE merchants_id_seq TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  `);
  await pg.exec(revoke);
  await pg.exec("CREATE TABLE depois (id int)"); // criada depois: o privilégio padrão também foi tirado
  const { rows } = await pg.query(`
    SELECT r AS role,
      has_table_privilege(r, 'public.merchants', 'SELECT,INSERT,UPDATE,DELETE') AS tabela,
      has_sequence_privilege(r, 'public.merchants_id_seq', 'USAGE,SELECT,UPDATE') AS sequencia,
      has_table_privilege(r, 'public.depois', 'SELECT,INSERT,UPDATE,DELETE') AS nova
    FROM unnest(ARRAY['anon', 'authenticated']) AS r`);
  expect(rows).toEqual([
    { role: "anon", tabela: false, sequencia: false, nova: false },
    { role: "authenticated", tabela: false, sequencia: false, nova: false },
  ]);
});
