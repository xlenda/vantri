import { logError } from "@/lib/log";

let warned = false;

/** Cloudflare Turnstile. Sem TURNSTILE_SECRET_KEY a verificação fica desligada (aviso uma vez). */
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (!warned) {
      warned = true;
      console.warn("TURNSTILE_SECRET_KEY não definida: verificação do Turnstile desligada");
    }
    return true;
  }
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
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
