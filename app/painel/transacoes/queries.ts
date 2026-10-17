import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { charges, medCases, payouts } from "@/lib/db/schema";
import { type ChargeRow, chargeAsOf, chargeStatusWhere } from "@/lib/services/charges";
import type { PayoutRow } from "@/lib/services/payouts";

// Leituras da tela de Transações. O merchantId é sempre o da sessão, nunca da URL.

const filtersSchema = z.strictObject({
  tipo: z.enum(["cobrancas", "saques"]).optional(),
  situacao: z.enum(["andamento", "concluidas", "falhas"]).optional(),
  de: z.iso.date().optional(),
  ate: z.iso.date().optional(),
  cursor: z.uuid().optional(),
});
export type TxFilters = z.output<typeof filtersSchema>;

/** Filtros da URL: lista branca; valor inválido (ou repetido, `?tipo=a&tipo=b`) some e fica sem aquele filtro. */
export function parseTxFilters(sp: Record<string, string | string[] | undefined>): TxFilters {
  const s = filtersSchema.shape;
  const ok = <T>(schema: z.ZodType<T>, v: unknown) => {
    const r = schema.safeParse(v);
    return r.success ? r.data : undefined;
  };
  return {
    tipo: ok(s.tipo, sp.tipo),
    situacao: ok(s.situacao, sp.situacao),
    de: ok(s.de, sp.de),
    ate: ok(s.ate, sp.ate),
    cursor: ok(s.cursor, sp.cursor),
  };
}

export type Tx = { kind: "charge"; row: ChargeRow } | { kind: "payout"; row: PayoutRow };

// Mesma situação para os dois lados: [status da cobrança, status do saque].
const SITUACAO = {
  andamento: ["pending", "processing"],
  concluidas: ["paid", "completed"],
  falhas: ["expired", "failed"],
} as const;

const DAY_MS = 86_400_000;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00-03:00`); // Brasília, sem horário de verão desde 2019
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Cobranças e saques do lojista numa lista só, mais novos primeiro, com os filtros aplicados no banco sobre o
 * histórico inteiro (nunca só a página): tipo, situação (pendente vencida conta como expirada, a regra do
 * listCharges) e período pelo dia de criação em Brasília (`ate` inclusivo). `cursor` = id do último item da página
 * anterior (cobrança ou saque); cursor de outro lojista não acha linha → página vazia.
 */
export async function listTransactions(
  merchantId: string,
  filters: TxFilters,
  limit = 20,
): Promise<{ data: Tx[]; nextCursor: string | null }> {
  const { tipo, situacao, de, ate, cursor } = filtersSchema.parse(filters);
  const now = new Date();
  const where = (t: typeof charges | typeof payouts) =>
    and(
      eq(t.merchantId, merchantId),
      de ? gte(t.createdAt, new Date(dayStart(de))) : undefined,
      ate ? lt(t.createdAt, new Date(dayStart(ate) + DAY_MS)) : undefined,
      // Compara no banco: created_at tem microssegundos, o Date do JS só milissegundos.
      cursor
        ? sql`(${t.createdAt}, ${t.id}) < (select x.created_at, x.id from (
            select c.created_at, c.id from ${charges} c where c.id = ${cursor} and c.merchant_id = ${merchantId}
            union all
            select p.created_at, p.id from ${payouts} p where p.id = ${cursor} and p.merchant_id = ${merchantId}
          ) x limit 1)`
        : undefined,
    );
  // Chave de ordem em microssegundos para intercalar as duas listas na mesma ordem do banco.
  const ord = (t: typeof charges | typeof payouts) =>
    sql<string>`to_char(${t.createdAt} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

  const [cs, ps] = await Promise.all([
    tipo === "saques"
      ? []
      : db()
          .select({ row: charges, ord: ord(charges) })
          .from(charges)
          .where(and(where(charges), situacao ? chargeStatusWhere(SITUACAO[situacao][0], now) : undefined))
          .orderBy(desc(charges.createdAt), desc(charges.id))
          .limit(limit + 1),
    tipo === "cobrancas"
      ? []
      : db()
          .select({ row: payouts, ord: ord(payouts) })
          .from(payouts)
          .where(and(where(payouts), situacao ? eq(payouts.status, SITUACAO[situacao][1]) : undefined))
          .orderBy(desc(payouts.createdAt), desc(payouts.id))
          .limit(limit + 1),
  ]);
  const all = [
    ...cs.map((r) => ({ kind: "charge" as const, row: chargeAsOf(r.row, now), ord: r.ord })),
    ...ps.map((r) => ({ kind: "payout" as const, row: r.row, ord: r.ord })),
  ].sort((a, b) => cmp(b.ord, a.ord) || cmp(b.row.id, a.row.id)); // uuid em texto minúsculo ordena como no banco
  const data = all.slice(0, limit);
  return { data, nextCursor: all.length > limit ? data[data.length - 1].row.id : null };
}

/** Casos de MED da cobrança, só ids (a linha do tempo vem do listMedEvents). Cobrança de outro lojista → []. */
export async function medCaseIdsOfCharge(merchantId: string, chargeId: string): Promise<string[]> {
  if (!z.uuid().safeParse(chargeId).success) return [];
  const rows = await db()
    .select({ id: medCases.id })
    .from(medCases)
    .where(and(eq(medCases.merchantId, merchantId), eq(medCases.chargeId, chargeId)))
    .orderBy(medCases.createdAt, medCases.id);
  return rows.map((r) => r.id);
}
