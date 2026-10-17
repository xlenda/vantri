import { lookup } from "node:dns/promises";
import { and, arrayContains, asc, eq, inArray, lte } from "drizzle-orm";
import { decrypt, randomBase62 } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import type { WebhookEventType } from "@/lib/services/events";
import { signPayload } from "./sign";
import { isBlockedAddress, webhookHost, webhookUrlProblem } from "./ssrf";

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
    )
    // Endpoint removido no meio (deleteEndpoint) espera esta transação: a entrega nunca aponta para um que sumiu.
    .for("share");
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

export type Resolve = (host: string) => Promise<Array<{ address: string }>>;
const dnsResolve: Resolve = (host) => lookup(host, { all: true }); // ordem padrão = verbatim

type Claimed = { payload: unknown; url: string; secretEnc: string };

// last_error vai para o painel do lojista: só categoria, nunca a mensagem crua (IP, porta, altnames do certificado).
function errorCategory(e: unknown): string {
  const err = e as { name?: unknown; code?: unknown; cause?: { name?: unknown; code?: unknown } } | null;
  const names = `${err?.name} ${err?.cause?.name}`;
  const code = String(err?.cause?.code ?? err?.code ?? "");
  if (names.includes("TimeoutError") || /TIMEOUT|TIMEDOUT/.test(code)) return "tempo esgotado";
  if (code === "ECONNREFUSED") return "conexão recusada";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "falha de DNS";
  if (/CERT|TLS|SSL|EPROTO/.test(code)) return "erro de TLS";
  return "erro de rede";
}

async function attempt(
  d: Claimed,
  now: Date,
  send: typeof fetch,
  resolve: Resolve,
): Promise<{ statusCode: number | null; error: string | null }> {
  if (webhookUrlProblem(d.url)) return { statusCode: null, error: "endereço bloqueado" };
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(webhookHost(new URL(d.url)));
  } catch {
    return { statusCode: null, error: "falha de DNS" };
  }
  if (!addresses.length) return { statusCode: null, error: "falha de DNS" };
  // Nome público que aponta para IP interno: não envia.
  // ponytail: DNS rebinding entre este lookup e o connect do fetch (TOCTOU) ainda passa; upgrade = conectar
  // no IP já checado (dispatcher do undici com lookup fixo) mantendo SNI/Host = nome original.
  if (addresses.some((a) => isBlockedAddress(a.address))) return { statusCode: null, error: "endereço bloqueado" };
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
    res.body?.cancel().catch(() => {});
    const ok = res.status >= 200 && res.status < 300;
    return { statusCode: res.status, error: ok ? null : `resposta HTTP ${res.status}` };
  } catch (e) {
    return { statusCode: null, error: errorCategory(e) };
  }
}

export async function dispatchDue(
  limit = 50,
  now = new Date(),
  send: typeof fetch = fetch,
  resolve: Resolve = dnsResolve,
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

  // Envio fora de qualquer transação. allSettled: uma gravação que falha não derruba as outras.
  const results = await Promise.allSettled(
    claimed.map(async (d) => {
      const { statusCode, error } = await attempt(d, now, send, resolve);
      const attempts = d.attempts + 1;
      const ok = error === null;
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
  let delivered = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") delivered += Number(r.value);
    // Sem gravar, a entrega volta quando o lease vencer (pode reenviar: entrega é "pelo menos uma vez").
    else logError("webhook: falha ao gravar resultado da entrega", r.reason, { delivery: claimed[i].id });
  }
  return { delivered, failed: results.length - delivered };
}
