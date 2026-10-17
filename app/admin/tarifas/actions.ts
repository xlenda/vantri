"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { requireAdmin } from "@/lib/auth/guards";
import { parseReais } from "@/lib/br/money";
import { logError } from "@/lib/log";
import { archiveFeePlan, assignPlanToMerchant, createFeePlan, FeePlanError } from "@/lib/services/admin/fee-plans";
import { MerchantError } from "@/lib/services/merchants";
import { formFields, parsePercent } from "../format";

// Toda ação re-checa a permissão no servidor: o menu esconder "Tarifas" do suporte é só cosmético.
const PERM = { perm: "tarifas:gerir" } as const;

/** Erro do serviço → mensagem dele (PT, sem dado interno). Outro erro: mensagem genérica e a causa só no log. */
function fail(e: unknown, context: string, ids: Record<string, string> = {}): { error: string } {
  if (e instanceof FeePlanError || e instanceof MerchantError) return { error: e.message };
  logError(context, e, ids);
  return { error: GENERIC_ERROR };
}

const FIELDS = ["name", "feeInPercent", "feeInFixed", "feeOutPercent", "feeOutFixed"] as const;

/** Plano novo com as taxas digitadas em % (até 2 casas) e R$; gravadas em pontos-base e centavos. */
export async function createFeePlanAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin(PERM);
  const f = formFields(fd, FIELDS);
  const [feeInBps, feeOutBps] = [parsePercent(f.feeInPercent), parsePercent(f.feeOutPercent)];
  const [feeInFixedCents, feeOutFixedCents] = [parseReais(f.feeInFixed), parseReais(f.feeOutFixed)];
  // Mesmos tetos e mensagens da taxa na página do cliente; o serviço confere de novo.
  if (feeInBps === null || feeOutBps === null || feeInBps > 10_000 || feeOutBps > 10_000) {
    return { error: "Taxa percentual inválida: use de 0 a 100, com até 2 casas (ex.: 1,49)." };
  }
  if (feeInFixedCents === null || feeOutFixedCents === null || feeInFixedCents > 100_000 || feeOutFixedCents > 100_000) {
    return { error: "Taxa fixa inválida: use de R$ 0,00 a R$ 1.000,00, com até 2 casas (ex.: 1,00)." };
  }
  try {
    await createFeePlan({ name: f.name, feeInBps, feeInFixedCents, feeOutBps, feeOutFixedCents }, user.id);
  } catch (e) {
    return fail(e, "admin: falha ao criar plano de tarifa");
  }
  revalidatePath("/admin/tarifas");
  return { ok: "Plano criado." };
}

export async function archiveFeePlanAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin(PERM);
  const { planId } = formFields(fd, ["planId"]); // o serviço valida o formato
  try {
    await archiveFeePlan(planId, user.id);
  } catch (e) {
    return fail(e, "admin: falha ao arquivar plano de tarifa", { plan: planId });
  }
  revalidatePath("/admin/tarifas");
  return { ok: "Plano arquivado. Quem já usa continua com as mesmas taxas." };
}

export async function assignFeePlanAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin(PERM);
  const { merchantId, planId } = formFields(fd, ["merchantId", "planId"]); // o serviço valida o formato
  try {
    await assignPlanToMerchant(merchantId, planId, user.id);
  } catch (e) {
    return fail(e, "admin: falha ao aplicar plano de tarifa", { merchant: merchantId, plan: planId });
  }
  revalidatePath("/admin/tarifas");
  revalidatePath(`/admin/clientes/${merchantId}`);
  return { ok: "Plano aplicado. As novas taxas valem para as próximas transações." };
}
