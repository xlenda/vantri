import { getDeliveryForMerchant } from "@/lib/webhooks/attempts";
import { painelSession, rfc8187 } from "../../../../lib";

/** JSON de uma entrega (o que foi enviado, a resposta e as tentativas), só do próprio lojista; sempre como download. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { merchant } = await painelSession();
  const found = await getDeliveryForMerchant(merchant.id, (await params).id); // de outro lojista → null
  if (!found) {
    return new Response("Entrega não encontrada.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const { delivery: d, endpoint, attempts } = found;
  // Nunca o segredo nem os cabeçalhos enviados: só o corpo, que é o que o lojista recebe e confere.
  const out = {
    id: d.id,
    event_id: d.eventId,
    event_type: d.eventType,
    status: d.status,
    attempts: d.attempts,
    next_attempt_at: d.status === "pending" ? d.nextAttemptAt : null,
    created_at: d.createdAt,
    delivered_at: d.deliveredAt,
    request: { method: "POST", url: endpoint.url, signature_header: "X-Vantri-Signature", body: d.payload },
    response: { status_code: d.lastStatusCode, error: d.lastError },
    attempt_history: attempts.map((a) => ({
      n: a.n,
      at: a.createdAt,
      status_code: a.statusCode,
      latency_ms: a.latencyMs,
      error: a.error,
      response_snippet: a.responseSnippet,
    })),
  };
  return new Response(JSON.stringify(out, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${rfc8187(`webhook-entrega-${d.id}.json`)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
