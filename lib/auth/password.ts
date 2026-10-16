import { hash, verify } from "@node-rs/argon2";

// Parâmetros padrão da lib: argon2id, m=19456 KiB, t=2, p=1.
export function hashPassword(p: string): Promise<string> {
  return hash(p);
}

export function verifyPassword(h: string, p: string): Promise<boolean> {
  return verify(h, p);
}
