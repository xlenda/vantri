import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY não definida");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) {
    throw new Error(`APP_ENCRYPTION_KEY deve ser base64 de exatamente 32 bytes (veio ${k.length})`);
  }
  return k;
}

/** AES-256-GCM. Formato: `v1:<iv b64>:<tag b64>:<ct b64>`. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const b64 = (b: Buffer) => b.toString("base64");
  return `v1:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
}

export function decrypt(enc: string): string {
  const [v, iv, tag, ct, ...rest] = enc.split(":");
  if (v !== "v1" || ct === undefined || rest.length) throw new Error("Texto cifrado em formato inválido");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"), { authTagLength: 16 });
  try {
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new Error("Falha ao descriptografar: dado adulterado ou chave errada", { cause });
  }
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * HMAC-SHA256 determinístico para índice único de dado pessoal (CPF/CNPJ): sem a chave, não dá para testar o espaço
 * de documentos por força bruta. Subchave por finalidade = HMAC(APP_ENCRYPTION_KEY, "vantri:" + purpose).
 * Trocar a APP_ENCRYPTION_KEY muda todos os hashes (recalcular a coluna junto com a recifragem).
 */
export function hmacHex(purpose: string, value: string): string {
  const subkey = createHmac("sha256", key()).update(`vantri:${purpose}`).digest();
  return createHmac("sha256", subkey).update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomBase62(len: number): string {
  return Array.from({ length: len }, () => BASE62[randomInt(62)]).join("");
}
