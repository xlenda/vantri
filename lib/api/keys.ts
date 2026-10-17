import { BlockList, isIP } from "node:net";
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

// Prefixo mínimo por família: nada mais amplo que uma sub-rede local (§1.10).
const MIN_PREFIX = { 4: 24, 6: 64 } as const;
const MSG_BROAD = "Prefixo muito amplo: aceito IPv4 a partir de /24 e IPv6 a partir de /64.";
const MSG_INVALID = "IP ou faixa inválida: use IPv4/IPv6, com CIDR opcional (ex.: 203.0.113.0/24).";

/** Uma entrada "IP ou CIDR": a mensagem do erro em PT, ou null se válida. IP sem `/` = host único. */
export function ipEntryProblem(entry: string): string | null {
  const slash = entry.indexOf("/");
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(addr) as 0 | 4 | 6;
  if (family === 0 || addr.includes("%")) return MSG_INVALID; // sem IP válido / sem zona
  if (slash === -1) return null; // host único (/32 ou /128)
  const rest = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(rest)) return MSG_INVALID; // prefixo precisa ser um número simples
  const prefix = Number(rest);
  const max = family === 4 ? 32 : 128;
  if (prefix > max) return MSG_INVALID;
  if (prefix < MIN_PREFIX[family]) return MSG_BROAD;
  return null;
}

const ipAllowlist = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .refine((entry) => ipEntryProblem(entry) === null),
  )
  .max(20);

/** Casa `ip` contra a lista de IPs/CIDRs (um BlockList por família). Entrada inválida/IP inválido → sem casar. */
export function testIpAgainstAllowlist(entries: string[], ip: string): boolean {
  const family = isIP(ip) as 0 | 4 | 6;
  if (family === 0) return false;
  const kind = family === 4 ? "ipv4" : "ipv6";
  const bl = new BlockList();
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const addr = slash === -1 ? entry : entry.slice(0, slash);
    const ef = isIP(addr) as 0 | 4 | 6;
    if (ef !== family) continue; // só a mesma família; ignora entrada inválida
    if (slash === -1) bl.addAddress(addr, kind);
    else bl.addSubnet(addr, Number(entry.slice(slash + 1)), kind);
  }
  return bl.check(ip, kind);
}

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(z.enum(SCOPES)).min(1),
  ipAllowlist,
});

const FIELD_MSG: Record<string, string> = {
  name: "Dê um nome à chave (até 60 caracteres).",
  scopes: "Escolha ao menos um escopo válido.",
  ipAllowlist: "Lista de IPs inválida: até 20 endereços ou faixas CIDR (IPv4 a partir de /24, IPv6 de /64).",
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
