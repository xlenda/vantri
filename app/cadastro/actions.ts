"use server";

import { redirect } from "next/navigation";
import { logError } from "@/lib/log";
import { rateLimit } from "@/lib/ratelimit";
import { MerchantError, type MerchantErrorCode, signupMerchant } from "@/lib/services/merchants";
import { verifyTurnstile } from "@/lib/turnstile";
import { clientIp, formText, GENERIC_ERROR, TURNSTILE_ERROR } from "../conta/acesso";

// Lista branca: só estes campos chegam ao signupMerchant (que ainda valida com zod .strict()).
const FIELDS = ["legalName", "tradeName", "documentType", "document", "segment", "email"] as const;
export type SignupValues = Record<(typeof FIELDS)[number], string> & { noBetting: boolean };
// `attempt` muda a cada envio: o formulário usa como key (o reset automático do React 19 perde select e rádio).
export type SignupState = { error: string; values: SignupValues; attempt: number } | undefined;

const SIGNUP_ERRORS: Record<MerchantErrorCode, string> = {
  invalid_request: "Confira os dados: nomes com pelo menos 2 letras, e-mail válido e senha de 12 a 256 caracteres.",
  invalid_document: "Documento inválido. Confira o número do CPF ou do CNPJ.",
  segment_not_allowed: "Escolha um dos segmentos da lista.",
  betting_cnae: "Não atendemos apostas nem jogos de azar.",
  cnpj_inactive: "Este CNPJ não está ativo na Receita Federal.",
  cnpj_lookup_unavailable: "Não conseguimos consultar o CNPJ agora. Tente de novo em instantes.",
  document_taken: "Já existe um cadastro com este documento.",
  email_taken: "Já existe um cadastro com este e-mail.",
  not_found: GENERIC_ERROR,
  invalid_status: GENERIC_ERROR,
  provider_error: GENERIC_ERROR,
};

export async function signupAction(prev: SignupState, fd: FormData): Promise<SignupState> {
  const fields = Object.fromEntries(FIELDS.map((k) => [k, formText(fd, k)])) as Record<(typeof FIELDS)[number], string>;
  const noBetting = formText(fd, "noBetting") === "sim";
  const fail = (error: string) => ({ error, values: { ...fields, noBetting }, attempt: (prev?.attempt ?? 0) + 1 });

  if (!noBetting) return fail("Para criar a conta, declare que não opera apostas nem jogos de azar.");
  const password = formText(fd, "password");
  if (password !== formText(fd, "passwordConfirm")) return fail("A confirmação não é igual à senha.");

  const ip = await clientIp();
  if (!ip) return fail(GENERIC_ERROR);
  if (!(await verifyTurnstile(formText(fd, "cf-turnstile-response") || undefined, ip))) return fail(TURNSTILE_ERROR);
  // Cada cadastro gasta argon2 e uma consulta de CNPJ: limite por IP.
  if (!(await rateLimit(`signup:ip:${ip}`, 10, 60 * 60)).ok) {
    return fail("Muitos cadastros a partir desta conexão. Tente de novo mais tarde.");
  }

  try {
    await signupMerchant({ ...fields, password });
  } catch (e) {
    if (e instanceof MerchantError) return fail(SIGNUP_ERRORS[e.code]);
    logError("cadastro: falha ao cadastrar lojista", e);
    return fail(GENERIC_ERROR);
  }
  redirect("/cadastro?enviado=1");
}
