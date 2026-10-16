import { eq } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { apiKeys, merchants } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { rateLimit } from "@/lib/ratelimit";
import { ChargeError, type ChargeErrorCode } from "@/lib/services/charges";
import { MedError, type MedErrorCode } from "@/lib/services/med";
import { PayoutError, type PayoutErrorCode } from "@/lib/services/payouts";
import { parseOr } from "@/lib/validation";
import { ApiKeyError, type Scope } from "./keys";

// Tipado pelos códigos dos serviços: código novo sem status aqui não compila.
const STATUS: Record<ChargeErrorCode | PayoutErrorCode | MedErrorCode | "unauthorized" | "forbidden" | "rate_limited", number> =
  {
    invalid_request: 422,
    unauthorized: 401,
    forbidden: 403,
    merchant_inactive: 403,
    not_found: 404,
    idempotency_conflict: 409,
    insufficient_balance: 422,
    invalid_file: 422,
    deadline_passed: 422,
    invalid_status: 422,
    rate_limited: 429,
    provider_error: 502,
  };
export type ErrorCode = keyof typeof STATUS;

/** Erro da própria camada HTTP (query, corpo, header). */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const KNOWN = [ApiError, ApiKeyError, ChargeError, PayoutError, MedError];

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

const fail = (code: ErrorCode, message: string, headers?: Record<string, string>) =>
  json({ error: { code, message } }, STATUS[code], headers);

// Log via logError: erro de query traz params (chave Pix, nome do pagador) e nunca pode ir inteiro para o log.
function errorResponse(err: unknown, ids: Record<string, string>): Response {
  if (KNOWN.some((E) => err instanceof E)) {
    const { code, message, cause } = err as ApiError;
    if (STATUS[code] >= 500) logError(`api: ${code}`, cause ?? err, ids);
    return fail(code, message);
  }
  logError("api: erro inesperado", err, ids);
  return json({ error: { code: "internal_error", message: "Erro interno. Tente de novo em instantes." } }, 500);
}

/** Corpo JSON; malformado → 422. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError("invalid_request", "O corpo da requisição precisa ser um JSON válido.");
  }
}

/** Query string contra um schema estrito (parâmetro desconhecido → 422). */
export const parseQuery = <T extends z.ZodType>(req: Request, schema: T): z.output<T> =>
  parseOr(schema, Object.fromEntries(new URL(req.url).searchParams), (msg) => new ApiError("invalid_request", msg));

export const LIMIT = z.coerce.number().int().min(1).max(100).default(20);
const listSchema = z.strictObject({ limit: LIMIT, cursor: z.string().optional() });
/** `limit` (1–100, padrão 20) e `cursor`; o formato do cursor quem confere é o serviço. */
export const listQuery = (req: Request) => parseQuery(req, listSchema);

const BEARER = /^bearer\s+(vk_live_[0-9a-z]{40})$/i;
const PER_MINUTE = 120;

function clientIp(req: Request): string | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip")?.trim();
  return ip ? ip.toLowerCase() : null;
}

/**
 * Autentica `Authorization: Bearer vk_live_…` e aplica, nesta ordem: chave válida e não revogada (401),
 * IP na allowlist se houver (403), lojista ativo (403), escopo (403), 120/min por chave (429).
 * Erro do handler vira `{ error: { code, message } }`; erro desconhecido vira 500 genérico.
 */
export function withApi<P extends Record<string, string> = Record<string, string>>(
  scope: Scope,
  handler: (ctx: { merchantId: string; req: Request; params: P }) => Promise<Response>,
) {
  return async (req: Request, { params }: { params: Promise<P> }): Promise<Response> => {
    const ids: Record<string, string> = {};
    try {
      const token = BEARER.exec(req.headers.get("authorization") ?? "")?.[1];
      const [k] = token
        ? await db()
            .select({
              id: apiKeys.id,
              merchantId: apiKeys.merchantId,
              scopes: apiKeys.scopes,
              ipAllowlist: apiKeys.ipAllowlist,
              lastUsedAt: apiKeys.lastUsedAt,
              revokedAt: apiKeys.revokedAt,
              merchantStatus: merchants.status,
            })
            .from(apiKeys)
            .innerJoin(merchants, eq(merchants.id, apiKeys.merchantId))
            .where(eq(apiKeys.keyHash, sha256Hex(token)))
        : [];
      if (!k) return fail("unauthorized", "Chave de API ausente ou inválida. Envie Authorization: Bearer vk_live_….");
      if (k.revokedAt) return fail("unauthorized", "Esta chave de API foi revogada.");
      ids.merchant = k.merchantId;
      if (k.ipAllowlist.length) {
        const ip = clientIp(req);
        if (!ip || !k.ipAllowlist.includes(ip)) return fail("forbidden", "Este IP não está na lista de IPs permitidos da chave.");
      }
      if (k.merchantStatus !== "active") return fail("merchant_inactive", "Sua conta não está ativa.");
      if (!k.scopes.includes(scope)) return fail("forbidden", `Esta chave não tem o escopo ${scope}.`);

      const rl = await rateLimit(`api:${k.id}`, PER_MINUTE, 60);
      if (!rl.ok) {
        return fail("rate_limited", `Limite de ${PER_MINUTE} requisições por minuto atingido.`, {
          "retry-after": String(rl.retryAfterSec),
        });
      }
      if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() >= 60_000) {
        await db().update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, k.id));
      }
      return await handler({ merchantId: k.merchantId, req, params: await params });
    } catch (err) {
      return errorResponse(err, ids);
    }
  };
}
