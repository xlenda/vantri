import { and, count, desc, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { charges, medCases, merchants, payouts } from "@/lib/db/schema";
import type { ChargeRow } from "@/lib/services/charges";
import type { PayoutRow } from "@/lib/services/payouts";
import { DAY_MS, dayStart, todayStart } from "./format";

// Leituras do admin (todos os lojistas). Quem chama já passou por requireUser({ role: "admin" }).

export const PAGE_SIZE = 25;

// SUM(int) é bigint: postgres-js devolve string, por isso mapWith(Number).
const total = (col: typeof charges.amountCents | typeof payouts.amountCents) =>
  sql`coalesce(sum(${col}), 0)`.mapWith(Number);

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
function period(col: typeof charges.createdAt | typeof payouts.createdAt, f: Common) {
  return and(
    f.from ? gte(col, new Date(dayStart(f.from))) : undefined,
    f.to ? lt(col, new Date(dayStart(f.to) + DAY_MS)) : undefined,
  );
}

const offset = (f: Common, limit: number) => (f.page - 1) * limit;

/** Cobranças de todos os clientes, mais novas primeiro. Pendente vencida sai como `expired` (igual a listCharges). */
export async function listChargesAdmin(f: ChargeFilters, limit = PAGE_SIZE) {
  const now = new Date();
  const byStatus = {
    pending: and(eq(charges.status, "pending"), gt(charges.expiresAt, now)),
    expired: or(eq(charges.status, "expired"), and(eq(charges.status, "pending"), lte(charges.expiresAt, now))),
    paid: eq(charges.status, "paid"),
  };
  const rows = await db()
    .select({ charge: charges, tradeName: merchants.tradeName })
    .from(charges)
    .innerJoin(merchants, eq(merchants.id, charges.merchantId))
    .where(
      and(
        f.merchantId ? eq(charges.merchantId, f.merchantId) : undefined,
        f.status ? byStatus[f.status] : undefined,
        period(charges.createdAt, f),
      ),
    )
    .orderBy(desc(charges.createdAt), desc(charges.id))
    .limit(limit + 1)
    .offset(offset(f, limit));
  return {
    rows: rows.slice(0, limit).map((r) => ({
      ...r,
      charge: (r.charge.status === "pending" && r.charge.expiresAt <= now
        ? { ...r.charge, status: "expired" }
        : r.charge) as ChargeRow,
    })),
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
