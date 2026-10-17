import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { EVENT_LABEL } from "@/app/painel/lib";
import { db } from "@/lib/db/client";
import { merchants, webhookAttempts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { writeAudit } from "@/lib/services/admin/audit-util";
import { WEBHOOK_EVENT_TYPES, WebhookError } from "@/lib/services/events";
import { failPendingDeliveries } from "@/lib/webhooks/dispatch";
import { DAY_MS, dayStart } from "../format";
import { PAGE_SIZE } from "../queries";

// Monitor de webhooks do admin: entregas de TODOS os lojistas. Quem chama já passou por
// requireAdmin({ perm: "webhooks:operar" }). Diferente do resendDelivery(merchantId, …) do painel, aqui não há
// escopo de dono: o admin opera qualquer lojista, e cada escrita fica no audit_log com o autor.

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
/** Só o que a tela mostra de cada tentativa: hora, HTTP, latência e a categoria do erro (nunca o erro cru). */
export type WebhookAttemptRow = Pick<typeof webhookAttempts.$inferSelect, "n" | "statusCode" | "latencyMs" | "error" | "createdAt">;

/** Tipos que podem aparecer numa entrega: os assináveis + o "testar envio" do painel. */
export const DELIVERY_EVENTS = [...WEBHOOK_EVENT_TYPES, "webhook.test"] as const;
const STATUS = webhookDeliveries.status.enumValues;

const EVENT_NAME: Record<string, string> = { ...EVENT_LABEL, "webhook.test": "Teste de envio" };
/** Rótulo PT do tipo de evento (o código cru se for desconhecido). */
export const eventName = (type: string) => (Object.hasOwn(EVENT_NAME, type) ? EVENT_NAME[type] : type);

export type DeliveryFilters = {
  merchantId?: string;
  endpointId?: string;
  eventType?: (typeof DELIVERY_EVENTS)[number];
  status?: (typeof STATUS)[number];
  from?: string;
  to?: string;
  page: number;
};

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const opt = <T extends z.ZodType>(s: T, v: unknown): z.output<T> | undefined => {
  const r = s.safeParse(v);
  return r.success ? r.data : undefined;
};

/** Filtros da URL de /admin/webhooks (e do formulário do reenvio em lote). Lista branca; valor inválido é ignorado. */
export function parseDeliveryFilters(sp: Params): DeliveryFilters {
  const out: Record<string, unknown> = {
    merchantId: opt(z.uuid(), first(sp.cliente)),
    endpointId: opt(z.uuid(), first(sp.endpoint)),
    eventType: opt(z.enum(DELIVERY_EVENTS), first(sp.evento)),
    status: opt(z.enum(STATUS), first(sp.status)),
    from: opt(z.iso.date(), first(sp.de)),
    to: opt(z.iso.date(), first(sp.ate)),
    page: opt(z.coerce.number().int().min(1).max(10_000), first(sp.pagina)) ?? 1,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as DeliveryFilters;
}

/** Condição dos filtros (lojista/endpoint/evento/status/período em dias de Brasília, `to` inclusivo). Precisa do join em endpoints. */
function filterWhere(f: Omit<DeliveryFilters, "page">) {
  return and(
    f.merchantId ? eq(webhookEndpoints.merchantId, f.merchantId) : undefined,
    f.endpointId ? eq(webhookDeliveries.endpointId, f.endpointId) : undefined,
    f.eventType ? eq(webhookDeliveries.eventType, f.eventType) : undefined,
    f.status ? eq(webhookDeliveries.status, f.status) : undefined,
    f.from ? gte(webhookDeliveries.createdAt, new Date(dayStart(f.from))) : undefined,
    f.to ? lt(webhookDeliveries.createdAt, new Date(dayStart(f.to) + DAY_MS)) : undefined,
  );
}

/** Entregas de todos os lojistas, mais novas primeiro, paginadas. */
export async function listDeliveries(
  f: DeliveryFilters,
  limit = PAGE_SIZE,
): Promise<{ rows: Array<{ delivery: WebhookDeliveryRow; tradeName: string; url: string }>; hasNext: boolean }> {
  const rows = await db()
    .select({ delivery: webhookDeliveries, tradeName: merchants.tradeName, url: webhookEndpoints.url })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .innerJoin(merchants, eq(merchants.id, webhookEndpoints.merchantId))
    .where(filterWhere(f))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit + 1)
    .offset((f.page - 1) * limit);
  return { rows: rows.slice(0, limit), hasNext: rows.length > limit };
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** Detalhe: a entrega (com payload), o endpoint e as tentativas na ordem. Inexistente ou id inválido → null. */
export async function deliveryDetail(id: string): Promise<{
  delivery: WebhookDeliveryRow;
  attempts: WebhookAttemptRow[];
  tradeName: string;
  merchantId: string;
  url: string;
  endpointActive: boolean;
} | null> {
  if (!isUuid(id)) return null;
  const [r] = await db()
    .select({
      delivery: webhookDeliveries,
      tradeName: merchants.tradeName,
      merchantId: merchants.id,
      url: webhookEndpoints.url,
      endpointActive: webhookEndpoints.active,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .innerJoin(merchants, eq(merchants.id, webhookEndpoints.merchantId))
    .where(eq(webhookDeliveries.id, id));
  if (!r) return null;
  const attempts = await db()
    .select({
      n: webhookAttempts.n,
      statusCode: webhookAttempts.statusCode,
      latencyMs: webhookAttempts.latencyMs,
      error: webhookAttempts.error,
      createdAt: webhookAttempts.createdAt,
    })
    .from(webhookAttempts)
    .where(eq(webhookAttempts.deliveryId, id))
    .orderBy(asc(webhookAttempts.n));
  return { ...r, attempts };
}

// Taxa por TENTATIVA (webhook_attempts): a entrega só vira `failed` depois de ~33 h de retentativas, então contar
// por entrega esconderia um endpoint que caiu agora. Sucesso = tentativa sem erro (2xx). Sem tentativa → null.
// ponytail: webhook_attempts não tem índice em created_at (varre o que sobrou da limpeza de 30/90 dias); criar se crescer.
const rate = (ok: number, total: number) => (total ? ok / total : null);

function attemptCounts(now: Date) {
  const since24h = gte(webhookAttempts.createdAt, new Date(now.getTime() - DAY_MS));
  const ok = isNull(webhookAttempts.error);
  return {
    total24h: sql<number>`count(*) filter (where ${since24h})`.mapWith(Number),
    ok24h: sql<number>`count(*) filter (where ${since24h} and ${ok})`.mapWith(Number),
    total7d: count(),
    ok7d: sql<number>`count(*) filter (where ${ok})`.mapWith(Number),
  };
}

const since7d = (now: Date) => gte(webhookAttempts.createdAt, new Date(now.getTime() - 7 * DAY_MS));

/** Taxa de sucesso 24 h / 7 d de cada endpoint com tentativa nos últimos 7 dias; o pior primeiro. */
export async function endpointSuccessRates(
  merchantId?: string,
  now = new Date(),
): Promise<
  Array<{
    endpointId: string;
    url: string;
    active: boolean;
    merchantId: string;
    tradeName: string;
    rate24h: number | null;
    rate7d: number;
    attempts7d: number;
  }>
> {
  const rows = await db()
    .select({
      endpointId: webhookEndpoints.id,
      url: webhookEndpoints.url,
      active: webhookEndpoints.active,
      merchantId: merchants.id,
      tradeName: merchants.tradeName,
      ...attemptCounts(now),
    })
    .from(webhookAttempts)
    .innerJoin(webhookDeliveries, eq(webhookDeliveries.id, webhookAttempts.deliveryId))
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .innerJoin(merchants, eq(merchants.id, webhookEndpoints.merchantId))
    .where(and(since7d(now), merchantId ? eq(merchants.id, merchantId) : undefined))
    .groupBy(webhookEndpoints.id, merchants.id);
  return rows
    .map(({ total24h, ok24h, total7d, ok7d, ...r }) => ({
      ...r,
      rate24h: rate(ok24h, total24h),
      rate7d: ok7d / total7d, // o grupo só existe com tentativa na janela
      attempts7d: total7d,
    }))
    .sort((a, b) => a.rate7d - b.rate7d || a.tradeName.localeCompare(b.tradeName));
}

/** Taxa de sucesso das tentativas de entrega de todos os lojistas, 24 h e 7 d (tela de Saúde). */
export async function overallSuccessRates(now = new Date()) {
  const [r] = await db().select(attemptCounts(now)).from(webhookAttempts).where(since7d(now));
  return {
    rate24h: rate(r.ok24h, r.total24h),
    rate7d: rate(r.ok7d, r.total7d),
    attempts24h: r.total24h,
    attempts7d: r.total7d,
  };
}

/** Volta a entrega para a fila agora (`dispatchDue` pega). Endpoint desativado não recebe: recusa. */
export async function resendOne(deliveryId: string, actorUserId: string): Promise<void> {
  if (!isUuid(deliveryId)) throw new WebhookError("not_found", "Entrega não encontrada.");
  await db().transaction(async (tx) => {
    const [d] = await tx
      .select({ endpointId: webhookEndpoints.id, merchantId: webhookEndpoints.merchantId, active: webhookEndpoints.active })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(eq(webhookDeliveries.id, deliveryId));
    if (!d) throw new WebhookError("not_found", "Entrega não encontrada.");
    if (!d.active) {
      throw new WebhookError("invalid_request", "O endpoint desta entrega está desativado. Reative-o antes de reenviar.");
    }
    await tx
      .update(webhookDeliveries)
      .set({ status: "pending", nextAttemptAt: new Date() })
      .where(eq(webhookDeliveries.id, deliveryId));
    await writeAudit(tx, actorUserId, "webhook.resend", { deliveryId, endpointId: d.endpointId, merchantId: d.merchantId });
  });
}

/**
 * Fila "falhou de vez" (DLQ): toda entrega `failed` do filtro, de endpoint ativo, volta para a fila agora. O status
 * do filtro é ignorado (só `failed` volta). Devolve quantas; com alguma, uma linha de auditoria com o filtro usado.
 */
export async function resendFailedBatch(f: DeliveryFilters, actorUserId: string): Promise<number> {
  const scope = { merchantId: f.merchantId, endpointId: f.endpointId, eventType: f.eventType, from: f.from, to: f.to };
  const failed = db()
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(filterWhere({ ...scope, status: "failed" }), eq(webhookEndpoints.active, true)));
  return db().transaction(async (tx) => {
    const rows = await tx
      .update(webhookDeliveries)
      .set({ status: "pending", nextAttemptAt: new Date() })
      .where(and(inArray(webhookDeliveries.id, failed), eq(webhookDeliveries.status, "failed")))
      .returning({ id: webhookDeliveries.id });
    if (rows.length) await writeAudit(tx, actorUserId, "webhook.resend_batch", { count: rows.length, ...scope });
    return rows.length;
  });
}

/**
 * Desliga o endpoint (novos eventos deixam de ser enfileirados para ele) e encerra como falha as entregas que ainda
 * esperavam por ele. Inexistente/id inválido → `not_found`.
 */
export async function disableEndpoint(endpointId: string, actorUserId: string): Promise<void> {
  if (!isUuid(endpointId)) throw new WebhookError("not_found", "Webhook não encontrado.");
  await db().transaction(async (tx) => {
    const [ep] = await tx
      .update(webhookEndpoints)
      .set({ active: false })
      .where(eq(webhookEndpoints.id, endpointId))
      .returning({ merchantId: webhookEndpoints.merchantId });
    if (!ep) throw new WebhookError("not_found", "Webhook não encontrado.");
    await failPendingDeliveries(tx, endpointId);
    await writeAudit(tx, actorUserId, "webhook.endpoint_disable", { endpointId, merchantId: ep.merchantId });
  });
}
