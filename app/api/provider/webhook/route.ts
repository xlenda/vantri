import { after } from "next/server";
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

async function apply(e: ProviderEvent): Promise<void> {
  switch (e.type) {
    case "charge.paid":
      // Sem dados do pagador no log.
      if ((await applyChargePaid(e)) === "unknown") console.log(`webhook do provedor: cobrança ${e.providerChargeId} desconhecida, ignorada`);
      return;
    case "payout.completed":
    case "payout.failed": {
      const id = await findPayoutIdByProviderId(e.providerPayoutId);
      if (!id) {
        console.log(`webhook do provedor: saque ${e.providerPayoutId} desconhecido, ignorado`);
        return;
      }
      await applyPayoutResult(
        id,
        e.type === "payout.completed"
          ? { status: "completed", endToEndId: e.endToEndId }
          : { status: "failed", failureCode: e.failureCode },
      );
      return;
    }
    case "med.opened":
      await applyMedOpened(e);
      return;
    case "med.closed":
      await applyMedClosed(e);
      return;
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
  try {
    for (const e of events) await apply(e);
  } catch (e) {
    console.error("webhook do provedor: falha ao aplicar evento", e);
    return error(500, "internal_error", "Falha ao processar o evento. Tente novamente.");
  }

  after(() => dispatchDue());
  return Response.json({ received: events.length });
}
