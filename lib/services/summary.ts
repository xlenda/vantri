import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { ledgerEntries } from "@/lib/db/schema";

// Resumo de período e série de fluxo diário, somados no servidor sobre o razão (nunca na página).
// Dinheiro em centavos inteiros. Dias civis em AAAA-MM-DD no horário de Brasília (UTC−3, sem horário de verão).

const DAY_MS = 86_400_000;
// Início do dia civil de Brasília como instante UTC (mesmo truque de lib/api/statement.ts).
const dayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00-03:00`));
// Dia seguinte em AAAA-MM-DD (aritmética de calendário, sem fuso: só conta dias).
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

// SUM(int) é bigint (postgres-js devolve string): mapWith(Number). abs para valores com sinal negativo (saída/tarifa).
const sumKind = (kind: (typeof ledgerEntries.$inferSelect)["kind"], abs = false) => {
  const col = ledgerEntries.amountCents;
  const expr = abs ? sql`abs(${col})` : col;
  return sql<number>`coalesce(sum(${expr}) filter (where ${ledgerEntries.kind} = ${kind}), 0)`.mapWith(Number);
};
const countKind = (kind: (typeof ledgerEntries.$inferSelect)["kind"]) =>
  sql<number>`count(*) filter (where ${ledgerEntries.kind} = ${kind})`.mapWith(Number);

/** Lançamentos do lojista entre `fromDay 00:00 -03:00` e `toDay+1 00:00 -03:00` (fim exclusivo). */
const inRange = (merchantId: string, fromDay: string, toDay: string) =>
  and(
    eq(ledgerEntries.merchantId, merchantId),
    gte(ledgerEntries.createdAt, dayStart(fromDay)),
    lt(ledgerEntries.createdAt, dayStart(nextDay(toDay))),
  );

/**
 * Soma o razão entre `fromDay 00:00 -03:00` e `toDay+1 00:00 -03:00`. `inflow` = soma de `cash_in`;
 * `outflow` = soma dos `cash_out` em valor absoluto; contagens por `kind`; `result = inflow - outflow`.
 * Tarifas (`fee_in`/`fee_out`) em valor absoluto. Dias em AAAA-MM-DD Brasília.
 */
export async function periodSummary(
  merchantId: string,
  fromDay: string,
  toDay: string,
): Promise<{
  inflowCents: number;
  inflowCount: number;
  outflowCents: number;
  outflowCount: number;
  feeInCents: number;
  feeOutCents: number;
  resultCents: number;
}> {
  const [r] = await db()
    .select({
      inflowCents: sumKind("cash_in"),
      inflowCount: countKind("cash_in"),
      outflowCents: sumKind("cash_out", true),
      outflowCount: countKind("cash_out"),
      feeInCents: sumKind("fee_in", true),
      feeOutCents: sumKind("fee_out", true),
    })
    .from(ledgerEntries)
    .where(inRange(merchantId, fromDay, toDay));
  return { ...r, resultCents: r.inflowCents - r.outflowCents };
}

/**
 * Uma linha por dia civil de Brasília com movimento (para o gráfico de fluxo), em ordem crescente.
 * Dia por `to_char((created_at at time zone 'UTC') - interval '3 hours', 'YYYY-MM-DD')`.
 */
export async function dailyFlow(
  merchantId: string,
  fromDay: string,
  toDay: string,
): Promise<Array<{ day: string; inflowCents: number; outflowCents: number }>> {
  const day = sql<string>`to_char((${ledgerEntries.createdAt} at time zone 'UTC') - interval '3 hours', 'YYYY-MM-DD')`;
  return db()
    .select({ day, inflowCents: sumKind("cash_in"), outflowCents: sumKind("cash_out", true) })
    .from(ledgerEntries)
    .where(inRange(merchantId, fromDay, toDay))
    .groupBy(day)
    .orderBy(day);
}

/** Janela de mesma duração (dias civis) que termina 1 dia antes de `fromDay`. Puro. */
export function previousPeriod(fromDay: string, toDay: string): { fromDay: string; toDay: string } {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  const days = Math.round((to - from) / DAY_MS) + 1; // inclusivo
  const prevTo = from - DAY_MS;
  const prevFrom = prevTo - (days - 1) * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { fromDay: iso(prevFrom), toDay: iso(prevTo) };
}

/** `(current-previous)/previous`; `null` se `previous <= 0` (oculta o delta). Puro. */
export function pctDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}
