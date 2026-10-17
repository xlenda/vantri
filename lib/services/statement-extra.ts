import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "@/lib/api/http";
import { db } from "@/lib/db/client";
import { ledgerEntries } from "@/lib/db/schema";
import { parseOr } from "@/lib/validation";

const DAY_MS = 86_400_000;
// Dia civil no horário de Brasília (UTC−3, sem horário de verão desde 2019), igual ao lib/api/statement.ts.
const dayStart = (date: string) => Date.parse(`${date}T00:00:00-03:00`);
// Rótulo do dia de Brasília do instante de meia-noite: +3h cai no mesmo dia em UTC, então o date-part é o próprio dia.
const dayLabel = (midnightMs: number) => new Date(midnightMs).toISOString().slice(0, 10);

type LedgerKind = (typeof ledgerEntries.kind.enumValues)[number];
const KIND = z.enum(ledgerEntries.kind.enumValues);

const schema = z.strictObject({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  // Sem rota pública: a tela pede 50 por página; a exportação pede o teto do arquivo + 1 numa leitura só.
  limit: z.coerce.number().int().min(1).max(50_001).default(20),
  cursor: z.uuid().optional(),
  kind: z.array(KIND).nonempty().optional(),
  direction: z.enum(["in", "out"]).optional(),
  minCents: z.coerce.number().int().min(0).optional(),
  maxCents: z.coerce.number().int().min(0).optional(),
});

export type StatementExtraQuery = z.input<typeof schema>;

// Janela de dias (from/to Brasília, to inclusivo); sem eles, os últimos 30 dias. Máximo 366 dias.
function window(from: string | undefined, to: string | undefined) {
  const end = to ? dayStart(to) + DAY_MS : undefined; // exclusivo; sem `to`, não limita em cima
  const upper = end ?? Date.now();
  const start = from ? dayStart(from) : upper - 30 * DAY_MS;
  if (start >= upper) throw new ApiError("invalid_request", "Período inválido: from precisa ser anterior ou igual a to.");
  if (upper - start > 366 * DAY_MS) throw new ApiError("invalid_request", "O período pode ter no máximo 366 dias.");
  return { start, end: end ?? upper };
}

/**
 * Lançamentos do razão, mais novos primeiro, com o **saldo corrido** do bucket `available` após cada lançamento
 * (`balanceAfter`): soma acumulada de `amount_cents` (available) do início do histórico até a linha — reconcilia
 * com `getBalance`. Filtros `kind`/`direction` tornam o saldo corrido incalculável sobre a conta inteira, então
 * `balanceAfter = null` (a tela mostra "—", nunca um número errado — regra §1.6). `direction` deriva do sinal de
 * `amount_cents` (in ≥ 0, out < 0). `minCents`/`maxCents` filtram pelo valor absoluto **no servidor**. Máximo 366 dias.
 */
export async function listStatementWithBalance(merchantId: string, query: StatementExtraQuery) {
  const { from, to, limit, cursor, kind, direction, minCents, maxCents } = parseOr(
    schema,
    query,
    (msg) => new ApiError("invalid_request", msg),
  );
  const { start, end } = window(from, to);
  if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
    throw new ApiError("invalid_request", "Faixa de valor inválida: minCents precisa ser menor ou igual a maxCents.");
  }
  const filtered = kind !== undefined || direction !== undefined;

  // Saldo corrido do available do início do histórico até cada linha (reconcilia com getBalance). A janela precisa
  // enxergar TODO o histórico (sem o filtro de data), por isso o recorte de data/cursor/limite é feito depois, em JS.
  const running = sql<number>`sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.bucket} = 'available') over (order by ${ledgerEntries.createdAt}, ${ledgerEntries.id})`.mapWith(
    Number,
  );
  const cols = {
    id: ledgerEntries.id,
    merchantId: ledgerEntries.merchantId,
    amountCents: ledgerEntries.amountCents,
    bucket: ledgerEntries.bucket,
    kind: ledgerEntries.kind,
    refType: ledgerEntries.refType,
    refId: ledgerEntries.refId,
    createdAt: ledgerEntries.createdAt,
  };

  if (filtered) {
    // Com filtro: query com WHERE + cursor no banco, limit+1, balanceAfter sempre null.
    const rows = await db()
      .select(cols)
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.merchantId, merchantId),
          gte(ledgerEntries.createdAt, new Date(start)),
          lt(ledgerEntries.createdAt, new Date(end)),
          kind ? inArray(ledgerEntries.kind, kind) : undefined,
          direction === "in" ? gte(ledgerEntries.amountCents, 0) : undefined,
          direction === "out" ? lt(ledgerEntries.amountCents, 0) : undefined,
          minCents === undefined ? undefined : sql`abs(${ledgerEntries.amountCents}) >= ${minCents}`,
          maxCents === undefined ? undefined : sql`abs(${ledgerEntries.amountCents}) <= ${maxCents}`,
          cursor
            ? sql`(${ledgerEntries.createdAt}, ${ledgerEntries.id}) < (select le.created_at, le.id from ${ledgerEntries} le where le.id = ${cursor} and le.merchant_id = ${merchantId})`
            : undefined,
        ),
      )
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(limit + 1);
    const data = rows.slice(0, limit).map((r) => ({ ...r, balanceAfter: null as number | null }));
    return { data, nextCursor: rows.length > limit && data.length > 0 ? data[data.length - 1].id : null };
  }

  // Sem filtro: lê todo o histórico do lojista com o saldo corrido, depois recorta data/cursor/limite em JS.
  // ponytail: carrega o histórico inteiro (merchant-scoped) para a janela reconciliar com getBalance; se um
  // lojista passar de dezenas de milhares de lançamentos, trocar por subquery (window sobre tudo) + WHERE externo.
  const all = await db()
    .select({ ...cols, balanceAfter: running })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.merchantId, merchantId))
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id));
  let page = all.filter((r) => {
    const ms = r.createdAt.getTime();
    const v = Math.abs(r.amountCents);
    return ms >= start && ms < end && (minCents === undefined || v >= minCents) && (maxCents === undefined || v <= maxCents);
  });
  if (cursor) {
    const i = page.findIndex((r) => r.id === cursor);
    page = i >= 0 ? page.slice(i + 1) : page; // cursor fora da janela/de outro lojista → página inteira
  }
  const data = page.slice(0, limit);
  return { data, nextCursor: page.length > limit && data.length > 0 ? data[data.length - 1].id : null };
}

const CLOSING_LIMIT = 366;

export type DailyClosingRow = {
  day: string;
  openingCents: number;
  inflowCents: number;
  outflowCents: number;
  feeCents: number;
  medCents: number;
  closingCents: number;
};

/**
 * Fecho Diário: para cada dia civil de Brasília no período [fromDay, toDay] (inclusivo), abertura, entradas, saídas,
 * tarifas, MED e fechamento — tudo do bucket `available`, reconcilia com o saldo corrido. Série **contínua**: dia sem
 * movimento repete o fechamento anterior. Período máximo 366 dias.
 * `closingCents = openingCents + inflowCents − outflowCents − feeCents ± medCents`.
 */
export async function dailyClosing(merchantId: string, fromDay: string, toDay: string): Promise<DailyClosingRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    throw new ApiError("invalid_request", "Dia inválido: use o formato AAAA-MM-DD.");
  }
  const startMs = dayStart(fromDay);
  const endMs = dayStart(toDay);
  if (startMs > endMs) {
    throw new ApiError("invalid_request", "Período inválido: fromDay precisa ser anterior ou igual a toDay.");
  }
  if (Math.round((endMs - startMs) / DAY_MS) + 1 > CLOSING_LIMIT) {
    throw new ApiError("invalid_request", "O período pode ter no máximo 366 dias.");
  }

  // Dia civil de Brasília (UTC−3), mesmo idioma de summary.dailyFlow: converte para UTC (independe da sessão do
  // banco — `::date` truncaria no TimeZone da sessão) e subtrai 3h.
  const day = sql<string>`to_char((${ledgerEntries.createdAt} at time zone 'UTC') - interval '3 hours', 'YYYY-MM-DD')`;
  // A identidade `net = inflow − outflow − fee + med` depende dos sinais canônicos do razão: cash_in/reversal ≥ 0;
  // fee_in/fee_out/cash_out < 0; adjustment separado pelo próprio sinal; cada kind entra em exatamente uma categoria.
  const availKinds = (kinds: LedgerKind[], dir?: "in" | "out") =>
    sql`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.bucket} = 'available' and ${inArray(ledgerEntries.kind, kinds)}${
      dir === "in" ? sql` and ${ledgerEntries.amountCents} >= 0` : dir === "out" ? sql` and ${ledgerEntries.amountCents} < 0` : sql``
    }), 0)`.mapWith(Number);
  const availAll = sql`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.bucket} = 'available'), 0)`.mapWith(Number);

  const rows = await db()
    .select({
      day,
      inflow: availKinds(["cash_in", "cash_out_reversal", "adjustment"], "in"),
      outflow: availKinds(["cash_out", "adjustment"], "out"),
      fee: availKinds(["fee_in", "fee_out"]),
      med: availKinds(["med_hold", "med_release", "med_debit"]),
      net: availAll,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.merchantId, merchantId))
    .groupBy(day)
    .orderBy(asc(day));

  const byDay = new Map(rows.map((r) => [r.day, r]));
  // Abertura do primeiro dia = saldo available de todo o histórico estritamente antes de fromDay.
  let opening = rows.reduce((acc, r) => (r.day < fromDay ? acc + r.net : acc), 0);

  const out: DailyClosingRow[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const d = dayLabel(ms);
    const r = byDay.get(d);
    const closingCents = opening + (r ? r.net : 0);
    out.push({
      day: d,
      openingCents: opening,
      inflowCents: r ? r.inflow : 0,
      outflowCents: r ? -r.outflow || 0 : 0, // saídas guardadas com sinal negativo → positivas (|| 0 evita -0)
      feeCents: r ? -r.fee || 0 : 0, // tarifas são negativas no razão → positivas (|| 0 evita -0)
      medCents: r ? r.med : 0, // MED é o líquido assinado (hold −, release +, debit −)
      closingCents,
    });
    opening = closingCents; // série contínua: dia sem movimento repete o fechamento anterior
  }
  return out;
}
