"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { GENERIC_ERROR } from "@/app/conta/acesso";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, parseReais } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { charges, medCases } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { simulator } from "@/lib/provider/simulator";
import { addMedNote } from "@/lib/services/admin/med-queue";
import { applyMedClosed, applyMedOpened, getMedCase, MedError } from "@/lib/services/med";
import { formFields } from "../format";

function fail(e: unknown, context: string, ids: Record<string, string>): { error: string } {
  if (e instanceof MedError) return { error: e.message }; // mensagens do serviço já são em PT e sem dado interno
  logError(context, e, ids);
  return { error: GENERIC_ERROR };
}

const simulated = () => process.env.PIX_PROVIDER === "simulator";

function refresh() {
  revalidatePath("/admin/med");
  revalidatePath("/admin");
}

const openForm = z.strictObject({ chargeId: z.string().trim().max(64), amount: z.string().max(32) });

/** Só com o simulador: abre um MED numa cobrança paga, pelo mesmo caminho de um evento do parceiro. */
export async function openTestMedAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "med:operar" });
  if (!simulated()) return { error: "MED de teste só existe no ambiente de simulação." };
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
  if (amount === null) return { error: "Valor inválido. Escreva, por exemplo, 40,00 ou 1.000,00." };
  if (amount < 1 || amount > c.amountCents) {
    return { error: "O valor do MED vai de R$ 0,01 até o valor da cobrança." };
  }
  // Todos os MEDs da cobrança contam, em qualquer status. SUM é bigint (string no postgres-js): mapWith(Number).
  // ponytail: checa e depois abre (corrida entre dois cliques passa); é só o simulador, sem trava.
  const [{ used }] = await db()
    .select({ used: sql`coalesce(sum(${medCases.amountCents}), 0)`.mapWith(Number) })
    .from(medCases)
    .where(eq(medCases.chargeId, chargeId));
  if (used + amount > c.amountCents) {
    return {
      error: `A soma dos MEDs desta cobrança passaria do valor dela. Ainda cabe até ${brl(Math.max(0, c.amountCents - used))}.`,
    };
  }

  try {
    // Com o autor: a linha do tempo marca 'admin' (não 'provider') e o audit_log grava med.open_test.
    const r = await applyMedOpened(simulator.simulateMed(c.providerChargeId, amount), user.id);
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

/** Só com o simulador. Encerra: a favor do lojista (libera o bloqueio) ou com devolução ao pagador (debita). */
export async function closeMedAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "med:operar" });
  // Com o parceiro real o desfecho chega pelo webhook dele; encerrar aqui faria o nosso razão divergir.
  if (!simulated()) {
    return { error: "Encerrar MED pelo admin só existe no ambiente de simulação; com o parceiro, o desfecho vem dele." };
  }
  const input = closeForm.safeParse(formFields(fd, ["caseId", "outcome"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { caseId, outcome } = input.data;
  const c = await getMedCase(null, caseId);
  if (!c) return { error: "Caso de MED não encontrado." };

  try {
    const r = await applyMedClosed({ type: "med.closed", providerCaseId: c.providerCaseId, outcome }, user.id);
    if (r !== "closed") return { error: "Este MED já está encerrado." };
  } catch (e) {
    return fail(e, "admin: falha ao encerrar MED", { medCase: caseId });
  }
  refresh();
  return { ok: outcome === "merchant_won" ? "MED encerrado a favor do lojista." : "MED encerrado com devolução ao pagador." };
}

// Tamanho de verdade (1–2000 depois do trim) é regra do serviço, com mensagem própria.
const noteForm = z.strictObject({ caseId: z.uuid(), note: z.string().max(10_000) });

/** Anotação interna no caso: só a equipe vê; entra na linha do tempo e no audit_log com o autor. */
export async function addMedNoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireAdmin({ perm: "med:operar" });
  const input = noteForm.safeParse(formFields(fd, ["caseId", "note"]));
  if (!input.success) return { error: "Pedido inválido." };
  const { caseId, note } = input.data;
  try {
    await addMedNote(caseId, user.id, note);
  } catch (e) {
    return fail(e, "admin: falha ao anotar MED", { medCase: caseId });
  }
  revalidatePath(`/admin/med/${caseId}`);
  return { ok: "Anotação salva." };
}
