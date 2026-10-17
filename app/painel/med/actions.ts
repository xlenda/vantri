"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { logError } from "@/lib/log";
import { MedError, submitDefense } from "@/lib/services/med";
import { painelSession } from "../lib";

export type DefenseState = { error: string; text: string; attempt: number } | undefined;

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Tipo, tamanho, prazo, status e dono do caso: quem decide é o submitDefense (o tipo pelo conteúdo, não pelo nome). */
export async function submitDefenseAction(prev: DefenseState, fd: FormData): Promise<DefenseState> {
  const { merchant } = await painelSession();
  const caseId = formText(fd, "caseId");
  const text = formText(fd, "text");
  const fail = (error: string) => ({ error, text, attempt: (prev?.attempt ?? 0) + 1 });

  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  // Recusa cedo, antes de ler os bytes para a memória; o serviço confere de novo.
  if (files.length > MAX_FILES) return fail(`Envie no máximo ${MAX_FILES} arquivos.`);
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return fail("Cada arquivo pode ter até 5 MB.");

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
