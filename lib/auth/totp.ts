import { generateSecret, generateURI, verify } from "otplib";

export function newTotpSecret(): string {
  return generateSecret();
}

export function totpUri(secret: string, email: string): string {
  return generateURI({ issuer: "Vantri", label: email, secret });
}

/** Aceita o código do passo atual e de ±1 passo (30 s). Entrada fora de 6 dígitos → false. */
export async function checkTotp(secret: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  return (await verify({ secret, token: code, epochTolerance: 30 })).valid;
}
