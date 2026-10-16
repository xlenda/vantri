import { and, arrayContains, asc, eq, inArray, lte } from "drizzle-orm";
import { decrypt, randomBase62 } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import type { WebhookEventType } from "@/lib/services/events";
import { signPayload } from "./sign";

/** Espera depois da falha N (1-based). 7 tentativas no total; a 7ª falha vira `failed`. */
export const RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 21600, 86400];

const TIMEOUT_MS = 10_000;
// Envios rodam em paralelo, então a rodada inteira cabe em ~TIMEOUT_MS; a reserva só precisa ser bem maior.
const LEASE_MS = 120_000;

/** Uma entrega `pending` por endpoint ativo do lojista que assina `type`. Roda na transação do chamador. */
export async function enqueueEvent(tx: Tx, merchantId: string, type: WebhookEventType, data: object): Promise<void> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.merchantId, merchantId),
        eq(webhookEndpoints.active, true),
        arrayContains(webhookEndpoints.events, [type]),
      ),
    );
  if (!endpoints.length) return;
  const payload = { id: `evt_${randomBase62(24)}`, type, created_at: new Date().toISOString(), data };
  await tx.insert(webhookDeliveries).values(
    endpoints.map((e) => ({
      endpointId: e.id,
      eventId: payload.id,
      eventType: type,
      payload,
      status: "pending" as const,
    })),
  );
}

export async function dispatchDue(
  limit = 50,
  now = new Date(),
  send: typeof fetch = fetch,
): Promise<{ delivered: number; failed: number }> {
  // Reserva atômica: um único UPDATE empurra next_attempt_at para now+LEASE (lease) nas linhas vencidas.
  // FOR UPDATE SKIP LOCKED faz uma rodada concorrente pular as linhas que esta está reservando, e depois do
  // commit elas já não estão vencidas. Se o processo morrer no meio, a entrega volta sozinha quando o lease vence.
  const due = db()
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const claimed = await db()
    .update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
    .from(webhookEndpoints)
    .where(and(eq(webhookDeliveries.endpointId, webhookEndpoints.id), inArray(webhookDeliveries.id, due)))
    .returning({
      id: webhookDeliveries.id,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
      url: webhookEndpoints.url,
      secretEnc: webhookEndpoints.secretEnc,
    });

  // Envio fora de qualquer transação.
  const results = await Promise.all(
    claimed.map(async (d) => {
      const attempts = d.attempts + 1;
      let statusCode: number | null = null;
      let error: string | null = null;
      try {
        const body = JSON.stringify(d.payload);
        const res = await send(d.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Vantri-Signature": signPayload(decrypt(d.secretEnc), body, Math.floor(now.getTime() / 1000)),
            "User-Agent": "Vantri-Webhooks/1",
          },
          body,
          redirect: "manual", // 3xx não é seguido e conta como falha
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        statusCode = res.status;
        res.body?.cancel().catch(() => {});
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        error = (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message).slice(0, 500);
      }

      const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
      const delay = RETRY_DELAYS_SEC[attempts - 1];
      await db()
        .update(webhookDeliveries)
        .set({
          attempts,
          lastStatusCode: statusCode,
          lastError: error,
          ...(ok
            ? { status: "delivered" as const, deliveredAt: now }
            : delay === undefined
              ? { status: "failed" as const }
              : { nextAttemptAt: new Date(now.getTime() + delay * 1000) }),
        })
        .where(eq(webhookDeliveries.id, d.id));
      return ok;
    }),
  );
  const delivered = results.filter(Boolean).length;
  return { delivered, failed: results.length - delivered };
}
