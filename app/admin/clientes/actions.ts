"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import {
  adminCreateMerchant,
  approveMerchant,
  MerchantError,
  type MerchantErrorCode,
  reactivateMerchant,
  rejectMerchant,
  suspendMerchant,
  updateFees,
} from "@/lib/services/merchants";
import { formFields, parsePercent, parseReais } from "../format";

const MERCHANT_ERRORS: Record<MerchantErrorCode, string> = {
  invalid_request: "Confira os dados: nomes com pelo menos 2 letras e um e-mail válido.",
  invalid_document: "Documento inválido. Confira o número do CPF ou do CNPJ.",
  segment_not_allowed: "Escolha um dos segmentos da lista.",
  betting_cnae: "Este CNPJ tem CNAE de apostas. Não atendemos apostas nem jogos de azar.",
  cnpj_inactive: "Este CNPJ não está ativo na Receita Federal.",
  cnpj_lookup_unavailable: "Não foi possível consultar o CNPJ na Receita agora. Tente de novo em instantes.",
  document_taken: "Já existe um cadastro com este documento.",
  email_taken: "Já existe um cadastro com este e-mail.",
  not_found: "Cliente não encontrado.",
  invalid_status: "Ação não permitida no status atual do cliente.",
  provider_error: "Não foi possível abrir a conta no parceiro. Tente de novo.",
};

/** Erro do serviço → mensagem em PT. A causa (do parceiro ou do banco) vai só para o log. */
function fail(e: unknown, context: string, ids: Record<string, string> = {}): { error: string } {
  if (e instanceof MerchantError) {
    if (e.code === "provider_error") logError(context, e.cause, ids);
    return { error: MERCHANT_ERRORS[e.code] };
  }
  logError(context, e, ids);
  return { error: GENERIC_ERROR };
}

const CREATE_FIELDS = ["legalName", "tradeName", "documentType", "document", "segment", "email"] as const;
export type CreateValues = Record<(typeof CREATE_FIELDS)[number], string>;
// `attempt` muda a cada erro: o formulário usa como key para remontar com os valores devolvidos.
export type CreateState =
  | { created: { merchantId: string; email: string; tempPassword: string } }
  | { error: string; values: CreateValues; attempt: number }
  | undefined;

/** Cria o cliente já ativo. A senha temporária só existe nesta resposta (o banco guarda o hash). */
export async function createMerchantAction(prev: CreateState, fd: FormData): Promise<CreateState> {
  const { user } = await requireUser({ role: "admin" });
  // Lista branca aqui; adminCreateMerchant valida com zod strictObject.
  const values = formFields(fd, CREATE_FIELDS);
  try {
    const created = await adminCreateMerchant(values, user.id);
    revalidatePath("/admin/clientes");
    return { created };
  } catch (e) {
    const attempt = (prev && "attempt" in prev ? prev.attempt : 0) + 1;
    return { ...fail(e, "admin: falha ao criar cliente"), values, attempt };
  }
}

const MAX_BPS = 10_000; // 100%
const MAX_FIXED_CENTS = 100_000; // R$ 1.000,00 — mesmos tetos de updateFees
const FEE_FIELDS = ["merchantId", "feeInPercent", "feeInFixed", "feeOutPercent", "feeOutFixed"] as const;
const feesForm = z.strictObject({
  merchantId: z.uuid(),
  feeInPercent: z.string().max(32),
  feeInFixed: z.string().max(32),
  feeOutPercent: z.string().max(32),
  feeOutFixed: z.string().max(32),
});

/** Taxas digitadas em % (até 2 casas) e R$; gravadas em pontos-base e centavos. */
export async function updateFeesAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireUser({ role: "admin" });
  const input = feesForm.safeParse(formFields(fd, FEE_FIELDS));
  if (!input.success) return { error: "Pedido inválido." };
  const f = input.data;
  const bps = [parsePercent(f.feeInPercent), parsePercent(f.feeOutPercent)];
  const cents = [parseReais(f.feeInFixed), parseReais(f.feeOutFixed)];
  if (bps.some((v) => v === null || v > MAX_BPS)) {
    return { error: "Taxa percentual inválida: use de 0 a 100, com até 2 casas (ex.: 1,49)." };
  }
  if (cents.some((v) => v === null || v > MAX_FIXED_CENTS)) {
    return { error: "Taxa fixa inválida: use de R$ 0,00 a R$ 1.000,00, com até 2 casas (ex.: 1,00)." };
  }
  const [feeInBps, feeOutBps] = bps as number[];
  const [feeInFixedCents, feeOutFixedCents] = cents as number[];
  try {
    await updateFees(f.merchantId, { feeInBps, feeInFixedCents, feeOutBps, feeOutFixedCents }, user.id);
  } catch (e) {
    return fail(e, "admin: falha ao atualizar taxas", { merchant: f.merchantId });
  }
  revalidatePath(`/admin/clientes/${f.merchantId}`);
  return { ok: "Taxas atualizadas." };
}

const OPS = {
  approve: [approveMerchant, "Cliente aprovado."],
  reject: [rejectMerchant, "Cliente recusado."],
  suspend: [suspendMerchant, "Cliente suspenso."],
  reactivate: [reactivateMerchant, "Cliente reativado."],
} as const;
const statusForm = z.strictObject({
  merchantId: z.uuid(),
  op: z.enum(["approve", "reject", "suspend", "reactivate"]),
  manualCheck: z.enum(["", "sim"]),
});

/** Aprovar, recusar, suspender ou reativar. Aprovar cliente em revisão manual exige a confirmação marcada. */
export async function merchantStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireUser({ role: "admin" });
  const input = statusForm.safeParse(formFields(fd, ["merchantId", "op", "manualCheck"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { merchantId, op, manualCheck } = input.data;

  if (op === "approve" && manualCheck !== "sim") {
    // Lido do banco, nunca do formulário: o CNPJ não foi consultado na Receita no cadastro.
    const [m] = await db()
      .select({ needsManualReview: merchants.needsManualReview })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    if (m?.needsManualReview) return { error: "Marque “Conferi o CNPJ e o CNAE manualmente” para aprovar." };
  }

  const [run, done] = OPS[op];
  try {
    await run(merchantId, user.id);
  } catch (e) {
    return fail(e, `admin: falha ao ${op} cliente`, { merchant: merchantId });
  } finally {
    revalidatePath("/admin/clientes");
    revalidatePath(`/admin/clientes/${merchantId}`);
  }
  return { ok: done };
}
