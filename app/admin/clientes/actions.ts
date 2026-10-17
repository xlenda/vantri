"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { requireAdmin } from "@/lib/auth/guards";
import { parseReais } from "@/lib/br/money";
import { logError } from "@/lib/log";
import { MAX_ADJUSTMENT_CENTS } from "@/lib/services/admin/approvals";
import {
  adminCreateMerchant,
  approveMerchant,
  MerchantError,
  type MerchantErrorCode,
  rejectMerchant,
  suspendMerchant,
  updateFees,
} from "@/lib/services/merchants";
import { askApproval } from "../approval-request";
import { formFields, parsePercent } from "../format";

const MERCHANT_ERRORS: Record<MerchantErrorCode, string> = {
  invalid_request: "Confira os dados: nomes com pelo menos 2 letras e um e-mail válido.",
  invalid_document: "Documento inválido. Confira o número do CPF ou do CNPJ.",
  segment_not_allowed: "Escolha um dos segmentos da lista.",
  betting_cnae: "Este CNPJ tem CNAE de apostas. Não atendemos apostas nem jogos de azar.",
  cnpj_inactive: "Este CNPJ não está ativo na Receita Federal.",
  cnpj_lookup_unavailable: "Não foi possível consultar o CNPJ na Receita agora. Tente de novo em instantes.",
  manual_check_required:
    "A Receita continua sem responder. Confira o CNPJ completo e os CNAEs na Receita e marque “Conferi o CNPJ e o CNAE manualmente” para aprovar.",
  document_taken: "Já existe um cadastro com este documento.",
  email_taken: "Já existe um cadastro com este e-mail.",
  not_found: "Cliente não encontrado.",
  invalid_status: "Ação não permitida no status atual do cliente.",
  provider_error: "Não foi possível abrir a conta no parceiro. Tente de novo.",
  needs_approval: "Cliente ativo: a mudança de taxa precisa de quatro olhos. Recarregue a página e peça com motivo e código.",
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
  const { user } = await requireAdmin({ perm: "clientes:cadastro" });
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
const FEE_FIELDS = ["merchantId", "feeInPercent", "feeInFixed", "feeOutPercent", "feeOutFixed", "reason"] as const;
const feesForm = z.strictObject({
  merchantId: z.uuid(),
  feeInPercent: z.string().max(32),
  feeInFixed: z.string().max(32),
  feeOutPercent: z.string().max(32),
  feeOutFixed: z.string().max(32),
  reason: z.string().max(500),
});

/**
 * Taxas digitadas em % (até 2 casas) e R$; gravadas em pontos-base e centavos. Cliente que está ou já esteve ativo
 * (os termos prometem aviso de 30 dias): updateFees recusa a mudança direta (needs_approval, decidido no banco, sem
 * corrida com a aprovação do cliente) e ela vira pedido de quatro olhos, com motivo e código 2FA; o resto muda na hora.
 */
export async function updateFeesAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "taxas:editar" });
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
  const fees = { feeInBps, feeInFixedCents, feeOutBps, feeOutFixedCents };

  try {
    await updateFees(f.merchantId, fees, user.id);
  } catch (e) {
    if (e instanceof MerchantError && e.code === "needs_approval") {
      return askApproval(
        user.id,
        fd,
        "fee_change",
        { merchantId: f.merchantId, ...fees, reason: f.reason },
        "Pedido de mudança de taxa enviado. As taxas só mudam quando outro administrador aprovar em Aprovações.",
        { merchant: f.merchantId },
      );
    }
    return fail(e, "admin: falha ao atualizar taxas", { merchant: f.merchantId });
  }
  revalidatePath(`/admin/clientes/${f.merchantId}`);
  return { ok: "Taxas atualizadas." };
}

const adjustForm = z.strictObject({
  merchantId: z.uuid(),
  direction: z.enum(["credito", "debito"]),
  amount: z.string().max(32),
  reason: z.string().max(500),
});

/** Ajuste manual de saldo (crédito ou débito no disponível): vira pedido de quatro olhos, nunca move na hora. */
export async function requestBalanceAdjustmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "dinheiro:mover" });
  const input = adjustForm.safeParse(formFields(fd, ["merchantId", "direction", "amount", "reason"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { merchantId, direction, amount, reason } = input.data;
  const cents = parseReais(amount);
  if (!cents || cents > MAX_ADJUSTMENT_CENTS) {
    return { error: "Valor inválido: use de R$ 0,01 a R$ 1.000.000,00, com até 2 casas (ex.: 150,00)." };
  }
  return askApproval(
    user.id,
    fd,
    "balance_adjustment",
    { merchantId, amountCents: direction === "debito" ? -cents : cents, reason },
    "Pedido de ajuste enviado. O saldo só muda quando outro administrador aprovar em Aprovações.",
    { merchant: merchantId },
  );
}

type Op = (id: string, actorId: string, manualCheck: boolean) => Promise<void>;
const OPS: Record<"approve" | "reject" | "suspend", readonly [Op, string]> = {
  approve: [(id, actorId, manualCheck) => approveMerchant(id, actorId, { manualCheck }), "Cliente aprovado."],
  reject: [(id, actorId) => rejectMerchant(id, actorId), "Cliente recusado."],
  suspend: [(id, actorId) => suspendMerchant(id, actorId), "Cliente suspenso."],
};
const statusForm = z.strictObject({
  merchantId: z.uuid(),
  op: z.enum(["approve", "reject", "suspend", "reactivate"]),
  manualCheck: z.enum(["", "sim"]),
  reason: z.string().max(500),
});

/**
 * Aprovar, recusar, suspender ou reativar. Aprovar cliente em revisão manual consulta a Receita de novo; a
 * confirmação marcada só vale se ela continuar fora do ar (approveMerchant decide, pelo banco, nunca pelo formulário).
 * Reativar é quatro olhos: vira pedido (motivo + código 2FA) e o cliente só volta quando outro administrador aprovar.
 */
export async function merchantStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "clientes:cadastro" });
  const input = statusForm.safeParse(formFields(fd, ["merchantId", "op", "manualCheck", "reason"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { merchantId, op, manualCheck, reason } = input.data;
  if (op === "reactivate") {
    return askApproval(
      user.id,
      fd,
      "merchant_reactivate",
      { merchantId, reason },
      "Pedido de reativação enviado. O cliente só volta a ativo quando outro administrador aprovar em Aprovações.",
      { merchant: merchantId },
    );
  }

  const [run, done] = OPS[op];
  try {
    await run(merchantId, user.id, manualCheck === "sim");
  } catch (e) {
    return fail(e, `admin: falha ao ${op} cliente`, { merchant: merchantId });
  } finally {
    revalidatePath("/admin/clientes");
    revalidatePath(`/admin/clientes/${merchantId}`);
  }
  return { ok: done };
}
