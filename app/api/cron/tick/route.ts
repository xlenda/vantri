import { timingSafeEqual } from "node:crypto";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { cronRuns, rateLimits, sessions, webhookDeliveries } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { deleteAccessLogsOlderThan6Months } from "@/lib/services/admin/access";
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
  // Corte de 1 dia: vale enquanto toda janela de rateLimit() for <= 86400 s (hoje a maior é 1 h). Janela maior
  // seria zerada aqui antes de acabar: subir o corte junto.
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
  // O Supabase grátis tem 500 MB e, cheio, vira somente leitura (o gateway inteiro para). As entregas guardam o
  // payload (com o nome do pagador): entregue sai em 30 dias; com falha fica 90, para o lojista ver e reenviar.
  // Os anexos de MED ficam (são a prova da defesa).
  deleted_webhook_deliveries: {
    run: async () =>
      (
        await db()
          .delete(webhookDeliveries)
          .where(
            or(
              and(eq(webhookDeliveries.status, "delivered"), lt(webhookDeliveries.createdAt, sql`now() - interval '30 days'`)),
              and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.createdAt, sql`now() - interval '90 days'`)),
            ),
          )
          .returning({ id: webhookDeliveries.id })
      ).length,
    error: "falha ao limpar entregas de webhook antigas",
  },
  // Marco Civil, art. 15: o registro de acesso (IP + data/hora) fica guardado 6 meses; passou disso, sai.
  deleted_access_logs: {
    run: () => deleteAccessLogsOlderThan6Months(),
    error: "falha ao limpar registros de acesso antigos",
  },
  // O próprio tick grava ~8 linhas por minuto em cron_runs; a tela de Saúde só lê a última de cada passo.
  deleted_cron_runs: {
    run: async () =>
      (
        await db()
          .delete(cronRuns)
          .where(lt(cronRuns.startedAt, sql`now() - interval '7 days'`))
          .returning({ id: cronRuns.id })
      ).length,
    error: "falha ao limpar o histórico do cron",
  },
} as const;

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req.headers.get("authorization"))) {
    return Response.json({ error: { code: "unauthorized", message: "Não autorizado." } }, { status: 401 });
  }
  const result: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const runs: Array<typeof cronRuns.$inferInsert> = [];
  // Cada passo isolado: um que falha não pula os outros.
  for (const [name, step] of Object.entries(STEPS)) {
    const startedAt = new Date();
    try {
      result[name] = await step.run();
    } catch (e) {
      logError(`cron: ${step.error}`, e);
      result[name] = null;
      errors[name] = step.error;
    }
    runs.push({ step: name, startedAt, finishedAt: new Date(), result: result[name], error: errors[name] ?? null });
  }
  // Histórico da tela de Saúde (o erro só como a categoria acima, nunca a mensagem crua). Falhar aqui não muda a resposta.
  try {
    await db().insert(cronRuns).values(runs);
  } catch (e) {
    logError("cron: falha ao gravar cron_runs", e);
  }
  return Response.json({ ...result, errors });
}
