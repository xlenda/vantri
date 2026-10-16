import { timingSafeEqual } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { rateLimits, sessions } from "@/lib/db/schema";
import { expireDueCharges } from "@/lib/services/charges";
import { pollProcessingPayouts } from "@/lib/services/payouts";
import { dispatchDue } from "@/lib/webhooks/dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Compara em tempo constante (hash dos dois lados: mesmo tamanho sempre). Sem CRON_SECRET, ninguém entra. */
function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || header === null) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(header)), Buffer.from(sha256Hex(`Bearer ${secret}`)));
}

// Ordem importa: o que expira/liquida aqui já sai no dispatch da mesma rodada.
const STEPS = {
  expired_charges: { run: () => expireDueCharges(), error: "falha ao expirar cobranças" },
  settled_payouts: { run: () => pollProcessingPayouts(), error: "falha ao consultar saques no provedor" },
  webhooks: { run: () => dispatchDue(), error: "falha ao enviar webhooks" },
  deleted_rate_limits: {
    run: async () =>
      (
        await db()
          .delete(rateLimits)
          .where(lt(rateLimits.windowStart, sql`now() - interval '1 day'`))
          .returning({ key: rateLimits.key })
      ).length,
    error: "falha ao limpar limites de requisição",
  },
  deleted_sessions: {
    run: async () =>
      (await db().delete(sessions).where(lt(sessions.expiresAt, sql`now()`)).returning({ id: sessions.id })).length,
    error: "falha ao limpar sessões vencidas",
  },
} as const;

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req.headers.get("authorization"))) {
    return Response.json({ error: { code: "unauthorized", message: "Não autorizado." } }, { status: 401 });
  }
  const result: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  // Cada passo isolado: um que falha não pula os outros.
  for (const [name, step] of Object.entries(STEPS)) {
    try {
      result[name] = await step.run();
    } catch (e) {
      console.error(`cron: ${step.error}`, e);
      result[name] = null;
      errors[name] = step.error;
    }
  }
  return Response.json({ ...result, errors });
}
