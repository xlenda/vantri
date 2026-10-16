import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { ledgerEntries } from "@/lib/db/schema";
import { parseOr } from "@/lib/validation";
import { ApiError, LIMIT } from "./http";

const DAY_MS = 86_400_000;
// Dia civil no horário de Brasília (UTC−3, sem horário de verão desde 2019).
const dayStart = (date: string) => Date.parse(`${date}T00:00:00-03:00`);

const schema = z.strictObject({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: LIMIT,
  cursor: z.uuid().optional(),
});

/**
 * Lançamentos do razão, mais novos primeiro. `from`/`to` são dias (AAAA-MM-DD, Brasília, `to` inclusivo);
 * sem eles, os últimos 30 dias. Período máximo de 366 dias. `cursor` = id do último item da página anterior.
 */
export async function listStatement(merchantId: string, query: z.input<typeof schema>) {
  const { from, to, limit, cursor } = parseOr(schema, query, (msg) => new ApiError("invalid_request", msg));
  const end = to ? dayStart(to) + DAY_MS : undefined; // exclusivo; sem `to`, não limita em cima
  const upper = end ?? Date.now();
  const start = from ? dayStart(from) : upper - 30 * DAY_MS;
  if (start >= upper) {
    throw new ApiError("invalid_request", "Período inválido: from precisa ser anterior ou igual a to.");
  }
  if (upper - start > 366 * DAY_MS) {
    throw new ApiError("invalid_request", "O período pode ter no máximo 366 dias.");
  }
  const rows = await db()
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.merchantId, merchantId),
        gte(ledgerEntries.createdAt, new Date(start)),
        end === undefined ? undefined : lt(ledgerEntries.createdAt, new Date(end)),
        // Compara no banco (microssegundos). Cursor de outro lojista não acha linha → página vazia.
        cursor
          ? sql`(${ledgerEntries.createdAt}, ${ledgerEntries.id}) < (select le.created_at, le.id from ${ledgerEntries} le where le.id = ${cursor} and le.merchant_id = ${merchantId})`
          : undefined,
      ),
    )
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(limit + 1);
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
}
