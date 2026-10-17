"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { logError } from "@/lib/log";
import { createPayout, PayoutError } from "@/lib/services/payouts";
import { dispatchDue } from "@/lib/webhooks/dispatch";
import { firstIssue, formInput, payoutInput } from "../input";
import { freshTotpProblem, painelSession } from "../lib";

export type PayoutFormValues = { amount: string; pixKeyType: string; pixKey: string; description: string };
export type PayoutFormState = { error: string; values: PayoutFormValues; attempt: number } | undefined;

/**
 * Saque pelo painel. Ordem: formato dos campos (erro aqui não gasta o código) → código 2FA com anti-replay
 * (errado: para aqui, nada é criado) → createPayout com a chave de idempotência gerada no render do formulário.
 */
export async function createPayoutAction(prev: PayoutFormState, fd: FormData): Promise<PayoutFormState> {
  const { user, merchant } = await painelSession();
  const values = {
    amount: formText(fd, "amount"),
    pixKeyType: formText(fd, "pixKeyType"),
    pixKey: formText(fd, "pixKey"),
    description: formText(fd, "description"),
  };
  const fail = (error: string) => ({ error, values, attempt: (prev?.attempt ?? 0) + 1 });

  const input = formInput(payoutInput, fd); // inclui o formato da chave Pix: erro aqui não gasta o código
  if (!input.success) return fail(firstIssue(input.error));
  const { idempotencyKey, amount, pixKeyType, pixKey, description } = input.data;
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return fail(totpProblem);

  let payoutId: string;
  let replayed: boolean;
  try {
    const r = await createPayout(
      merchant.id,
      { amount, pix_key: pixKey, pix_key_type: pixKeyType, ...(description && { description }) },
      idempotencyKey,
    );
    payoutId = r.payout.id;
    replayed = r.replayed;
  } catch (e) {
    if (e instanceof PayoutError) {
      if (e.code === "idempotency_conflict") {
        return fail("Este formulário já foi usado em outro saque. Recarregue a página para fazer um saque novo.");
      }
      return fail(e.message); // saldo insuficiente, chave inválida, conta inativa: textos do serviço, em português
    }
    logError("painel: saque falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
  after(() => dispatchDue()); // payout.completed/failed já na fila sai agora, não no próximo tick do cron
  revalidatePath("/painel", "layout");
  // Mesma chave de idempotência e mesmo conteúdo: o serviço devolve o saque que já existia (replayed).
  redirect(`/painel/saques?feito=${payoutId}${replayed ? "&repetido=1" : ""}`);
}
