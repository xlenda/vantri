import { isIP } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { randomBase62, sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { apiKeys } from "@/lib/db/schema";
import { zodIssueMessage } from "@/lib/validation";

export const SCOPES = [
  "balance:read",
  "charges:read",
  "charges:write",
  "payouts:read",
  "payouts:write",
  "statement:read",
  "med:read",
] as const;
export type Scope = (typeof SCOPES)[number];

export class ApiKeyError extends Error {
  constructor(
    public readonly code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

// ponytail: IP exato (sem CIDR nem forma canônica de IPv6); aceitar faixas se algum lojista pedir.
const ipAllowlist = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .refine((ip) => isIP(ip) !== 0),
  )
  .max(20);

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(z.enum(SCOPES)).min(1),
  ipAllowlist,
});

const FIELD_MSG: Record<string, string> = {
  name: "Dê um nome à chave (até 60 caracteres).",
  scopes: "Escolha ao menos um escopo válido.",
  ipAllowlist: "Lista de IPs inválida: use até 20 endereços IPv4 ou IPv6.",
};

/** Lista de IPs: a mensagem do erro, ou null se válida. O painel confere antes de gastar o código 2FA. */
export const ipAllowlistProblem = (ips: string[]): string | null =>
  ipAllowlist.safeParse(ips).success ? null : FIELD_MSG.ipAllowlist;

/** A chave (`vk_live_` + 40 base62) só aparece aqui, uma vez; o banco guarda o sha256 e os 12 primeiros caracteres. */
export async function createApiKey(
  merchantId: string,
  input: { name: string; scopes: Scope[]; ipAllowlist: string[] },
): Promise<{ id: string; key: string }> {
  const r = createSchema.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ApiKeyError("invalid_request", FIELD_MSG[String(i.path[0])] ?? zodIssueMessage(i));
  }
  const key = `vk_live_${randomBase62(40)}`;
  const [row] = await db()
    .insert(apiKeys)
    .values({
      merchantId,
      name: r.data.name,
      prefix: key.slice(0, 12),
      keyHash: sha256Hex(key),
      scopes: [...new Set(r.data.scopes)],
      ipAllowlist: [...new Set(r.data.ipAllowlist)],
    })
    .returning({ id: apiKeys.id });
  return { id: row.id, key };
}

/** Revogar de novo mantém a data original. Chave de outro lojista (ou id inválido) → `not_found`. */
export async function revokeApiKey(merchantId: string, id: string): Promise<void> {
  const rows = z.uuid().safeParse(id).success
    ? await db()
        .update(apiKeys)
        .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.merchantId, merchantId)))
        .returning({ id: apiKeys.id })
    : [];
  if (!rows.length) throw new ApiKeyError("not_found", "Chave de API não encontrada.");
}
