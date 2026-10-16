import { BlockList, isIP } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { encrypt, randomBase62 } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { enqueueEvent } from "@/lib/webhooks/dispatch";

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

// Privadas, loopback, link-local, CGNAT, "esta rede" e únicas-locais. BlockList também casa ::ffff:<ipv4>.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["100.64.0.0", 10],
  ["0.0.0.0", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
blocked.addAddress("::1", "ipv6");
blocked.addAddress("::", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");

// ponytail: só olha o texto da URL. DNS rebinding (nome público que resolve para IP privado) passa;
// o upgrade é resolver o nome no envio, checar o IP com esta mesma lista e fixar a conexão nesse IP.
function assertSafeUrl(raw: string): void {
  if (raw.length > 2048) throw new WebhookError("invalid_request", "URL longa demais (máximo de 2048 caracteres).");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError("invalid_request", "URL inválida.");
  }
  if (url.protocol !== "https:") throw new WebhookError("invalid_request", "A URL precisa começar com https://.");
  // O parser já normaliza: minúsculas, IPv4 em decimal/hexa vira pontuado, IPv6 entre colchetes.
  const host = url.hostname.replace(/\.+$/, "").replace(/^\[(.*)\]$/, "$1");
  const ip = isIP(host);
  const internal = ip
    ? blocked.check(host, ip === 6 ? "ipv6" : "ipv4")
    : host === "localhost" || /\.(localhost|local|internal)$/.test(host);
  if (internal) throw new WebhookError("invalid_request", "Endereço interno não é permitido para webhook.");
}

export async function createEndpoint(
  merchantId: string,
  input: { url: string; events: WebhookEventType[] },
): Promise<{ id: string; secret: string }> {
  assertSafeUrl(input.url);
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
