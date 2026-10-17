import { and, asc, eq, inArray } from "drizzle-orm";
import { encrypt, randomBase62 } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { webhookAttempts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { lockMerchant } from "@/lib/money/ledger";
import { enqueueEvent } from "@/lib/webhooks/dispatch";
import { webhookUrlProblem } from "@/lib/webhooks/ssrf";

export const WEBHOOK_EVENT_TYPES = [
  "charge.paid",
  "charge.expired",
  "payout.completed",
  "payout.failed",
  "med.opened",
  "med.closed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export class WebhookError extends Error {
  constructor(
    public code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

/** Enfileira o evento na transação do chamador (some junto se ela for desfeita). */
export async function emit(tx: Tx, merchantId: string, type: WebhookEventType, data: object): Promise<void> {
  await enqueueEvent(tx, merchantId, type, data);
}

// Cada evento vira um POST por endpoint: sem teto, um lojista faria a Vercel disparar milhares por evento.
export const MAX_ENDPOINTS = 10;

export async function createEndpoint(
  merchantId: string,
  input: { url: string; events: WebhookEventType[] },
): Promise<{ id: string; secret: string }> {
  const problem = webhookUrlProblem(input.url);
  if (problem) throw new WebhookError("invalid_request", problem);
  const events = [...new Set(input.events)];
  if (!events.length || !events.every((e) => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(e))) {
    throw new WebhookError("invalid_request", "Escolha ao menos um evento válido.");
  }
  const secret = `whsec_${randomBase62(32)}`;
  // A trava do lojista impede dois pedidos simultâneos de passarem juntos do teto.
  const row = await db().transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    if ((await tx.$count(webhookEndpoints, eq(webhookEndpoints.merchantId, merchantId))) >= MAX_ENDPOINTS) {
      throw new WebhookError(
        "invalid_request",
        `Limite de ${MAX_ENDPOINTS} webhooks por conta. Remova um para criar outro.`,
      );
    }
    const [r] = await tx
      .insert(webhookEndpoints)
      .values({ merchantId, url: input.url, secretEnc: encrypt(secret), events })
      .returning({ id: webhookEndpoints.id });
    return r;
  });
  return { id: row.id, secret };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove o endpoint; as entregas dele vão junto (FK em cascata). Trocar o segredo = criar outro e remover este.
 * Endpoint de outro lojista (ou id inválido) → `not_found`.
 */
export async function deleteEndpoint(merchantId: string, id: string): Promise<void> {
  const rows = UUID.test(id)
    ? await db()
        .delete(webhookEndpoints)
        .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
        .returning({ id: webhookEndpoints.id })
    : [];
  if (!rows.length) throw new WebhookError("not_found", "Webhook não encontrado.");
}

export type DeliveryAttempt = typeof webhookAttempts.$inferSelect;

/**
 * Histórico de tentativas de uma entrega, só do próprio lojista (join entregas→endpoints→merchant).
 * Entrega de outro lojista, inexistente ou id inválido → `[]` (IDOR impossível). Ordem crescente por tentativa.
 */
export async function listDeliveryAttempts(merchantId: string, deliveryId: string): Promise<DeliveryAttempt[]> {
  if (!UUID.test(deliveryId)) return [];
  const rows = await db()
    .select({ a: webhookAttempts })
    .from(webhookAttempts)
    .innerJoin(webhookDeliveries, eq(webhookAttempts.deliveryId, webhookDeliveries.id))
    .innerJoin(webhookEndpoints, eq(webhookDeliveries.endpointId, webhookEndpoints.id))
    .where(and(eq(webhookAttempts.deliveryId, deliveryId), eq(webhookEndpoints.merchantId, merchantId)))
    .orderBy(asc(webhookAttempts.n));
  return rows.map((r) => r.a);
}

/** Volta a entrega para `pending` agora. Entrega de outro lojista (ou id inválido) → `not_found`. */
export async function resendDelivery(merchantId: string, deliveryId: string): Promise<void> {
  const own = db()
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.merchantId, merchantId));
  const updated = UUID.test(deliveryId)
    ? await db()
        .update(webhookDeliveries)
        .set({ status: "pending", nextAttemptAt: new Date() })
        .where(and(eq(webhookDeliveries.id, deliveryId), inArray(webhookDeliveries.endpointId, own)))
        .returning({ id: webhookDeliveries.id })
    : [];
  if (!updated.length) throw new WebhookError("not_found", "Entrega não encontrada.");
}
