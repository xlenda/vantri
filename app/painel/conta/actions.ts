"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/components/ui/action-form";
import { accessSession, GENERIC_ERROR, totpCode } from "@/app/conta/acesso";
import { verifyPassword } from "@/lib/auth/password";
import { beginTotpRotation, confirmTotpRotation } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { revokeOtherSessions, revokeSession } from "@/lib/services/sessions";
import { firstIssue, formInput } from "../input";
import { freshTotpProblem, painelSession } from "../lib";
import { ROTATION_COOKIE_OPTIONS, TOTP_ROTATION_COOKIE } from "./rotation";

const PAGE = "/painel/conta";

const reconfigInput = z.strictObject({
  password: z.string().min(1, "Digite a sua senha atual.").max(256, "Senha atual incorreta."),
});
// Id da sessão = sha256 do token, em hex: formato conferido antes de consultar.
const sessionInput = z.strictObject({ id: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * Reconfigurar o próprio 2FA (trocou de celular/app). Ordem: formato (não gasta o código) → código atual pelo
 * freshTotpProblem (o mesmo consumo de passo do saque) → senha atual → segredo novo pendente num cookie httpOnly desta
 * sessão → /painel/conta/2fa (QR novo + confirmação). Nada muda no banco aqui: o 2FA atual continua valendo até o
 * app novo ser confirmado, então não há janela em que quem souber a senha cadastre o próprio 2FA. A senha vem depois
 * do código: quem só tem o cookie de sessão não testa senhas aqui.
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
    (await cookies()).set(TOTP_ROTATION_COOKIE, beginTotpRotation(user.id, s.session.id), ROTATION_COOKIE_OPTIONS);
  } catch (e) {
    logError("painel: reconfigurar 2FA falhou", e, { user: user.id });
    return { error: GENERIC_ERROR };
  }
  redirect(`${PAGE}/2fa`);
}

/**
 * Confirma o app novo: o código dele troca o segredo e encerra as outras sessões abertas, numa transação só (o antigo
 * deixa de valer e quem estava nas outras sessões cai junto). O cookie some; esta sessão continua.
 */
export async function confirmTotpRotationAction(_prev: { error: string } | undefined, fd: FormData) {
  const { user } = await painelSession();
  const { s } = await accessSession();
  const jar = await cookies();
  const code = totpCode(fd);
  if (!code || !(await confirmTotpRotation(user.id, s.session.id, jar.get(TOTP_ROTATION_COOKIE)?.value, code))) {
    return {
      error:
        "Código inválido. Confira se leu o QR code desta página no app novo e se a data e a hora do celular estão automáticas. Se passaram 10 minutos, volte a Minha conta e comece de novo.",
    };
  }
  jar.delete({ name: TOTP_ROTATION_COOKIE, path: PAGE });
  revalidatePath(PAGE);
  redirect(`${PAGE}?ok=2fa`);
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
