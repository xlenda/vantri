import { lookup } from "node:dns/promises";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { randomBase62 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { webhookAttempts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { type DeliveryAttempt, listDeliveryAttempts, WebhookError } from "@/lib/services/events";
import { parseOr } from "@/lib/validation";
import { type Resolve, sendOne } from "./dispatch";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tipo interno do "testar envio": fica fora de WEBHOOK_EVENT_TYPES, então nenhum endpoint o assina.
const TEST_EVENT = "webhook.test";

// Mesmo resolvedor do dispatchDue (lá não é exportado); os testes injetam o seu.
const dnsResolve: Resolve = (host) => lookup(host, { all: true });

/**
 * "Testar envio": manda UM evento `webhook.test` só para este endpoint do lojista, pelo MESMO `sendOne` do
 * dispatcher (barra URL/IP interno antes de qualquer fetch, `redirect:'manual'`, timeout) — nenhum fetch novo
 * aqui (Review Focus 3). Vale para endpoint desligado (testar antes de religar). A entrega e a tentativa são
 * gravadas depois do envio, já no estado final: o dispatcher nunca vê o teste pendente, então não o reenvia sozinho.
 * Endpoint de outro lojista (ou id inválido) → `not_found`.
 */
export async function sendTestDelivery(
  endpointId: string,
  merchantId: string,
  send: typeof fetch = fetch,
  resolve: Resolve = dnsResolve,
): Promise<{ delivered: boolean; statusCode: number | null; error: string | null }> {
  const [ep] = UUID.test(endpointId)
    ? await db()
        .select({ url: webhookEndpoints.url, secretEnc: webhookEndpoints.secretEnc })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.merchantId, merchantId)))
    : [];
  if (!ep) throw new WebhookError("not_found", "Webhook não encontrado.");
  const now = new Date();
  const payload = { id: `evt_test_${randomBase62(20)}`, type: TEST_EVENT, created_at: now.toISOString(), data: { test: true } };
  const { statusCode, error, latencyMs, responseSnippet } = await sendOne({ payload, ...ep }, now, send, resolve);
  const delivered = error === null;
  await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(webhookDeliveries)
      .values({
        endpointId,
        eventId: payload.id,
        eventType: TEST_EVENT,
        payload,
        status: delivered ? "delivered" : "failed",
        attempts: 1,
        lastStatusCode: statusCode,
        lastError: error,
        deliveredAt: delivered ? new Date() : null,
        createdAt: now,
      })
      .returning({ id: webhookDeliveries.id });
    await tx.insert(webhookAttempts).values({ deliveryId: row.id, n: 1, statusCode, latencyMs, error, responseSnippet });
  });
  return { delivered, statusCode, error };
}

const DAY_MS = 86_400_000;
// Dia civil de Brasília (UTC−3, sem horário de verão desde 2019), como no extrato.
const dayStart = (date: string) => Date.parse(`${date}T00:00:00-03:00`);

const listSchema = z.strictObject({
  endpointId: z.uuid().optional(),
  status: z.enum(webhookDeliveries.status.enumValues).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  term: z.string().max(200).optional(),
  limit: z.int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export type DeliveryFilters = z.input<typeof listSchema>;

export type DeliveryListRow = Omit<typeof webhookDeliveries.$inferSelect, "payload"> & {
  url: string;
  endpointDescription: string | null;
  latencyMs: number | null; // da última tentativa; null sem tentativa
};

/**
 * Inspetor de entregas do lojista (o join em endpoints filtra por `merchantId`), mais novas primeiro, sem o payload.
 * `from`/`to` são dias (AAAA-MM-DD, Brasília, `to` inclusivo). `term` (≥ 8 chars, aparado) procura o identificador
 * do evento (`payload->>'id'`) ou da transação (`data.id`, txid, external_ref, E2E) no histórico inteiro, ignorando o
 * período. `cursor` = id da última da página anterior (de outro lojista → página vazia). Entrada inválida → `invalid_request`.
 */
export async function listDeliveries(
  merchantId: string,
  filters: DeliveryFilters = {},
): Promise<{ data: DeliveryListRow[]; nextCursor: string | null }> {
  const { endpointId, status, from, to, term, limit, cursor } = parseOr(
    listSchema,
    filters,
    (msg) => new WebhookError("invalid_request", msg),
  );
  const q = term?.trim() ?? "";
  if (q && q.length < 8) throw new WebhookError("invalid_request", "Digite o identificador completo (pelo menos 8 caracteres).");
  if (from && to && from > to) {
    throw new WebhookError("invalid_request", "Período inválido: a data inicial precisa ser anterior ou igual à final.");
  }
  const p = webhookDeliveries.payload;
  // ponytail: busca por jsonb sem índice (varre as entregas do lojista); índice de expressão se o histórico crescer.
  const rows = await db()
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      eventId: webhookDeliveries.eventId,
      eventType: webhookDeliveries.eventType,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      lastStatusCode: webhookDeliveries.lastStatusCode,
      lastError: webhookDeliveries.lastError,
      deliveredAt: webhookDeliveries.deliveredAt,
      createdAt: webhookDeliveries.createdAt,
      url: webhookEndpoints.url,
      endpointDescription: webhookEndpoints.description,
      latencyMs: sql<number | null>`(select a.latency_ms from ${webhookAttempts} a where a.delivery_id = ${webhookDeliveries.id} order by a.n desc limit 1)`,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookDeliveries.endpointId, webhookEndpoints.id))
    .where(
      and(
        eq(webhookEndpoints.merchantId, merchantId),
        endpointId ? eq(webhookDeliveries.endpointId, endpointId) : undefined,
        status ? eq(webhookDeliveries.status, status) : undefined,
        q
          ? sql`${q} in (${p}->>'id', ${p}->'data'->>'id', ${p}->'data'->>'txid', ${p}->'data'->>'external_ref', ${p}->'data'->>'end_to_end_id')`
          : and(
              from ? gte(webhookDeliveries.createdAt, new Date(dayStart(from))) : undefined,
              to ? lt(webhookDeliveries.createdAt, new Date(dayStart(to) + DAY_MS)) : undefined,
            ),
        // Compara no banco (microssegundos). Cursor de outro lojista não acha linha → página vazia.
        cursor
          ? sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (select wd.created_at, wd.id from ${webhookDeliveries} wd join ${webhookEndpoints} we on we.id = wd.endpoint_id where wd.id = ${cursor} and we.merchant_id = ${merchantId})`
          : undefined,
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit + 1);
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
}

export type DeliveryWithAttempts = {
  delivery: typeof webhookDeliveries.$inferSelect;
  endpoint: { url: string; description: string | null };
  attempts: DeliveryAttempt[];
};

/** Detalhe do inspetor: a entrega (com payload), URL/nome do endpoint e as tentativas por `n`. Outro lojista/inexistente/id inválido → null. */
export async function getDeliveryForMerchant(merchantId: string, deliveryId: string): Promise<DeliveryWithAttempts | null> {
  if (!UUID.test(deliveryId)) return null;
  const [row] = await db()
    .select({ delivery: webhookDeliveries, endpoint: { url: webhookEndpoints.url, description: webhookEndpoints.description } })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookDeliveries.endpointId, webhookEndpoints.id))
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookEndpoints.merchantId, merchantId)));
  return row ? { ...row, attempts: await listDeliveryAttempts(merchantId, deliveryId) } : null;
}

export type EndpointPublic = Pick<
  typeof webhookEndpoints.$inferSelect,
  "id" | "url" | "description" | "events" | "active" | "createdAt"
>;

/** Endpoints do lojista, mais novos primeiro, só com campos públicos — nunca o segredo (nem cifrado). */
export async function listEndpoints(merchantId: string): Promise<EndpointPublic[]> {
  return db()
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      description: webhookEndpoints.description,
      events: webhookEndpoints.events,
      active: webhookEndpoints.active,
      createdAt: webhookEndpoints.createdAt,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.merchantId, merchantId))
    .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id));
}
