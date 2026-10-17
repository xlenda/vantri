import { logError } from "@/lib/log";

let warned = false;

/**
 * Turnstile só fica ligado com o PAR de chaves: a pública desenha o widget, a secreta confere o token. Par
 * incompleto = desligado + log uma vez (Ruling 37): só com a secreta, todo login falharia; só com a pública, o
 * desafio não valeria nada.
 */
export function turnstileMode(): "on" | "off" {
  const site = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  const secret = !!process.env.TURNSTILE_SECRET_KEY?.trim();
  if (site && secret) return "on";
  if (!warned) {
    warned = true;
    if (site || secret) {
      logError("turnstile: só uma das duas chaves está definida; verificação desligada", new Error("par incompleto"), {
        faltando: site ? "TURNSTILE_SECRET_KEY" : "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
      });
    } else console.warn("Turnstile sem chaves: verificação desligada");
  }
  return "off";
}

/** Produção sem o Turnstile ligado: cadastro público fechado. O login continua (tem bloqueio e limite por IP). */
export const signupClosed = () => process.env.VERCEL_ENV === "production" && turnstileMode() === "off";

/** Cloudflare Turnstile. Desligado (turnstileMode) passa; ligado, confere o token na Cloudflare. */
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (turnstileMode() === "off") return true;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY!.trim(), response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { success?: unknown }).success === true;
  } catch (e) {
    // Falha de rede/timeout: nega (fechado por padrão).
    logError("Falha ao verificar Turnstile", e);
    return false;
  }
}
