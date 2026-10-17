import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSession } from "@/lib/auth/guards";
import { dropIfInactiveMerchant, SESSION_COOKIE, type SessionInfo } from "@/lib/auth/session";

// Apoio das telas de acesso (sem "use server": nada aqui vira endpoint de Server Action).

export const GENERIC_ERROR = "Não foi possível concluir agora. Tente de novo em instantes.";
export const TURNSTILE_ERROR = "Não conseguimos confirmar que você é uma pessoa. Refaça a verificação e tente de novo.";
export const SIGNUP_CLOSED = "Cadastro temporariamente indisponível.";

/** Valor de texto do formulário; ausente ou arquivo vira "". */
export function formText(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

const totpSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

/** Código do app autenticador (espaços ignorados); null se não forem 6 dígitos. */
export function totpCode(fd: FormData): string | null {
  const r = totpSchema.safeParse({ code: formText(fd, "code").replace(/\s/g, "") });
  return r.success ? r.data.code : null;
}

export const homeFor = (role: SessionInfo["user"]["role"]) => (role === "admin" ? "/admin" : "/painel");

/**
 * IP do cliente: 1º valor do x-forwarded-for, senão x-real-ip. Sem nenhum: null em produção
 * (quem chama recusa com erro genérico) e "local" fora dela. Nunca devolve string vazia.
 */
export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip")?.trim();
  return ip || (process.env.NODE_ENV === "production" ? null : "local");
}

/**
 * Sessão para /entrar/2fa, /conta/2fa, /conta/senha e as ações delas. Não usa requireUser, que mandaria
 * para estas mesmas páginas. Sem sessão → /entrar; lojista que não está ativo perde a sessão → /entrar?motivo=suspenso.
 */
export async function accessSession(): Promise<{ s: SessionInfo; token: string }> {
  const s = await getSession();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!s || !token) redirect("/entrar");
  if ((await dropIfInactiveMerchant(s)).dropped) redirect("/entrar?motivo=suspenso");
  return { s, token };
}
