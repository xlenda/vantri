import { after } from "next/server";
import { logError } from "@/lib/log";
import { getProvider } from "@/lib/provider";
import { WebhookAuthError } from "@/lib/provider/simulator";
import type { ProviderEvent } from "@/lib/provider/types";
import { applyChargePaid } from "@/lib/services/charges";
import { applyMedClosed, applyMedOpened } from "@/lib/services/med";
import { applyPayoutResult, findPayoutIdByProviderId } from "@/lib/services/payouts";
import { dispatchDue } from "@/lib/webhooks/dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

// Só ids do provedor no log, nunca dados do pagador.
const ignored = (what: string) => console.log(`webhook do provedor: ${what} desconhecido, ignorado`);

async function apply(e: ProviderEvent): Promise<void> {
  switch (e.type) {
    case "charge.paid":
      if ((await applyChargePaid(e)) === "unknown") ignored(`cobrança ${e.providerChargeId}`);
      return;
    case "payout.completed":
    case "payout.failed": {
      const id = await findPayoutIdByProviderId(e.providerPayoutId);
      if (!id) return ignored(`saque ${e.providerPayoutId}`);
      await applyPayoutResult(
        id,
        e.type === "payout.completed"
          ? { status: "completed", endToEndId: e.endToEndId }
          : { status: "failed", failureCode: e.failureCode },
      );
      return;
    }
    case "med.opened":
      if ((await applyMedOpened(e)) === "unknown") ignored(`MED ${e.providerCaseId} da cobrança ${e.providerChargeId}`);
      return;
    case "med.closed":
      if ((await applyMedClosed(e)) === "unknown") ignored(`MED ${e.providerCaseId}`);
      return;
    default: {
      // Evento novo no ProviderEvent sem tratamento aqui não compila.
      const _exhaustive: never = e;
      throw new Error(`evento do provedor sem tratamento: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

export async function POST(req: Request): Promise<Response> {
  const provider = getProvider(); // mal configurado → 500 (o parceiro tenta de novo)
  const rawBody = await req.text();
  let events: ProviderEvent[];
  try {
    events = await provider.parseWebhook({ headers: req.headers, rawBody });
  } catch (e) {
    if (e instanceof WebhookAuthError) return error(401, "unauthorized", "Autenticação do webhook inválida.");
    return error(400, "invalid_request", "Corpo do webhook inválido.");
  }

  // Em ordem; os handlers são idempotentes, então o reenvio do lote inteiro depois de um 500 é seguro.
  let current: ProviderEvent | undefined;
  try {
    for (current of events) await apply(current);
  } catch (e) {
    logError("webhook do provedor: falha ao aplicar evento", e, current && { type: current.type });
    return error(500, "internal_error", "Falha ao processar o evento. Tente novamente.");
  }

  after(() => dispatchDue());
  return Response.json({ received: events.length });
}
