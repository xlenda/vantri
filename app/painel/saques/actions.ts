"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { verifyUserTotp } from "@/lib/auth/session";
import { logError } from "@/lib/log";
import { createPayout, PayoutError } from "@/lib/services/payouts";
import { hasControlChars, painelSession, parseReais, phoneKey, PIX_KEY_TYPES, type PixKeyType } from "../lib";

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

  const idempotencyKey = formText(fd, "idempotencyKey");
  if (!/^[A-Za-z0-9]{24}$/.test(idempotencyKey)) return fail("Formulário expirado. Recarregue a página e tente de novo.");
  const amount = parseReais(values.amount);
  if (amount === null) return fail("Valor inválido. Digite em reais, por exemplo 150,00 ou 1.234,56.");
  if (amount < 100) return fail("O valor mínimo do saque é R$ 1,00.");
  if (amount > 5_000_000) return fail("O valor máximo por saque é R$ 50.000,00.");
  const type = PIX_KEY_TYPES.find(([t]) => t === values.pixKeyType)?.[0] as PixKeyType | undefined;
  if (!type) return fail("Escolha o tipo da chave Pix.");
  const pixKey = type === "phone" ? phoneKey(values.pixKey) : values.pixKey.trim();
  if (!pixKey || pixKey.length > 100) return fail("Informe a chave Pix de destino.");
  const description = values.description.trim();
  if (description.length > 140) return fail("A descrição pode ter até 140 caracteres.");
  if (hasControlChars(description)) return fail("A descrição tem caracteres inválidos.");
  const code = formText(fd, "code").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return fail("Digite o código de 6 dígitos do app autenticador.");

  if (!(await verifyUserTotp(user.id, code))) {
    return fail("Código de verificação inválido ou já usado. Espere o próximo código no app e tente de novo.");
  }

  let payoutId: string;
  try {
    const { payout } = await createPayout(
      merchant.id,
      { amount, pix_key: pixKey, pix_key_type: type, ...(description && { description }) },
      idempotencyKey,
    );
    payoutId = payout.id;
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
  revalidatePath("/painel", "layout");
  redirect(`/painel/saques?feito=${payoutId}`);
}
