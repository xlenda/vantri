import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { ledgerEntries, merchants } from "@/lib/db/schema";

export type LedgerEntry = Pick<
  typeof ledgerEntries.$inferInsert,
  "merchantId" | "amountCents" | "bucket" | "kind" | "refType" | "refId"
>;

// Serializa toda movimentação de saldo do lojista até o fim da transação.
export async function lockMerchant(tx: Tx, merchantId: string): Promise<void> {
  await tx.select({ id: merchants.id }).from(merchants).where(eq(merchants.id, merchantId)).for("update");
}

// Idempotência: UNIQUE(merchant_id, kind, ref_id, bucket) + ON CONFLICT DO NOTHING.
// Devolve false se qualquer entrada já existia (evento já lançado). Sempre dentro da transação do chamador.
export async function postEntries(tx: Tx, entries: LedgerEntry[]): Promise<boolean> {
  const inserted = await tx
    .insert(ledgerEntries)
    .values(entries)
    .onConflictDoNothing()
    .returning({ id: ledgerEntries.id });
  return inserted.length === entries.length;
}

// SUM(int) é bigint: postgres-js devolve string, por isso mapWith(Number).
const sumBucket = (bucket: "available" | "blocked") =>
  sql`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.bucket} = ${bucket}), 0)`.mapWith(
    Number,
  );

export async function getBalance(
  merchantId: string,
  tx?: Tx,
): Promise<{ available: number; blocked: number; total: number }> {
  const [r] = await (tx ?? db())
    .select({ available: sumBucket("available"), blocked: sumBucket("blocked") })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.merchantId, merchantId));
  return { available: r.available, blocked: r.blocked, total: r.available + r.blocked };
}
