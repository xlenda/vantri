import { and, count, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import { Card } from "@/app/components/ui/card";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { db } from "@/lib/db/client";
import { charges } from "@/lib/db/schema";
import { getBalance } from "@/lib/money/ledger";
import { listCharges } from "@/lib/services/charges";
import { brl, dataHora, diaBrasilia, painelSession } from "./lib";

const DAY_MS = 86_400_000;

export default async function PainelInicio() {
  const { merchant } = await painelSession();
  const today = diaBrasilia(new Date());
  const days = Array.from({ length: 7 }, (_, i) => diaBrasilia(new Date(Date.parse(`${today}T12:00:00-03:00`) - (6 - i) * DAY_MS)));
  // Dia civil de Brasília (UTC−3, sem horário de verão) sem depender do TimeZone da sessão do banco.
  const day = sql<string>`to_char((${charges.paidAt} at time zone 'UTC') - interval '3 hours', 'YYYY-MM-DD')`;

  const [balance, perDay, recent] = await Promise.all([
    getBalance(merchant.id),
    db()
      .select({ day, total: sql`coalesce(sum(${charges.amountCents}), 0)`.mapWith(Number), n: count() })
      .from(charges)
      .where(
        and(
          eq(charges.merchantId, merchant.id),
          eq(charges.status, "paid"),
          gte(charges.paidAt, new Date(`${days[0]}T00:00:00-03:00`)),
        ),
      )
      .groupBy(day),
    listCharges(merchant.id, { limit: 5 }),
  ]);
  const byDay = new Map(perDay.map((r) => [r.day, r]));
  const series = days.map((d) => ({ day: d, total: byDay.get(d)?.total ?? 0, n: byDay.get(d)?.n ?? 0 }));
  const week = series.reduce((a, s) => ({ total: a.total + s.total, n: a.n + s.n }), { total: 0, n: 0 });
  const todayStats = series[6];

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Painel</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Olá, {merchant.tradeName}</h1>
      </header>

      <section aria-labelledby="saldo" className="space-y-3">
        <h2 id="saldo" className="text-lg">
          Saldo
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Disponível" value={brl(balance.available)} hint="Pode sacar agora" strong />
          <Stat label="Bloqueado" value={brl(balance.blocked)} hint="Em disputa de MED" />
          <Stat label="Total" value={brl(balance.total)} />
        </div>
      </section>

      <section aria-labelledby="recebido" className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <h2 id="recebido" className="sr-only">
          Recebido (bruto)
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <Stat label="Recebido (bruto) hoje" value={brl(todayStats.total)} hint={`${pix(todayStats.n)}, antes da tarifa`} />
          <Stat label="Recebido (bruto) em 7 dias" value={brl(week.total)} hint={`${pix(week.n)}, antes da tarifa`} />
        </div>
        <Card className="!p-5 sm:!p-6">
          <p className="text-sm font-semibold text-ink">Recebido por dia (bruto, antes da tarifa)</p>
          <Bars series={series} />
        </Card>
      </section>

      <section aria-labelledby="ultimas" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="ultimas" className="text-lg">
            Últimas cobranças
          </h2>
          <Link href="/painel/cobrancas" className="text-sm font-semibold text-brand hover:underline">
            Ver todas
          </Link>
        </div>
        <Table columns={["Criada em", "Descrição", "Valor", "Status"]} empty="Nenhuma cobrança ainda." caption="Últimas cobranças">
          {recent.data.map((c) => (
            <tr key={c.id}>
              <td className="whitespace-nowrap text-muted">{dataHora(c.createdAt)}</td>
              <td>
                <Link href={`/painel/cobrancas?id=${c.id}`} className="font-medium text-ink hover:text-brand hover:underline">
                  {c.description || "Sem descrição"}
                </Link>
              </td>
              <td className="whitespace-nowrap font-semibold">{brl(c.amountCents)}</td>
              <td>
                <StatusBadge kind="charge" status={c.status} />
              </td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}

const pix = (n: number) => (n === 1 ? "1 Pix" : `${n} Pix`);

function Stat({ label, value, hint, strong = false }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${strong ? "border-ink bg-ink text-white" : "border-line bg-white"}`}>
      <p className={`text-sm font-semibold ${strong ? "text-white/70" : "text-muted"}`}>{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums">{value}</p>
      {hint && <p className={`mt-1 text-xs ${strong ? "text-white/60" : "text-muted"}`}>{hint}</p>}
    </div>
  );
}

const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "UTC" });
const dayMonth = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" });

/** Barras em SVG puro; a lista escondida dá os mesmos números para leitor de tela. */
function Bars({ series }: { series: { day: string; total: number; n: number }[] }) {
  const max = Math.max(...series.map((s) => s.total), 1);
  const H = 120;
  const date = (day: string) => new Date(`${day}T12:00:00Z`);
  return (
    <figure className="mt-4">
      {/* Esticado na largura (preserveAspectRatio none); por isso os rótulos ficam fora, em HTML. */}
      <svg viewBox={`0 0 ${series.length * 40} ${H}`} preserveAspectRatio="none" className="h-36 w-full" aria-hidden>
        {series.map((s, i) => {
          const h = s.total ? Math.max((s.total / max) * H, 3) : 0;
          return (
            <g key={s.day}>
              <rect x={i * 40 + 8} y={0} width={24} height={H} rx={3} className="fill-bg" />
              <rect x={i * 40 + 8} y={H - h} width={24} height={h} rx={3} className={i === series.length - 1 ? "fill-brand" : "fill-ink"}>
                <title>{`${dayMonth.format(date(s.day))}: ${brl(s.total)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div aria-hidden className="mt-2 grid grid-cols-7 text-center text-[11px] leading-tight text-muted">
        {series.map((s) => (
          <span key={s.day}>
            <span className="block font-semibold capitalize">{weekday.format(date(s.day)).replace(".", "")}</span>
            {dayMonth.format(date(s.day))}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        <ul>
          {series.map((s) => (
            <li key={s.day}>
              {dayMonth.format(new Date(`${s.day}T12:00:00Z`))}: {brl(s.total)}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
