"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { accessSession, GENERIC_ERROR } from "@/app/conta/acesso";
import { verifyPassword } from "@/lib/auth/password";
import { db } from "@/lib/db/client";
import { sessions, users } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { revokeOtherSessions, revokeSession } from "@/lib/services/sessions";
import { firstIssue, formInput } from "../input";
import { freshTotpProblem, painelSession } from "../lib";

const PAGE = "/painel/conta";

const reconfigInput = z.strictObject({
  password: z.string().min(1, "Digite a sua senha atual.").max(256, "Senha atual incorreta."),
});
// Id da sessão = sha256 do token, em hex: formato conferido antes de consultar.
const sessionInput = z.strictObject({ id: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * Reconfigurar o próprio 2FA (trocou de celular/app). Ordem: formato (não gasta o código) → código atual pelo
 * freshTotpProblem (o mesmo consumo de passo do saque) → senha atual → desliga o 2FA e encerra as outras sessões →
 * /conta/2fa, o fluxo da ativação (QR novo + confirmação). A senha vem depois do código: quem só tem o cookie não
 * testa senhas aqui. Encerrar as outras impede que outra sessão aberta leia o QR no lugar do dono.
 */
export async function reconfigureTotpAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const { user } = await painelSession();
  const { s } = await accessSession();
  const input = formInput(reconfigInput, fd);
  if (!input.success) return { error: firstIssue(input.error) };
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return { error: totpProblem };

  try {
    const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    if (!u || !(await verifyPassword(u.hash, input.data.password))) {
      return { error: "Senha atual incorreta. Espere o próximo código no app e tente de novo." };
    }
    // Mesmo efeito do reset de 2FA pelo admin, mas esta sessão fica: é ela que lê o QR novo.
    await db().transaction(async (tx) => {
      await tx.update(users).set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, s.session.id)));
    });
  } catch (e) {
    logError("painel: reconfigurar 2FA falhou", e, { user: user.id });
    return { error: GENERIC_ERROR };
  }
  redirect("/conta/2fa");
}

/** Encerra uma sessão do próprio usuário (id de outro usuário não apaga nada). Resultado na URL. */
export async function revokeSessionAction(fd: FormData): Promise<void> {
  const { user } = await painelSession();
  const input = formInput(sessionInput, fd);
  let ok = false;
  if (input.success) {
    try {
      ok = await revokeSession(user.id, input.data.id);
    } catch (e) {
      logError("painel: encerrar sessão falhou", e, { user: user.id });
    }
  }
  revalidatePath(PAGE);
  redirect(ok ? `${PAGE}?ok=encerrada` : `${PAGE}?erro=encerrar`);
}

/** "Encerrar as outras": fica só a sessão desta requisição. */
export async function revokeOthersAction(): Promise<void> {
  const { user } = await painelSession();
  const { s } = await accessSession();
  let ok = true;
  try {
    await revokeOtherSessions(user.id, s.session.id);
  } catch (e) {
    logError("painel: encerrar outras sessões falhou", e, { user: user.id });
    ok = false;
  }
  revalidatePath(PAGE);
  redirect(ok ? `${PAGE}?ok=outras` : `${PAGE}?erro=encerrar`);
}
