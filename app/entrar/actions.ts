"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cookieOptions, login, type LoginResult, logout, passTotp, SESSION_COOKIE } from "@/lib/auth/session";
import { verifyTurnstile } from "@/lib/turnstile";
import { accessSession, clientIp, formText, GENERIC_ERROR, homeFor, totpCode, TURNSTILE_ERROR } from "../conta/acesso";

export type LoginState = { error: string; email: string } | undefined;

const LOGIN_ERRORS: Record<Extract<LoginResult, { ok: false }>["reason"], string> = {
  invalid: "E-mail ou senha incorretos.",
  locked: "Acesso bloqueado por 15 minutos depois de várias tentativas erradas. Tente de novo mais tarde.",
  rate_limited: "Muitas tentativas a partir desta conexão. Aguarde alguns minutos e tente de novo.",
  pending: "Seu cadastro está em análise.",
  suspended: "Sua conta está suspensa.",
};

const loginSchema = z.strictObject({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
});

export async function loginAction(_prev: LoginState, fd: FormData): Promise<LoginState> {
  const email = formText(fd, "email");
  const fail = (error: string) => ({ error, email });

  const ip = await clientIp();
  if (!ip) return fail(GENERIC_ERROR);
  if (!(await verifyTurnstile(formText(fd, "cf-turnstile-response") || undefined, ip))) return fail(TURNSTILE_ERROR);
  const input = loginSchema.safeParse({ email, password: formText(fd, "password") });
  if (!input.success) return fail(LOGIN_ERRORS.invalid);

  const r = await login(input.data.email, input.data.password, ip);
  if (!r.ok) return fail(LOGIN_ERRORS[r.reason]);
  (await cookies()).set(SESSION_COOKIE, r.token, cookieOptions);
  redirect(r.needsTotpSetup ? "/conta/2fa" : "/entrar/2fa");
}

export async function totpLoginAction(_prev: { error: string } | undefined, fd: FormData) {
  const { s, token } = await accessSession();
  const code = totpCode(fd);
  if (!code || !(await passTotp(token, code))) {
    return { error: "Código inválido ou já usado. Confira o app autenticador e tente de novo." };
  }
  redirect(homeFor(s.user.role));
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await logout(token);
  jar.set(SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  redirect("/entrar");
}
