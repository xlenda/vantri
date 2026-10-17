"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { brl } from "@/lib/br/money";
import { logError } from "@/lib/log";
import { computeFee } from "@/lib/money/fees";
import { getBalance } from "@/lib/money/ledger";
import {
  createBatchPayout,
  createPayout,
  getBatch,
  needsBatch,
  payoutCeilingCents,
  PayoutBatchError,
  PayoutError,
  type PayoutRow,
  resumeBatch,
  splitGreedy,
} from "@/lib/services/payouts";
import { dispatchDue } from "@/lib/webhooks/dispatch";
import { firstIssue, formInput, idInput, payoutInput } from "../input";
import { freshTotpProblem, painelSession } from "../lib";

export type PayoutFormValues = { amount: string; pixKeyType: string; pixKey: string; description: string };
export type PayoutFormState = { error: string; values: PayoutFormValues; attempt: number } | undefined;

/** Passo Revisão: tudo calculado no servidor, com as regras do serviço (tarifa por parcela, teto, saldo). */
export type PayoutPreview = {
  amountCents: number;
  feeCents: number; // no parcelado, a soma das tarifas das parcelas
  totalCents: number; // valor + tarifa: o que sai do saldo
  availableCents: number;
  afterCents: number; // saldo depois; negativo = não cabe
  pixKeyType: PayoutRow["pixKeyType"];
  pixKey: string; // como vai para o serviço (celular já em +55…)
  description: string;
  ceilingCents: number;
  parcels: { amountCents: number; feeCents: number }[] | null; // null = saque avulso
};
export type PreviewState =
  | { error: string; values: PayoutFormValues; attempt: number }
  | { preview: PayoutPreview; values: PayoutFormValues; attempt: number }
  | undefined;
export type ResumeState = { error: string; attempt: number } | undefined;

const SAME_FORM = "Este formulário já foi usado em outro saque. Recarregue a página para fazer um saque novo.";

const valuesOf = (fd: FormData): PayoutFormValues => ({
  amount: formText(fd, "amount"),
  pixKeyType: formText(fd, "pixKeyType"),
  pixKey: formText(fd, "pixKey"),
  description: formText(fd, "description"),
});

/**
 * Saque pelo painel. Ordem: formato dos campos (erro aqui não gasta o código) → código 2FA com anti-replay
 * (errado: para aqui, nada é criado) → createPayout com a chave de idempotência gerada no render do formulário.
 */
export async function createPayoutAction(prev: PayoutFormState, fd: FormData): Promise<PayoutFormState> {
  const { user, merchant } = await painelSession();
  const values = valuesOf(fd);
  const fail = (error: string) => ({ error, values, attempt: (prev?.attempt ?? 0) + 1 });

  const input = formInput(payoutInput, fd); // inclui o formato da chave Pix: erro aqui não gasta o código
  if (!input.success) return fail(firstIssue(input.error));
  const { idempotencyKey, amount, pixKeyType, pixKey, description } = input.data;
  // Acima do teto por transferência o saque só sai em parcelas (createBatchPayoutAction); conferido antes do código.
  const ceiling = payoutCeilingCents();
  if (needsBatch(amount, ceiling)) {
    return fail(`Valor acima do limite de ${brl(ceiling)} por transferência. Use Nova transferência para enviar em parcelas.`);
  }
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
      if (e.code === "idempotency_conflict") return fail(SAME_FORM);
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

/**
 * Passo Revisão do assistente: confere os campos (a mesma entrada do saque) e calcula tarifa e saldo depois, sem
 * efeito: nenhum código 2FA lido, nada gravado. Acima do teto, a prévia usa a mesma divisão (splitGreedy) e a mesma
 * tarifa por parcela que o createBatchPayout cobra; quem divide de verdade é o servidor, no envio.
 */
export async function previewPayoutAction(prev: PreviewState, fd: FormData): Promise<PreviewState> {
  const { merchant } = await painelSession();
  const values = valuesOf(fd);
  const attempt = (prev?.attempt ?? 0) + 1;

  const input = formInput(payoutInput, fd);
  if (!input.success) return { error: firstIssue(input.error), values, attempt };
  const { amount, pixKeyType, pixKey, description } = input.data;
  const ceilingCents = payoutCeilingCents();
  const fee = (cents: number) => computeFee(cents, merchant.feeOutBps, merchant.feeOutFixedCents);
  const parcels = needsBatch(amount, ceilingCents)
    ? splitGreedy(amount, ceilingCents).map((c) => ({ amountCents: c, feeCents: fee(c) }))
    : null;
  const feeCents = parcels ? parcels.reduce((sum, p) => sum + p.feeCents, 0) : fee(amount);
  const { available } = await getBalance(merchant.id);
  const totalCents = amount + feeCents;
  return {
    preview: {
      amountCents: amount,
      feeCents,
      totalCents,
      availableCents: available,
      afterCents: available - totalCents,
      pixKeyType,
      pixKey,
      description,
      ceilingCents,
      parcels,
    },
    values,
    attempt,
  };
}

/**
 * Saque parcelado (acima do teto). Mesma ordem do avulso: campos e teto (não gastam o código) → um único código 2FA
 * com anti-replay → createBatchPayout com a chave de idempotência do render. O lote fica no banco: a confirmação e a
 * retomada leem de lá (/painel/saques/novo?lote=…), não da memória do navegador.
 */
export async function createBatchPayoutAction(prev: PayoutFormState, fd: FormData): Promise<PayoutFormState> {
  const { user, merchant } = await painelSession();
  const values = valuesOf(fd);
  const fail = (error: string) => ({ error, values, attempt: (prev?.attempt ?? 0) + 1 });

  const input = formInput(payoutInput, fd);
  if (!input.success) return fail(firstIssue(input.error));
  const { idempotencyKey, amount, pixKeyType, pixKey, description } = input.data;
  if (!needsBatch(amount, payoutCeilingCents())) {
    return fail("Este valor cabe numa transferência só. Volte à revisão e envie de novo.");
  }
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return fail(totpProblem);

  let batch: { batchId: string; replayed: boolean };
  try {
    batch = await createBatchPayout(
      merchant.id,
      { amount, pix_key: pixKey, pix_key_type: pixKeyType, ...(description && { description }) },
      idempotencyKey,
    );
  } catch (e) {
    if (e instanceof PayoutBatchError) return fail(e.code === "idempotency_conflict" ? SAME_FORM : e.message);
    logError("painel: lote de saque falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
  after(() => dispatchDue());
  revalidatePath("/painel", "layout");
  redirect(`/painel/saques/novo?lote=${batch.batchId}${batch.replayed ? "&repetido=1" : ""}`);
}

/**
 * Retomar um lote parcial. O id vem do formulário, mas o lote é lido do banco e só do próprio lojista; outro dono ou
 * lote sem pendência para antes do código (não gasta). Exige código novo (o do envio já foi consumido); o resumeBatch
 * reusa a chave de cada parcela (`${lote}:${i}`), então parcela concluída nunca é paga de novo.
 */
export async function resumeBatchAction(prev: ResumeState, fd: FormData): Promise<ResumeState> {
  const { user, merchant } = await painelSession();
  const fail = (error: string) => ({ error, attempt: (prev?.attempt ?? 0) + 1 });

  const input = formInput(idInput, fd);
  const batch = input.success ? await getBatch(merchant.id, input.data.id) : null;
  if (!batch) return fail("Lote não encontrado.");
  if (batch.status !== "partial") return fail("Este lote não tem parcelas pendentes para retomar.");
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return fail(totpProblem);

  try {
    await resumeBatch(merchant.id, batch.id);
  } catch (e) {
    if (e instanceof PayoutBatchError) return fail(e.message);
    logError("painel: retomar lote falhou", e, { merchant: merchant.id, batch: batch.id });
    return fail(GENERIC_ERROR);
  }
  after(() => dispatchDue());
  revalidatePath("/painel", "layout");
  redirect(`/painel/saques/novo?lote=${batch.id}`);
}
