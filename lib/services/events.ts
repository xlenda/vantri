import { and, eq, inArray } from "drizzle-orm";
import { encrypt, randomBase62 } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
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
  const [row] = await db()
    .insert(webhookEndpoints)
    .values({ merchantId, url: input.url, secretEnc: encrypt(secret), events })
    .returning({ id: webhookEndpoints.id });
  return { id: row.id, secret };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
