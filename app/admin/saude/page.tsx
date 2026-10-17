import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/app/components/ui/alert";
import { Card } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { pode } from "@/lib/auth/perms";
import { dateTime } from "@/lib/br/money";
import { overallSuccessRates } from "../webhooks/monitor";
import { cronHealth, providerHealth } from "./cron-health";

export const metadata: Metadata = { title: "Saúde — Admin Vantri" };

// Passos do /api/cron/tick na ordem em que rodam. Passo novo sem rótulo aparece com o nome técnico, no fim.
const STEP_LABEL: Record<string, string> = {
  expired_charges: "Expirar cobranças vencidas",
  settled_payouts: "Consultar saques no provedor",
  webhooks: "Enviar webhooks",
  deleted_rate_limits: "Limpar limites de requisição",
  deleted_sessions: "Limpar sessões vencidas",
  deleted_webhook_deliveries: "Limpar entregas de webhook antigas",
  deleted_access_logs: "Limpar registros de acesso (mais de 6 meses)",
  deleted_cron_runs: "Limpar histórico do cron (mais de 7 dias)",
};
const ORDER = Object.keys(STEP_LABEL);
const rank = (step: string) => (ORDER.includes(step) ? ORDER.indexOf(step) : ORDER.length);

function ago(sec: number) {
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} h`;
  return `${Math.floor(sec / 86_400)} dia(s)`;
}

/** Contagem do passo (número) ou o par entregues/falhas do envio de webhooks. */
function resultText(r: unknown) {
  if (typeof r === "number") return r.toLocaleString("pt-BR");
  const w = r as { delivered?: unknown; failed?: unknown } | null;
  if (typeof w?.delivered === "number" && typeof w.failed === "number") return `${w.delivered} entregue(s), ${w.failed} com falha`;
  return "—";
}

const pct = (r: number | null) =>
  r === null ? "sem dados" : `${(r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

export default async function SaudePage() {
  const { user } = await requireAdmin({ perm: "saude:ler" });
  const [{ steps, stale }, webhooks] = await Promise.all([cronHealth(), overallSuccessRates()]);
  const provider = providerHealth();
  const sorted = [...steps].sort((a, b) => rank(a.step) - rank(b.step));
  const newestSec = Math.min(...steps.map((s) => s.agoSec));

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Saúde do sistema</h1>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
        O cron (<code>/api/cron/tick</code>) roda a cada minuto: expira cobranças, confere saques no provedor, envia
        webhooks e faz as limpezas.
      </p>

      {stale && (
        <Alert className="mt-6">
          {steps.length ? `O cron não roda há ${ago(newestSec)}.` : "O cron ainda não rodou."} Sem ele, cobranças não
          expiram, saques não são conferidos no provedor e webhooks não saem. Confira o agendamento (pg_cron no Supabase)
          e o CRON_SECRET.
        </Alert>
      )}

      <section className="mt-8">
        <h2 className="text-lg">Última rodada de cada passo</h2>
        <div className="mt-3">
          <Table
            caption="Última rodada de cada passo do cron"
            columns={["Passo", "Início", "Há quanto tempo", "Duração", "Resultado", "Erro"]}
            empty="Nenhuma rodada registrada."
          >
            {sorted.map((s) => (
              <tr key={s.step}>
                <td className="font-semibold">
                  {Object.hasOwn(STEP_LABEL, s.step) ? STEP_LABEL[s.step] : <code className="text-xs">{s.step}</code>}
                </td>
                <td className="whitespace-nowrap">{dateTime(s.lastAt)}</td>
                <td className="whitespace-nowrap">há {ago(s.agoSec)}</td>
                <td className="whitespace-nowrap tabular-nums">
                  {s.finishedAt ? `${(s.finishedAt.getTime() - s.lastAt.getTime()).toLocaleString("pt-BR")} ms` : "—"}
                </td>
                <td className="tabular-nums">{s.error ? "—" : resultText(s.result)}</td>
                <td>{s.error ? <Badge tone="bad">{s.error}</Badge> : <Badge tone="ok">ok</Badge>}</td>
              </tr>
            ))}
          </Table>
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-lg">Provedor de Pix</h2>
          {provider.simulated ? (
            <p className="mt-2 text-sm leading-relaxed">
              <Badge tone="warn">Simulador</Badge> Ambiente de demonstração: cobranças e saques não movimentam dinheiro de
              verdade.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-relaxed">
              <Badge tone="bad">{provider.provider}</Badge> Sem integração com instituição parceira ainda: cobranças e saques
              falham até ela existir.
            </p>
          )}
          <p className="mt-3 text-sm text-muted">
            Conexão e limites da instituição parceira: <Badge tone="info">requer parceiro</Badge>
          </p>
        </Card>

        <Card>
          <h2 className="text-lg">Entregas de webhook</h2>
          <p className="mt-1 text-sm text-muted">Sucesso das tentativas de entrega, todos os clientes.</p>
          <dl className="mt-3 grid grid-cols-2 gap-4">
            {(
              [
                ["24 h", webhooks.rate24h, webhooks.attempts24h],
                ["7 dias", webhooks.rate7d, webhooks.attempts7d],
              ] as const
            ).map(([label, r, n]) => (
              <div key={label}>
                <dt className="text-xs font-semibold text-muted">{label}</dt>
                <dd className="text-2xl font-bold tabular-nums">{pct(r)}</dd>
                <dd className="text-xs text-muted">{n} tentativa(s)</dd>
              </div>
            ))}
          </dl>
          {pode(user.adminRole, "webhooks:operar") && (
            <Link href="/admin/webhooks?status=failed" className="mt-4 inline-block text-sm font-semibold text-brand hover:underline">
              Ver o que falhou de vez
            </Link>
          )}
        </Card>
      </div>
    </>
  );
}
