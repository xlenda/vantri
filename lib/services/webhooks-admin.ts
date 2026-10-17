import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { encrypt, randomBase62 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import {
  createEndpoint,
  deleteEndpoint,
  resendDelivery,
  WEBHOOK_EVENT_TYPES,
  WebhookError,
  type WebhookEventType,
} from "@/lib/services/events";
import { webhookUrlProblem } from "@/lib/webhooks/ssrf";

// A tela importa a gestão de webhook de um lugar só: re-exporta o que já vive em events.ts (sem duplicar lógica).
export { createEndpoint, deleteEndpoint, resendDelivery, WEBHOOK_EVENT_TYPES, WebhookError };
export type { WebhookEventType };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normaliza/valida a lista de eventos (dedup); lança `invalid_request` se vazia ou com tipo desconhecido. */
function cleanEvents(events: WebhookEventType[]): WebhookEventType[] {
  const uniq = [...new Set(events)];
  if (!uniq.length || !uniq.every((e) => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(e))) {
    throw new WebhookError("invalid_request", "Escolha ao menos um evento válido.");
  }
  return uniq;
}

/**
 * Edita URL/eventos/nome do endpoint do próprio lojista. **Re-valida a URL** com `webhookUrlProblem` (uma URL
 * nova apontando para host interno é recusada); dedup e valida eventos. Não toca no segredo. Campos ausentes
 * ficam como estão. Endpoint de outro lojista (ou id inválido) → `not_found`.
 */
export async function updateEndpoint(
  merchantId: string,
  id: string,
  input: { url?: string; events?: WebhookEventType[]; description?: string | null },
): Promise<void> {
  if (input.url !== undefined) {
    const problem = webhookUrlProblem(input.url);
    if (problem) throw new WebhookError("invalid_request", problem);
  }
  const set: Partial<typeof webhookEndpoints.$inferInsert> = {};
  if (input.url !== undefined) set.url = input.url;
  if (input.events !== undefined) set.events = cleanEvents(input.events);
  if (input.description !== undefined) set.description = input.description;
  if (!Object.keys(set).length) {
    // Nada a mudar: ainda confirma a posse (id de outro → not_found), sem escrever.
    const [own] = UUID.test(id)
      ? await db()
          .select({ id: webhookEndpoints.id })
          .from(webhookEndpoints)
          .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
      : [];
    if (!own) throw new WebhookError("not_found", "Webhook não encontrado.");
    return;
  }
  const rows = UUID.test(id)
    ? await db()
        .update(webhookEndpoints)
        .set(set)
        .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
        .returning({ id: webhookEndpoints.id })
    : [];
  if (!rows.length) throw new WebhookError("not_found", "Webhook não encontrado.");
}

/** Liga/desliga o endpoint (desligado não recebe entregas — `enqueueEvent` já filtra `active`). Outro lojista → `not_found`. */
export async function setEndpointActive(merchantId: string, id: string, active: boolean): Promise<void> {
  const rows = UUID.test(id)
    ? await db()
        .update(webhookEndpoints)
        .set({ active })
        .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
        .returning({ id: webhookEndpoints.id })
    : [];
  if (!rows.length) throw new WebhookError("not_found", "Webhook não encontrado.");
}

/**
 * Gera um segredo novo (`whsec_`), guarda cifrado e devolve em claro **uma vez** (não dá para ler depois).
 * Um segredo por endpoint: assinaturas feitas com o antigo deixam de conferir. Outro lojista → `not_found`.
 */
export async function rotateEndpointSecret(merchantId: string, id: string): Promise<{ secret: string }> {
  const secret = `whsec_${randomBase62(32)}`;
  const rows = UUID.test(id)
    ? await db()
        .update(webhookEndpoints)
        .set({ secretEnc: encrypt(secret) })
        .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
        .returning({ id: webhookEndpoints.id })
    : [];
  if (!rows.length) throw new WebhookError("not_found", "Webhook não encontrado.");
  return { secret };
}

export type HealthBand = "healthy" | "unstable" | "failing" | "nodata";
export type EndpointHealth = { rate: number; sample: number; band: HealthBand };

function band(delivered: number, failed: number): { rate: number; sample: number; band: HealthBand } {
  const sample = delivered + failed;
  if (!sample) return { rate: 0, sample: 0, band: "nodata" };
  const rate = delivered / sample;
  const b: HealthBand = rate >= 0.95 ? "healthy" : rate >= 0.8 ? "unstable" : "failing";
  return { rate, sample, band: b };
}

/**
 * Saúde de cada endpoint do lojista sobre as **últimas 100 entregas** daquele endpoint (por `created_at`):
 * `rate = delivered/(delivered+failed)`, pendentes não contam. Faixas: ≥0.95 saudável, ≥0.80 instável, <0.80
 * com falhas, sem amostra "sem dados". Todo endpoint do lojista aparece no mapa (mesmo sem entregas → `nodata`).
 */
export async function endpointHealth(merchantId: string): Promise<Map<string, EndpointHealth>> {
  const own = await db()
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.merchantId, merchantId));
  const out = new Map<string, EndpointHealth>();
  for (const e of own) out.set(e.id, band(0, 0));
  if (!own.length) return out;

  // Janela por endpoint: numera as entregas da mais nova para a mais velha e conta só as 100 primeiras.
  const ranked = db()
    .select({
      endpointId: webhookDeliveries.endpointId,
      status: webhookDeliveries.status,
      rn: sql<number>`row_number() over (partition by ${webhookDeliveries.endpointId} order by ${webhookDeliveries.createdAt} desc, ${webhookDeliveries.id} desc)`.as("rn"),
    })
    .from(webhookDeliveries)
    .where(
      inArray(
        webhookDeliveries.endpointId,
        own.map((e) => e.id),
      ),
    )
    .as("ranked");
  const rows = await db()
    .select({
      endpointId: ranked.endpointId,
      delivered: sql<number>`count(*) filter (where ${ranked.status} = 'delivered')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${ranked.status} = 'failed')`.mapWith(Number),
    })
    .from(ranked)
    .where(sql`${ranked.rn} <= 100`)
    .groupBy(ranked.endpointId);
  for (const r of rows) out.set(r.endpointId, band(r.delivered, r.failed));
  return out;
}

/**
 * KPIs das entregas do lojista nas últimas 24 h (por `created_at`): entregues, falhadas, pendentes e latência
 * média (ms) das entregas concluídas com `delivered_at` (null se nenhuma). Join em endpoints filtra por lojista.
 */
export async function deliveryStats24h(
  merchantId: string,
  now = new Date(),
): Promise<{ delivered: number; failed: number; avgLatencyMs: number | null; pending: number }> {
  const since = new Date(now.getTime() - 86_400_000);
  const [r] = await db()
    .select({
      delivered: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'delivered')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed')`.mapWith(Number),
      pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'pending')`.mapWith(Number),
      // Latência da entrega concluída: delivered_at - created_at, em ms; média só sobre as que entregaram.
      avgLatencyMs: sql<
        number | null
      >`avg(extract(epoch from (${webhookDeliveries.deliveredAt} - ${webhookDeliveries.createdAt})) * 1000) filter (where ${webhookDeliveries.deliveredAt} is not null)`.mapWith(
        (v) => (v === null ? null : Math.round(Number(v))),
      ),
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookDeliveries.endpointId, webhookEndpoints.id))
    .where(and(eq(webhookEndpoints.merchantId, merchantId), gte(webhookDeliveries.createdAt, since)));
  return r;
}
