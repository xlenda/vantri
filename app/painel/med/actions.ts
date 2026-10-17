"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { logError } from "@/lib/log";
import { MedError, submitDefense } from "@/lib/services/med";
import { defenseInput, firstIssue, formInput } from "../input";
import { painelSession } from "../lib";
import { attachmentsTooBig, MED_UPLOAD_ERROR } from "./limits";

export type DefenseState = { error: string; text: string; attempt: number } | undefined;

const MAX_FILES = 5;

/** Tipo, tamanho, prazo, status e dono do caso: quem decide é o submitDefense (o tipo pelo conteúdo, não pelo nome). */
export async function submitDefenseAction(prev: DefenseState, fd: FormData): Promise<DefenseState> {
  const { merchant } = await painelSession();
  const fail = (error: string) => ({ error, text: formText(fd, "text"), attempt: (prev?.attempt ?? 0) + 1 });
  const input = formInput(defenseInput, fd);
  if (!input.success) return fail(firstIssue(input.error));

  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  // Recusa cedo, antes de ler os bytes para a memória; o serviço confere de novo.
  if (files.length > MAX_FILES) return fail(`Envie no máximo ${MAX_FILES} arquivos.`);
  if (attachmentsTooBig(files.map((f) => f.size))) return fail(MED_UPLOAD_ERROR);

  const { caseId, text } = input.data;
  try {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    await submitDefense(merchant.id, caseId, text, payload);
  } catch (e) {
    if (e instanceof MedError) return fail(e.message);
    logError("painel: defesa de MED falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
  revalidatePath("/painel", "layout");
  redirect(`/painel/med?id=${caseId}&enviada=1`);
}
