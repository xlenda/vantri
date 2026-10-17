"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { charges } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { simulator } from "@/lib/provider/simulator";
import { applyMedClosed, applyMedOpened, getMedCase, MedError } from "@/lib/services/med";
import { brl, formFields, parseReais } from "../format";

function fail(e: unknown, context: string, ids: Record<string, string>): { error: string } {
  if (e instanceof MedError) return { error: e.message }; // mensagens do serviço já são em PT e sem dado interno
  logError(context, e, ids);
  return { error: GENERIC_ERROR };
}

function refresh() {
  revalidatePath("/admin/med");
  revalidatePath("/admin");
}

const openForm = z.strictObject({ chargeId: z.string().trim().max(64), amount: z.string().max(32) });

/** Só com o simulador: abre um MED numa cobrança paga, pelo mesmo caminho de um evento do parceiro. */
export async function openTestMedAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireUser({ role: "admin" });
  if (process.env.PIX_PROVIDER !== "simulator") return { error: "MED de teste só existe no ambiente de simulação." };
  const input = openForm.safeParse(formFields(fd, ["chargeId", "amount"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { chargeId } = input.data;

  const [c] = z.uuid().safeParse(chargeId).success
    ? await db()
        .select({ status: charges.status, amountCents: charges.amountCents, providerChargeId: charges.providerChargeId })
        .from(charges)
        .where(eq(charges.id, chargeId))
    : [];
  if (!c) return { error: "Cobrança não encontrada." };
  if (c.status !== "paid") return { error: "Só dá para abrir MED numa cobrança paga." };
  const amount = parseReais(input.data.amount);
  if (amount === null || amount < 1 || amount > c.amountCents) {
    return { error: "O valor do MED vai de R$ 0,01 até o valor da cobrança." };
  }

  try {
    const r = await applyMedOpened(simulator.simulateMed(c.providerChargeId, amount));
    if (r !== "opened") {
      logError("admin: MED de teste não abriu", new Error(r), { charge: chargeId });
      return { error: GENERIC_ERROR };
    }
  } catch (e) {
    return fail(e, "admin: falha ao abrir MED de teste", { charge: chargeId });
  }
  refresh();
  return { ok: `MED de teste aberto. ${brl(amount)} bloqueados no saldo do cliente.` };
}

const closeForm = z.strictObject({ caseId: z.uuid(), outcome: z.enum(["merchant_won", "payer_refunded"]) });

/** Encerra o caso: a favor do lojista (libera o bloqueio) ou com devolução ao pagador (debita o bloqueio). */
export async function closeMedAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireUser({ role: "admin" });
  const input = closeForm.safeParse(formFields(fd, ["caseId", "outcome"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { caseId, outcome } = input.data;
  const c = await getMedCase(null, caseId);
  if (!c) return { error: "Caso de MED não encontrado." };

  try {
    const r = await applyMedClosed({ type: "med.closed", providerCaseId: c.providerCaseId, outcome });
    if (r !== "closed") return { error: "Este MED já está encerrado." };
  } catch (e) {
    return fail(e, "admin: falha ao encerrar MED", { medCase: caseId });
  }
  refresh();
  return { ok: outcome === "merchant_won" ? "MED encerrado a favor do lojista." : "MED encerrado com devolução ao pagador." };
}
