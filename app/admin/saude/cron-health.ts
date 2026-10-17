import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { cronRuns } from "@/lib/db/schema";
import { isSimulator } from "@/lib/provider";

// Leituras da tela de Saúde. Quem chama já passou por requireAdmin({ perm: "saude:ler" }).
// Quem grava cron_runs é o próprio /api/cron/tick (uma linha por passo e rodada; guarda 7 dias).

/** O tick roda a cada minuto (pg_cron no Supabase, Ruling 38): passou disso sem rodar, algo parou. */
export const STALE_AFTER_SEC = 5 * 60;

/** Última rodada de cada passo e se o tick parou (nenhuma rodada há mais de 5 min, ou nunca rodou). */
export async function cronHealth(now = new Date()): Promise<{
  steps: Array<{
    step: string;
    lastAt: Date;
    finishedAt: Date | null;
    agoSec: number;
    result: unknown;
    error: string | null;
  }>;
  stale: boolean;
}> {
  const rows = await db()
    .selectDistinctOn([cronRuns.step], {
      step: cronRuns.step,
      lastAt: cronRuns.startedAt,
      finishedAt: cronRuns.finishedAt,
      result: cronRuns.result,
      error: cronRuns.error,
    })
    .from(cronRuns)
    .orderBy(cronRuns.step, desc(cronRuns.startedAt));
  const steps = rows.map((r) => ({ ...r, agoSec: Math.max(0, Math.round((now.getTime() - r.lastAt.getTime()) / 1000)) }));
  const newest = Math.min(...steps.map((s) => s.agoSec)); // Infinity sem rodada nenhuma
  return { steps, stale: newest > STALE_AFTER_SEC };
}

/** Provedor de Pix ativo. Fora do simulador ainda não existe parceiro integrado (requer parceiro). */
export function providerHealth(): { provider: string; simulated: boolean } {
  return { provider: process.env.PIX_PROVIDER || "não configurado", simulated: isSimulator() };
}
