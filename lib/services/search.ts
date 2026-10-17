import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { charges, payouts } from "@/lib/db/schema";
import { type ChargeRow, chargeAsOf } from "@/lib/services/charges";
import type { PayoutRow } from "@/lib/services/payouts";

// Escapa os curingas do LIKE para que "mar%" procure o prefixo literal "mar%", não "mar" + qualquer coisa.
const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, "\\$&")}%`;
const hasDigit = (s: string) => /\d/.test(s);
// Só casa payouts.id (uuid) quando o termo tem formato de UUID; senão o Postgres estoura "invalid input syntax for uuid".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Busca do lojista por E2E/TxID/referência/nome, no histórico inteiro (a força sobre a Cashyin, §0.2).
 * Filtra **sempre** por `merchantId` da sessão (nunca do input): essa é a superfície de IDOR.
 * `term` aparado, mínimo 2 chars (senão vazio); `limit` entre 1 e 50.
 * `pix_key` só casa quando o termo tem dígito — termo sem dígito jamais casa documento (bug da Cashyin §1.17.10).
 */
export async function searchTransactions(
  merchantId: string,
  term: string,
  limit = 20,
): Promise<{ charges: ChargeRow[]; payouts: PayoutRow[] }> {
  const q = term.trim();
  if (q.length < 2) return { charges: [], payouts: [] };
  const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const now = new Date();

  const chargeRows = await db()
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.merchantId, merchantId),
        or(
          UUID.test(q) ? eq(charges.id, q) : undefined,
          eq(charges.txid, q),
          eq(charges.externalRef, q),
          eq(charges.endToEndId, q),
          ilike(charges.payerName, likePrefix(q)),
        ),
      ),
    )
    .orderBy(desc(charges.createdAt), desc(charges.id))
    .limit(take);

  const payoutRows = await db()
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.merchantId, merchantId),
        or(
          UUID.test(q) ? eq(payouts.id, q) : undefined,
          eq(payouts.endToEndId, q),
          // pix_key é documento/chave: termo sem dígito não casa (evita o bug da Cashyin §1.17.10).
          hasDigit(q) ? eq(payouts.pixKey, q) : undefined,
        ),
      ),
    )
    .orderBy(desc(payouts.createdAt), desc(payouts.id))
    .limit(take);

  return { charges: chargeRows.map((c) => chargeAsOf(c, now)), payouts: payoutRows };
}
