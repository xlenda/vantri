import { generateSecret, generateURI, verify } from "otplib";

export function newTotpSecret(): string {
  return generateSecret();
}

export function totpUri(secret: string, email: string): string {
  return generateURI({ issuer: "Vantri", label: email, secret });
}

/**
 * Aceita o código do passo atual e de ±1 passo (30 s). Devolve o passo RFC 6238 que casou
 * (para o anti-replay) ou null. Entrada fora de 6 dígitos → null.
 */
export async function checkTotpStep(secret: string, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const r = await verify({ secret, token: code, epochTolerance: 30 });
  // O tipo é a união TOTP|HOTP; só o resultado TOTP válido traz timeStep.
  return r.valid && "timeStep" in r ? r.timeStep : null;
}

export async function checkTotp(secret: string, code: string): Promise<boolean> {
  return (await checkTotpStep(secret, code)) !== null;
}
