"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { randomBase62 } from "@/lib/crypto";
import { logError } from "@/lib/log";
import { simulator } from "@/lib/provider/simulator";
import { applyChargePaid, ChargeError, createCharge, getCharge } from "@/lib/services/charges";
import { CHARGE_EXPIRY, hasControlChars, painelSession, parseReais } from "../lib";

export type ChargeFormValues = { amount: string; description: string; expiresIn: string };
// `attempt` muda a cada envio: o formulário usa como key (o reset automático do React 19 perderia o select).
export type ChargeFormState = { error: string; values: ChargeFormValues; attempt: number } | undefined;

export async function createChargeAction(prev: ChargeFormState, fd: FormData): Promise<ChargeFormState> {
  const { merchant } = await painelSession();
  const values = { amount: formText(fd, "amount"), description: formText(fd, "description"), expiresIn: formText(fd, "expiresIn") };
  const fail = (error: string) => ({ error, values, attempt: (prev?.attempt ?? 0) + 1 });

  const amount = parseReais(values.amount);
  if (amount === null) return fail("Valor inválido. Digite em reais, por exemplo 49,90 ou 1.234,56.");
  const expiresIn = Number(values.expiresIn);
  if (!CHARGE_EXPIRY.some(([s]) => s === expiresIn)) return fail("Escolha uma validade da lista.");
  const description = values.description.trim();
  if (description.length > 140) return fail("A descrição pode ter até 140 caracteres.");
  if (hasControlChars(description)) return fail("A descrição tem caracteres inválidos.");

  let id: string;
  try {
    const { charge } = await createCharge(merchant.id, {
      external_ref: `painel_${randomBase62(24)}`, // cada envio é uma cobrança nova; o botão trava enquanto envia
      amount,
      ...(description && { description }),
      expires_in: expiresIn,
    });
    id = charge.id;
  } catch (e) {
    // Mensagens dos códigos de negócio já são em português e sem dado interno.
    if (e instanceof ChargeError && (e.code === "invalid_request" || e.code === "merchant_inactive")) return fail(e.message);
    logError("painel: criar cobrança falhou", e, { merchant: merchant.id });
    return fail(e instanceof ChargeError && e.code === "provider_error" ? e.message : GENERIC_ERROR);
  }
  redirect(`/painel/cobrancas?id=${id}`);
}

/** Só com PIX_PROVIDER=simulator e só para cobrança pendente do próprio lojista. */
export async function simulatePaymentAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  if (process.env.PIX_PROVIDER !== "simulator") redirect("/painel/cobrancas");
  const c = await getCharge(merchant.id, formText(fd, "id")); // de outro lojista → null
  if (!c) redirect("/painel/cobrancas");
  if (c.status === "pending") {
    let ok = true;
    try {
      await applyChargePaid(simulator.simulatePaid(c.providerChargeId));
    } catch (e) {
      logError("painel: simular pagamento falhou", e, { merchant: merchant.id, charge: c.id });
      ok = false;
    }
    if (!ok) redirect(`/painel/cobrancas?id=${c.id}&erro=simulacao`);
    revalidatePath("/painel", "layout");
  }
  redirect(`/painel/cobrancas?id=${c.id}`);
}
