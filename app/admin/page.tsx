import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/field";
import { Table } from "@/app/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import type { Perm } from "@/lib/auth/perms";
import { brl } from "@/lib/br/money";
import { signupClosed } from "@/lib/turnstile";
import { BarChart, type BarSeries, Sparkline } from "./chart";
import { pode } from "./perms-ui";
import {
  aggregateBalances,
  CRON_STALE_MIN,
  type DayPoint,
  MED_DUE_SOON_H,
  parseRange,
  pendingQueue,
  seriesByDay,
  STUCK_PAYOUT_MIN,
  topMerchants,
} from "./queries";

export const metadata: Metadata = { title: "Visão do suporte — Admin Vantri" };

const PRESETS = [
  ["hoje", "Hoje"],
  ["7d", "7 dias"],
  ["30d", "30 dias"],
  ["mes", "Este mês"],
] as const;

const FLOW: BarSeries<DayPoint>[] = [
  { key: "inCents", label: "Recebido", color: "var(--color-ok)" },
  { key: "outCents", label: "Enviado", color: "var(--color-brand)" },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
/** 0,125 → "12,5%"; sem base → "—". */
const pct = (x: number | null) =>
  x === null ? "—" : `${(x * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
/** "2026-10-17" → "17/10/2026". */
const dataBr = (day: string) => day.split("-").reverse().join("/");

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A Visão é a base de todo papel de admin (os três têm clientes:ler); o resto do acesso é por tela.
  const { user } = await requireAdmin({ perm: "clientes:ler" });
  const r = parseRange(await searchParams);
  const [days, top, balances, queue] = await Promise.all([
    seriesByDay(r),
    topMerchants(r),
    aggregateBalances(),
    pendingQueue(),
  ]);
  const sum = (k: Exclude<keyof DayPoint, "day">) => days.reduce((a, d) => a + d[k], 0);
  const received = sum("inCents");
  const feeIn = sum("feeInCents");
  const feeOut = sum("feeOutCents");
  const paid = sum("pixCount");
  const sentCount = sum("payoutCount");
  const failed = sum("failedPayoutCount");
  const created = sum("chargesCreated");
  const createdPaid = sum("chargesCreatedPaid");
  const med = sum("medCents");

  const queueCards: Array<{ label: string; value: string; note: string; href: string; perm: Perm }> = [
    {
      label: "Cadastros pendentes",
      value: String(queue.pendingMerchants),
      note: "aguardando aprovação",
      href: "/admin/clientes?status=pending",
      perm: "clientes:ler",
    },
    {
      label: "Saques presos",
      value: String(queue.stuckPayouts),
      note: `em processamento há mais de ${STUCK_PAYOUT_MIN} min`,
      href: "/admin/saques?presos=1",
      perm: "saques:operar",
    },
    {
      label: "Webhooks com falha",
      value: String(queue.failingWebhooks),
      note: "entregas que falharam de vez",
      href: "/admin/webhooks?status=failed",
      perm: "webhooks:operar",
    },
    {
      label: "MED com prazo curto",
      value: String(queue.medDueSoon),
      note: `defesa vence em até ${MED_DUE_SOON_H} h`,
      href: "/admin/med?ordem=prazo",
      perm: "med:ler",
    },
    {
      label: "Rotina automática",
      value: queue.cronStale ? "Parada" : "Em dia",
      note: queue.cronStale ? `sem rodada nos últimos ${CRON_STALE_MIN} min` : `rodou nos últimos ${CRON_STALE_MIN} min`,
      href: "/admin/saude",
      perm: "saude:ler",
    },
  ];

  const kpis: Array<{ label: string; value: string; note: string; extra?: ReactNode }> = [
    { label: "Recebido (bruto)", value: brl(received), note: "cobranças pagas, antes da tarifa" },
    { label: "Líquido", value: brl(received - feeIn), note: "recebido menos a tarifa de entrada" },
    {
      label: "Enviado",
      value: brl(sum("outCents")),
      note: plural(sentCount, "saque, concluído ou em processamento", "saques, concluídos ou em processamento"),
    },
    {
      label: "Receita de tarifa",
      value: brl(feeIn + feeOut),
      note: `entrada ${brl(feeIn)} · saída ${brl(feeOut)}`,
      extra: days.length > 1 && (
        <Sparkline
          values={days.map((d) => d.feeInCents + d.feeOutCents)}
          label={`Receita de tarifa por dia, total ${brl(feeIn + feeOut)}`}
        />
      ),
    },
    { label: "Cobranças pagas", value: String(paid), note: "pelo dia do pagamento" },
    {
      label: "Conversão",
      value: pct(ratio(createdPaid, created)),
      note: created
        ? `${plural(createdPaid, "paga", "pagas")} de ${plural(created, "cobrança criada", "cobranças criadas")} no período`
        : "nenhuma cobrança criada no período",
    },
    { label: "Ticket médio", value: paid ? brl(Math.round(received / paid)) : "—", note: "recebido ÷ cobranças pagas" },
    {
      label: "Saques com falha",
      value: pct(ratio(failed, failed + sentCount)),
      note: `${failed} de ${plural(failed + sentCount, "saque pedido", "saques pedidos")} no período`,
    },
    {
      label: "MED aberto no período",
      value: brl(med),
      note: received ? `${pct(ratio(med, received))} do recebido` : "sem recebimento no período",
    },
  ];

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Visão do suporte</h1>
      <p className="mt-1 text-sm text-muted">
        Pendências e saldos são de agora; o resto segue o período escolhido. Dias no horário de Brasília.
      </p>
      {signupClosed() && (
        <Alert className="mt-6">
          <p className="font-semibold">Proteção contra robôs (Turnstile) desligada — configure as duas chaves</p>
          <p className="mt-1">
            Defina NEXT_PUBLIC_TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY na Vercel e publique de novo. Enquanto isso, o
            cadastro público fica fechado; o login continua.
          </p>
        </Alert>
      )}

      <section aria-labelledby="pendencias" className="mt-8">
        <h2 id="pendencias" className="text-lg">
          Fila de pendências
        </h2>
        <ul className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {queueCards.map(({ perm, ...c }) => (
            <li key={c.label}>
              <QueueCard {...c} link={pode(user.adminRole, perm)} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="periodo" className="mt-10">
        <h2 id="periodo" className="text-lg">
          Período: {r.from === r.to ? dataBr(r.from) : `${dataBr(r.from)} a ${dataBr(r.to)}`}
        </h2>
        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <nav aria-label="Atalhos de período" className="flex flex-wrap gap-2">
            {PRESETS.map(([p, label]) => (
              <Link
                key={p}
                href={`/admin?periodo=${p}`}
                aria-current={r.preset === p ? "page" : undefined}
                className="rounded-full border border-line bg-white px-3.5 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
              >
                {label}
              </Link>
            ))}
          </nav>
          <form method="get" action="/admin" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <input type="hidden" name="periodo" value="personalizado" />
            <Input label="De" name="de" type="date" required defaultValue={r.from} />
            <Input label="Até" name="ate" type="date" required defaultValue={r.to} />
            <button type="submit" className={buttonClass("ghost")}>
              Ver período
            </button>
          </form>
        </div>
        <p className="mt-2 text-xs text-muted">
          Personalizado: até 366 dias; início depois do fim volta para os últimos 7 dias.
        </p>

        <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kpis.map((k) => (
            <Kpi key={k.label} {...k} />
          ))}
        </dl>

        <Card className="mt-6 !p-5 sm:!p-6">
          <h3 className="text-base font-semibold">Recebido × enviado por dia</h3>
          <BarChart data={days} series={FLOW} label="Recebido e enviado por dia" />
        </Card>
      </section>

      <section aria-labelledby="lojistas" className="mt-10">
        <h2 id="lojistas" className="text-lg">
          Maiores lojistas do período
        </h2>
        <div className="mt-3">
          <Table
            caption="Maiores lojistas do período, por valor recebido"
            columns={["Lojista", "Recebido", "Cobranças pagas", "Receita de tarifa", "Taxa de MED"]}
            empty="Nenhuma cobrança paga no período."
          >
            {top.map((m) => (
              <tr key={m.merchantId}>
                <td>
                  <Link href={`/admin/clientes/${m.merchantId}`} className="font-semibold text-brand hover:underline">
                    {m.tradeName}
                  </Link>
                </td>
                <td className="whitespace-nowrap tabular-nums">{brl(m.inCents)}</td>
                <td className="tabular-nums">{m.count}</td>
                <td className="whitespace-nowrap tabular-nums">{brl(m.feeCents)}</td>
                <td className="tabular-nums">{pct(m.medRate)}</td>
              </tr>
            ))}
          </Table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Receita de tarifa = entrada + saída no período. Taxa de MED = MEDs abertos ÷ cobranças pagas no período.
        </p>
      </section>

      <section aria-labelledby="saldos" className="mt-10">
        <h2 id="saldos" className="text-lg">
          Saldos dos lojistas (agora)
        </h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <Kpi label="Disponível, somado" value={brl(balances.availableTotal)} note="o que todos os lojistas podem sacar" />
          <Kpi label="Bloqueado, somado" value={brl(balances.blockedTotal)} note="retido por MED em disputa" />
          <Kpi
            label="Disponível negativo"
            value={String(balances.negativeCount)}
            note="lojistas com saldo abaixo de zero (ex.: MED depois de um saque)"
          />
        </dl>
      </section>
    </>
  );
}

/** Sem a permissão da tela de destino, o número aparece mas não vira link (a tela daria 404 para este papel). */
function QueueCard({ label, value, note, href, link }: { label: string; value: string; note: string; href: string; link: boolean }) {
  const body = (
    <>
      <span className="text-sm font-semibold text-muted">{label}</span>
      <span className="mt-2 block text-3xl font-bold tracking-tight">{value}</span>
      <span className="mt-1 block text-xs text-muted">{note}</span>
    </>
  );
  const box = "block h-full rounded-3xl border border-line bg-white p-4 sm:p-5";
  return link ? (
    <Link href={href} className={`${box} transition-colors hover:border-ink`}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}

function Kpi({ label, value, note, extra }: { label: string; value: string; note: string; extra?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4 sm:p-5">
      <dt className="text-sm font-semibold text-muted">{label}</dt>
      <dd className="mt-1 break-words text-2xl font-bold tracking-tight">{value}</dd>
      <dd className="mt-1 text-xs text-muted">{note}</dd>
      {extra && <dd>{extra}</dd>}
    </div>
  );
}
