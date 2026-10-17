import { and, count, desc, eq, gt, gte, inArray, lt, lte, max, ne, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { charges, cronRuns, ledgerEntries, medCases, merchants, payouts, webhookDeliveries } from "@/lib/db/schema";
import { chargeAsOf, chargeStatusWhere } from "@/lib/services/charges";
import type { PayoutRow } from "@/lib/services/payouts";
import { DAY_MS, dayStart, todayDate, todayStart } from "./format";

// Leituras do admin (todos os lojistas). Quem chama já passou por requireUser({ role: "admin" }).

export const PAGE_SIZE = 25;

// SUM(int) é bigint: postgres-js devolve string, por isso mapWith(Number).
const total = (col: AnyPgColumn) => sql`coalesce(sum(${col}), 0)`.mapWith(Number);

export async function adminOverview(now = Date.now()) {
  const [[pending], [paid], [processing], [meds]] = await Promise.all([
    db().select({ n: count() }).from(merchants).where(eq(merchants.status, "pending")),
    db()
      .select({ n: count(), cents: total(charges.amountCents) })
      .from(charges)
      .where(and(eq(charges.status, "paid"), gte(charges.paidAt, new Date(todayStart(now))))),
    db()
      .select({ n: count(), cents: total(payouts.amountCents) })
      .from(payouts)
      .where(eq(payouts.status, "processing")),
    db()
      .select({ n: count() })
      .from(medCases)
      .where(inArray(medCases.status, ["open", "defended"])),
  ]);
  return {
    pendingMerchants: pending.n,
    paidToday: { count: paid.n, cents: paid.cents },
    processingPayouts: { count: processing.n, cents: processing.cents },
    openMeds: meds.n,
  };
}

const CHARGE_STATUS = ["pending", "paid", "expired"] as const;
const PAYOUT_STATUS = ["processing", "completed", "failed"] as const;
type ChargeStatus = (typeof CHARGE_STATUS)[number];
type PayoutStatus = (typeof PAYOUT_STATUS)[number];

type Common = { merchantId?: string; from?: string; to?: string; page: number };
export type ChargeFilters = Common & { status?: ChargeStatus };
export type PayoutFilters = Common & { status?: PayoutStatus };
export type TxFilters = ({ tipo: "cobrancas" } & ChargeFilters) | ({ tipo: "saques" } & PayoutFilters);

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const opt = <T extends z.ZodType>(s: T, v: unknown): z.output<T> | undefined => {
  const r = s.safeParse(v);
  return r.success ? r.data : undefined;
};
const page = (v: unknown) => opt(z.coerce.number().int().min(1).max(10_000), v) ?? 1;

/** Filtros da URL de /admin/transacoes. Lista branca; valor inválido é ignorado (fica sem aquele filtro). */
export function parseTxFilters(sp: Params): TxFilters {
  const tipo = first(sp.tipo) === "saques" ? "saques" : "cobrancas";
  const out: Record<string, unknown> = {
    tipo,
    status: opt(z.enum(tipo === "saques" ? PAYOUT_STATUS : CHARGE_STATUS), first(sp.status)),
    merchantId: opt(z.uuid(), first(sp.cliente)),
    from: opt(z.iso.date(), first(sp.de)),
    to: opt(z.iso.date(), first(sp.ate)),
    page: page(first(sp.pagina)),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as TxFilters;
}

/** Período em dias de Brasília; `to` inclusivo. */
function period(col: AnyPgColumn, f: { from?: string; to?: string }) {
  return and(
    f.from ? gte(col, new Date(dayStart(f.from))) : undefined,
    f.to ? lt(col, new Date(dayStart(f.to) + DAY_MS)) : undefined,
  );
}

const offset = (f: Common, limit: number) => (f.page - 1) * limit;

/**
 * Cobranças de todos os clientes, mais novas primeiro. Pendente vencida sai como `expired` (regra do listCharges).
 * O período é pelo dia da criação; com o filtro "paga", pelo dia do pagamento (o "Recebido hoje" do início).
 */
export async function listChargesAdmin(f: ChargeFilters, limit = PAGE_SIZE) {
  const now = new Date();
  const rows = await db()
    .select({ charge: charges, tradeName: merchants.tradeName })
    .from(charges)
    .innerJoin(merchants, eq(merchants.id, charges.merchantId))
    .where(
      and(
        f.merchantId ? eq(charges.merchantId, f.merchantId) : undefined,
        f.status ? chargeStatusWhere(f.status, now) : undefined,
        period(f.status === "paid" ? charges.paidAt : charges.createdAt, f),
      ),
    )
    .orderBy(desc(charges.createdAt), desc(charges.id))
    .limit(limit + 1)
    .offset(offset(f, limit));
  return {
    rows: rows.slice(0, limit).map((r) => ({ ...r, charge: chargeAsOf(r.charge, now) })),
    hasNext: rows.length > limit,
  };
}

export async function listPayoutsAdmin(f: PayoutFilters, limit = PAGE_SIZE) {
  const rows = await db()
    .select({ payout: payouts, tradeName: merchants.tradeName })
    .from(payouts)
    .innerJoin(merchants, eq(merchants.id, payouts.merchantId))
    .where(
      and(
        f.merchantId ? eq(payouts.merchantId, f.merchantId) : undefined,
        f.status ? eq(payouts.status, f.status) : undefined,
        period(payouts.createdAt, f),
      ),
    )
    .orderBy(desc(payouts.createdAt), desc(payouts.id))
    .limit(limit + 1)
    .offset(offset(f, limit));
  return { rows: rows.slice(0, limit) as Array<{ payout: PayoutRow; tradeName: string }>, hasNext: rows.length > limit };
}

const MERCHANT_STATUS = ["pending", "active", "suspended", "rejected"] as const;

/** Filtros da URL de /admin/clientes. */
export function parseMerchantFilters(sp: Params) {
  return { status: opt(z.enum(MERCHANT_STATUS), first(sp.status)), page: page(first(sp.pagina)) };
}

export async function listMerchantsAdmin(f: ReturnType<typeof parseMerchantFilters>, limit = PAGE_SIZE) {
  const rows = await db()
    .select()
    .from(merchants)
    .where(f.status ? eq(merchants.status, f.status) : undefined)
    .orderBy(desc(merchants.createdAt), desc(merchants.id))
    .limit(limit + 1)
    .offset((f.page - 1) * limit);
  return { rows: rows.slice(0, limit), hasNext: rows.length > limit };
}

/** Filtros da URL de /admin/med: status, cursor da página (`apos`) e a cobrança do MED de teste. */
export function parseMedFilters(sp: Params) {
  return {
    status: opt(z.enum(["open", "defended", "merchant_won", "payer_refunded"]), first(sp.status)),
    cursor: opt(z.uuid(), first(sp.apos)),
    chargeId: opt(z.uuid(), first(sp.cobranca)),
  };
}

/** Para o filtro "cliente". ponytail: lista inteira num select; trocar por busca quando passar de algumas centenas. */
export function merchantOptions() {
  return db()
    .select({ id: merchants.id, tradeName: merchants.tradeName })
    .from(merchants)
    .orderBy(merchants.tradeName);
}

// ---------------------------------------------------------------------------------------------------------------
// Visão do suporte (/admin): todos os lojistas somados. Quem chama já passou por requireAdmin({ perm: "clientes:ler" }).
// Cortes de dia iguais aos das listas acima (`period`, Brasília UTC−3 fixo). Dinheiro em centavos inteiros.
// ---------------------------------------------------------------------------------------------------------------

/** Dias de Brasília AAAA-MM-DD, `to` inclusivo. */
export type Range = { from: string; to: string };
const PRESETS = ["hoje", "7d", "30d", "mes", "personalizado"] as const;
export type RangePreset = (typeof PRESETS)[number];
const MAX_RANGE_DAYS = 366;

/** AAAA-MM-DD + n dias (conta de calendário em UTC: só dias, sem fuso). */
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** `?periodo=` hoje | 7d | 30d | mes (até hoje) | personalizado (`de`/`ate`, até 366 dias). Padrão e inválido: 7 dias. */
export function parseRange(sp: Params, now = Date.now()): Range & { preset: RangePreset } {
  const to = todayDate(now);
  const preset = opt(z.enum(PRESETS), first(sp.periodo));
  if (preset === "personalizado") {
    const from = opt(z.iso.date(), first(sp.de));
    const until = opt(z.iso.date(), first(sp.ate));
    if (from && until && from <= until && until < addDays(from, MAX_RANGE_DAYS)) return { preset, from, to: until };
  }
  if (preset === "hoje") return { preset, from: to, to };
  if (preset === "30d") return { preset, from: addDays(to, -29), to };
  if (preset === "mes") return { preset, from: `${to.slice(0, 8)}01`, to };
  return { preset: "7d", from: addDays(to, -6), to };
}

/** Um ponto por dia do período; dia sem movimento vem zerado. */
export type DayPoint = {
  day: string;
  inCents: number; // cobranças pagas, pelo dia do pagamento (o "Recebido hoje" de adminOverview)
  feeInCents: number;
  pixCount: number;
  outCents: number; // saques pedidos no dia que não falharam (concluídos ou em processamento)
  feeOutCents: number;
  payoutCount: number;
  failedPayoutCount: number;
  medCents: number; // MEDs abertos no dia
  chargesCreated: number; // cobranças criadas no dia...
  chargesCreatedPaid: number; // ...e quantas delas já foram pagas (conversão)
};

// Dia de Brasília calculado no banco (mesma regra de format.ts e de lib/services/summary.ts), sem depender do fuso
// da sessão. Só literais no SQL: o GROUP BY repete a expressão do SELECT igualzinha.
const brDay = (col: AnyPgColumn) =>
  sql<string>`to_char((${col} at time zone 'UTC') - interval '3 hours', 'YYYY-MM-DD')`;
const sumIf = (col: AnyPgColumn, cond: SQL) => sql`coalesce(sum(${col}) filter (where ${cond}), 0)`.mapWith(Number);
const countIf = (cond: SQL) => sql`count(*) filter (where ${cond})`.mapWith(Number);
// "Paga" como a pessoa vê (regra única de charges.ts); para esse status o filtro sempre existe.
const paidCharge = () => chargeStatusWhere("paid", new Date())!;
// Saque que falhou foi estornado: não conta como enviado nem como tarifa.
const payoutNotFailed = ne(payouts.status, "failed");

// ponytail: charges/payouts só têm índice por lojista, então o período varre a tabela. Índice em paid_at/created_at
// quando passar de ~100 mil cobranças.
export async function seriesByDay(r: Range): Promise<DayPoint[]> {
  const paid = paidCharge();
  const [byPaid, byCreated, byPayout, byMed] = await Promise.all([
    db()
      .select({
        day: brDay(charges.paidAt),
        inCents: total(charges.amountCents),
        feeInCents: total(charges.feeCents),
        pixCount: count(),
      })
      .from(charges)
      .where(and(paid, period(charges.paidAt, r)))
      .groupBy(brDay(charges.paidAt)),
    db()
      .select({ day: brDay(charges.createdAt), chargesCreated: count(), chargesCreatedPaid: countIf(paid) })
      .from(charges)
      .where(period(charges.createdAt, r))
      .groupBy(brDay(charges.createdAt)),
    db()
      .select({
        day: brDay(payouts.createdAt),
        outCents: sumIf(payouts.amountCents, payoutNotFailed),
        feeOutCents: sumIf(payouts.feeCents, payoutNotFailed),
        payoutCount: countIf(payoutNotFailed),
        failedPayoutCount: countIf(eq(payouts.status, "failed")),
      })
      .from(payouts)
      .where(period(payouts.createdAt, r))
      .groupBy(brDay(payouts.createdAt)),
    db()
      .select({ day: brDay(medCases.createdAt), medCents: total(medCases.amountCents) })
      .from(medCases)
      .where(period(medCases.createdAt, r))
      .groupBy(brDay(medCases.createdAt)),
  ]);
  const days = new Map<string, DayPoint>();
  for (let day = r.from; day <= r.to; day = addDays(day, 1)) {
    days.set(day, {
      day,
      inCents: 0,
      feeInCents: 0,
      pixCount: 0,
      outCents: 0,
      feeOutCents: 0,
      payoutCount: 0,
      failedPayoutCount: 0,
      medCents: 0,
      chargesCreated: 0,
      chargesCreatedPaid: 0,
    });
  }
  for (const row of [...byPaid, ...byCreated, ...byPayout, ...byMed]) {
    const point = days.get(row.day);
    if (point) Object.assign(point, row);
  }
  return [...days.values()];
}

/**
 * Lojistas que mais receberam no período (cobranças pagas, pelo dia do pagamento). `feeCents` = tarifa de entrada
 * + de saída no período (a "receita" dos cartões); `medRate` = MEDs abertos ÷ cobranças pagas no período.
 */
export async function topMerchants(
  r: Range,
  limit = 10,
): Promise<
  Array<{ merchantId: string; tradeName: string; inCents: number; count: number; feeCents: number; medRate: number }>
> {
  const inCents = total(charges.amountCents);
  const top = await db()
    .select({
      merchantId: charges.merchantId,
      tradeName: merchants.tradeName,
      inCents,
      count: count(),
      feeInCents: total(charges.feeCents),
    })
    .from(charges)
    .innerJoin(merchants, eq(merchants.id, charges.merchantId))
    .where(and(paidCharge(), period(charges.paidAt, r)))
    .groupBy(charges.merchantId, merchants.tradeName)
    .orderBy(desc(inCents), merchants.tradeName, charges.merchantId)
    .limit(limit);
  if (top.length === 0) return [];
  const ids = top.map((t) => t.merchantId);
  const [feesOut, meds] = await Promise.all([
    db()
      .select({ merchantId: payouts.merchantId, cents: total(payouts.feeCents) })
      .from(payouts)
      .where(and(inArray(payouts.merchantId, ids), payoutNotFailed, period(payouts.createdAt, r)))
      .groupBy(payouts.merchantId),
    db()
      .select({ merchantId: medCases.merchantId, n: count() })
      .from(medCases)
      .where(and(inArray(medCases.merchantId, ids), period(medCases.createdAt, r)))
      .groupBy(medCases.merchantId),
  ]);
  const feeOut = new Map(feesOut.map((x) => [x.merchantId, x.cents]));
  const medCount = new Map(meds.map((x) => [x.merchantId, x.n]));
  return top.map(({ feeInCents, ...t }) => ({
    ...t,
    feeCents: feeInCents + (feeOut.get(t.merchantId) ?? 0),
    medRate: (medCount.get(t.merchantId) ?? 0) / t.count,
  }));
}

/**
 * Saldos somados de todos os lojistas: a mesma soma por bucket de getBalance (lib/money/ledger.ts), agrupada por
 * lojista, e quantos lojistas estão com o disponível negativo (ex.: MED aberto depois de um saque).
 * ponytail: soma o razão inteiro a cada visita; materializar o saldo por lojista se a página pesar.
 */
export async function aggregateBalances(): Promise<{ availableTotal: number; blockedTotal: number; negativeCount: number }> {
  const bucket = (b: "available" | "blocked") =>
    sql<number>`coalesce(sum(${ledgerEntries.amountCents}) filter (where ${ledgerEntries.bucket} = ${b}), 0)`;
  const perMerchant = db()
    .select({ available: bucket("available").as("available"), blocked: bucket("blocked").as("blocked") })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.merchantId)
    .as("per_merchant");
  const [r] = await db()
    .select({
      availableTotal: sql`coalesce(sum(${perMerchant.available}), 0)`.mapWith(Number),
      blockedTotal: sql`coalesce(sum(${perMerchant.blocked}), 0)`.mapWith(Number),
      negativeCount: sql`count(*) filter (where ${perMerchant.available} < 0)`.mapWith(Number),
    })
    .from(perMerchant);
  return r;
}

export const STUCK_PAYOUT_MIN = 10; // o "presos" de /admin/saques
export const MED_DUE_SOON_H = 48; // o "MED com prazo curto" do Início do painel
export const CRON_STALE_MIN = 5; // o "parado" da Saúde

/** O que pede ação agora (não depende do período). Cada número leva à tela que resolve. */
export async function pendingQueue(now = Date.now()): Promise<{
  pendingMerchants: number;
  stuckPayouts: number;
  failingWebhooks: number;
  medDueSoon: number;
  cronStale: boolean;
}> {
  const ago = (min: number) => new Date(now - min * 60_000);
  const [[pending], [stuck], [failing], [dueSoon], [cron]] = await Promise.all([
    db().select({ n: count() }).from(merchants).where(eq(merchants.status, "pending")),
    db()
      .select({ n: count() })
      .from(payouts)
      .where(and(eq(payouts.status, "processing"), lt(payouts.createdAt, ago(STUCK_PAYOUT_MIN)))),
    db().select({ n: count() }).from(webhookDeliveries).where(eq(webhookDeliveries.status, "failed")),
    // Só os que ainda aceitam defesa (abertos, prazo não vencido) e vencem logo.
    db()
      .select({ n: count() })
      .from(medCases)
      .where(
        and(
          eq(medCases.status, "open"),
          gt(medCases.defenseDeadline, new Date(now)),
          lte(medCases.defenseDeadline, new Date(now + MED_DUE_SOON_H * 3_600_000)),
        ),
      ),
    db().select({ last: max(cronRuns.startedAt) }).from(cronRuns),
  ]);
  return {
    pendingMerchants: pending.n,
    stuckPayouts: stuck.n,
    failingWebhooks: failing.n,
    medDueSoon: dueSoon.n,
    cronStale: !cron.last || cron.last.getTime() < ago(CRON_STALE_MIN).getTime(),
  };
}
