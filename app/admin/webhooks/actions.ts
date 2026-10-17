"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { requireAdmin } from "@/lib/auth/guards";
import { logError } from "@/lib/log";
import { WebhookError } from "@/lib/services/events";
import { dispatchDue } from "@/lib/webhooks/dispatch";
import { formFields } from "../format";
import { disableEndpoint, parseDeliveryFilters, resendFailedBatch, resendOne } from "./monitor";

// Toda ação re-checa o papel no servidor: esconder o botão da tela não basta (suporte forjando o POST → 404).
const PERM = { perm: "webhooks:operar" } as const;

function fail(e: unknown, context: string, ids: Record<string, string>): { error: string } {
  if (e instanceof WebhookError) return { error: e.message }; // mensagens do serviço já são em PT e sem dado interno
  logError(context, e, ids);
  return { error: GENERIC_ERROR };
}

const refresh = () => revalidatePath("/admin/webhooks", "layout"); // lista e detalhe

const idForm = z.strictObject({ id: z.uuid() });

export async function resendOneAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin(PERM);
  const input = idForm.safeParse(formFields(fd, ["id"]));
  if (!input.success) return { error: "Pedido inválido." };
  try {
    await resendOne(input.data.id, user.id);
  } catch (e) {
    return fail(e, "admin: reenviar webhook falhou", { delivery: input.data.id });
  }
  after(() => dispatchDue()); // sai agora, não no próximo tick do cron
  refresh();
  return { ok: "Entrega colocada na fila de novo." };
}

/** Reenvio em lote da fila "falhou de vez", com os filtros da tela (campos ocultos). */
export async function resendFailedBatchAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin(PERM);
  const f = parseDeliveryFilters(formFields(fd, ["cliente", "endpoint", "evento", "de", "ate"]));
  let n: number;
  try {
    n = await resendFailedBatch(f, user.id);
  } catch (e) {
    return fail(e, "admin: reenviar webhooks em lote falhou", {});
  }
  if (!n) return { ok: "Nenhuma entrega com falha neste filtro." };
  after(() => dispatchDue());
  refresh();
  return { ok: n === 1 ? "1 entrega voltou para a fila." : `${n} entregas voltaram para a fila.` };
}

export async function disableEndpointAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin(PERM);
  const input = idForm.safeParse(formFields(fd, ["id"]));
  if (!input.success) return { error: "Pedido inválido." };
  try {
    await disableEndpoint(input.data.id, user.id);
  } catch (e) {
    return fail(e, "admin: desativar webhook falhou", { endpoint: input.data.id });
  }
  refresh();
  return { ok: "Endpoint desativado. Novos eventos não são mais enfileirados para ele." };
}
