import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/field";
import { Badge } from "@/app/components/ui/status-badge";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import { getBalance } from "@/lib/money/ledger";
import { listMedCases } from "@/lib/services/med";
import { payoutCeilingCents } from "@/lib/services/payouts";
import { listStatementWithBalance } from "@/lib/services/statement-extra";
import { dailyFlow, pctDelta, periodSummary, previousPeriod } from "@/lib/services/summary";
import { listDeliveries } from "@/lib/webhooks/attempts";
import { diaBrasilia, LEDGER_BUCKET, LEDGER_KIND, painelSession, withQuery } from "./lib";

export const metadata: Metadata = { title: "Início — Vantri" };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DIA = z.iso.date();
// Limite diário de DEMONSTRAÇÃO: o real vem do parceiro de Pix (plano 2) e hoje nada o aplica ao saque.
// Configurável por PIX_DAILY_LIMIT_CENTS; o default é o maior valor que o sistema aceita num pedido (lote de saque).
const DEFAULT_DAILY_LIMIT_CENTS = 100_000_000;

type Search = Record<string, string | string[] | undefined>;
type Dia = { day: string; inflowCents: number; outflowCents: number };
type Lancamento = Awaited<ReturnType<typeof listStatementWithBalance>>["data"][number];

/** Soma n dias a um dia civil AAAA-MM-DD (aritmética de calendário, sem fuso). */
const somaDias = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
const sinal = (cents: number) => `${cents > 0 ? "+" : ""}${brl(cents)}`;
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;
const pct = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

function limiteDiarioCents(): number {
  const n = Number(process.env.PIX_DAILY_LIMIT_CENTS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT_CENTS;
}

/** Período da URL (?de&ate, dias de Brasília); sem nada, o padrão. Inválido ou acima de 366 dias → padrão + aviso. */
function periodo(sp: Search, padrao: { de: string; ate: string }) {
  const de = str(sp.de) ?? padrao.de;
  const ate = str(sp.ate) ?? padrao.ate;
  // 366 dias no máximo, inclusivo (o mesmo teto do extrato).
  const ok = DIA.safeParse(de).success && DIA.safeParse(ate).success && de <= ate && ate <= somaDias(de, 365);
  return ok ? { de, ate, invalido: false } : { ...padrao, invalido: true };
}

export default async function PainelInicio({ searchParams }: { searchParams: Promise<Search> }) {
  const { merchant } = await painelSession();
  const hoje = diaBrasilia(new Date());
  const inicioMes = `${hoje.slice(0, 8)}01`;
  const seteDias = somaDias(hoje, -6); // 7 dias civis contando hoje
  const { de, ate, invalido } = periodo(await searchParams, { de: inicioMes, ate: hoje });
  const anterior = previousPeriod(de, ate);

  // Todo número sai de um serviço sobre o razão (nada somado aqui), sempre pelo merchant da sessão.
  const [saldo, atual, antes, doDia, fluxo, ultimas, falhas, abertos] = await Promise.all([
    getBalance(merchant.id),
    periodSummary(merchant.id, de, ate),
    periodSummary(merchant.id, anterior.fromDay, anterior.toDay),
    periodSummary(merchant.id, hoje, hoje),
    dailyFlow(merchant.id, de, ate),
    listStatementWithBalance(merchant.id, { from: de, to: ate, limit: 6 }),
    listDeliveries(merchant.id, { status: "failed", from: seteDias, to: hoje, limit: 1 }),
    // ponytail: só os 100 casos abertos mais novos (os de prazo curto são os mais antigos); paginar se algum lojista passar disso.
    listMedCases(merchant.id, { status: "open", limit: 100 }),
  ]);
  // dailyFlow agrupa qualquer lançamento do dia (tarifa, ajuste, MED): o fluxo é só de quem teve entrada ou saída.
  const diasComFluxo = fluxo.filter((f) => f.inflowCents || f.outflowCents);
  const agora = Date.now();
  const prazoCurto = abertos.data.filter((c) => {
    const falta = c.defenseDeadline.getTime() - agora;
    return falta > 0 && falta < 48 * HOUR_MS;
  }).length;

  const alertas: Array<{ href: string; titulo: string; texto: ReactNode; tom: string }> = [];
  if (falhas.data.length) {
    alertas.push({
      href: "/painel/integracoes/entregas",
      titulo: "Entregas de webhook falhando",
      texto: "Há entregas com falha nos últimos 7 dias. Revise os endpoints e reenvie.",
      tom: VERMELHO,
    });
  }
  if (saldo.blocked > 0) {
    alertas.push({
      href: "/painel/extrato",
      titulo: "Saldo bloqueado",
      texto: (
        <>
          <span className="valor-sensivel">{brl(saldo.blocked)}</span> indisponível por MED. Veja no extrato.
        </>
      ),
      tom: AMBAR,
    });
  }
  if (prazoCurto) {
    alertas.push({
      href: "/painel/med",
      titulo: "MED com prazo curto",
      texto: `${plural(prazoCurto, "caso de MED", "casos de MED")} com prazo de defesa em menos de 48 h. Envie a defesa a tempo.`,
      tom: VERMELHO,
    });
  }

  const atalhos = [
    ["Hoje", hoje, hoje],
    ["7 dias", seteDias, hoje],
    ["Este mês", inicioMes, hoje],
  ] as const;

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Início</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Olá, {merchant.tradeName}</h1>
        <p className="mt-2 text-sm text-muted">Aqui está o resumo da sua operação.</p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Atalhos de período" className="flex w-full gap-1 sm:w-auto">
          {atalhos.map(([rotulo, a, b]) => {
            const ativo = a === de && b === ate;
            return (
              <Link
                key={rotulo}
                href={withQuery("/painel", { de: a, ate: b })}
                aria-current={ativo ? "true" : undefined}
                className={`whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors ${
                  ativo ? "bg-ink text-white" : "text-muted hover:bg-white hover:text-ink"
                }`}
              >
                {rotulo}
              </Link>
            );
          })}
        </div>
        <form method="get" className="flex w-full flex-wrap items-end gap-3 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <Input type="date" label="De" name="de" defaultValue={de} />
          </div>
          <div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <Input type="date" label="Até" name="ate" defaultValue={ate} />
          </div>
          <button type="submit" className={buttonClass("primary", "w-full sm:w-auto")}>
            Atualizar
          </button>
        </form>
      </div>

      {invalido && (
        <Alert>
          Período inválido: a data inicial precisa ser anterior ou igual à final, com no máximo 366 dias. Mostrando este
          mês.
        </Alert>
      )}

      <section aria-labelledby="kpis" className="grid gap-3 lg:grid-cols-3">
        <h2 id="kpis" className="sr-only">
          Resumo do período
        </h2>
        <Kpi titulo="Entradas do período" valor={atual.inflowCents} faixa="bg-ok">
          <p>
            {atual.inflowCount ? (
              <>
                {plural(atual.inflowCount, "Pix recebido", "Pix recebidos")} · ticket médio{" "}
                <span className="valor-sensivel">{brl(Math.round(atual.inflowCents / atual.inflowCount))}</span>
              </>
            ) : (
              "Sem Pix recebidos no período"
            )}
          </p>
          <p>
            Tarifas <span className="valor-sensivel">{brl(atual.feeInCents)}</span>
          </p>
          <Delta atual={atual.inflowCents} anterior={antes.inflowCents} subirEhBom />
        </Kpi>
        <div className="rounded-2xl border border-ink bg-ink p-5 text-white">
          <p className="text-sm font-semibold text-white/70">Saldo disponível</p>
          <p className="valor-sensivel mt-1 break-words text-2xl font-bold tracking-tight tabular-nums">{brl(saldo.available)}</p>
          <dl className="mt-1 space-y-0.5 text-xs text-white/70">
            <div className="flex justify-between gap-3">
              <dt>Bloqueado (MED)</dt>
              <dd className="valor-sensivel tabular-nums">{brl(saldo.blocked)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Total</dt>
              <dd className="valor-sensivel tabular-nums">{brl(saldo.total)}</dd>
            </div>
          </dl>
          <p className="mt-1 text-xs text-white/50">Não depende do período.</p>
        </div>
        <Kpi titulo="Saídas do período" valor={atual.outflowCents} faixa="bg-red-600">
          <p>{atual.outflowCount ? plural(atual.outflowCount, "saque", "saques") : "Sem saques no período"}</p>
          <p>
            Tarifas <span className="valor-sensivel">{brl(atual.feeOutCents)}</span>
          </p>
          <Delta atual={atual.outflowCents} anterior={antes.outflowCents} subirEhBom={false} />
        </Kpi>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <section aria-labelledby="fluxo">
            <Card className="!p-5 sm:!p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="fluxo" className="text-lg">
                  Fluxo de caixa
                </h2>
                <VerExtrato />
              </div>
              {diasComFluxo.length ? (
                <FluxoChart de={de} ate={ate} fluxo={diasComFluxo} entradas={atual.inflowCents} saidas={atual.outflowCents} />
              ) : (
                <p className="mt-4 text-sm text-muted">Sem dados de fluxo no período.</p>
              )}
            </Card>
          </section>

          <section aria-labelledby="ultimas">
            <Card className="!p-5 sm:!p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="ultimas" className="text-lg">
                  Últimas transações
                </h2>
                <VerExtrato />
              </div>
              {ultimas.data.length ? (
                <ul className="mt-2 divide-y divide-line">
                  {ultimas.data.map((e) => (
                    <Movimento key={e.id} e={e} />
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-muted">Nenhuma movimentação no período.</p>
              )}
            </Card>
          </section>
        </div>

        <div className="min-w-0 space-y-6">
          <section aria-labelledby="resumo-dia">
            <Card className="!p-5 sm:!p-6">
              <h2 id="resumo-dia" className="text-lg">
                Resumo do dia · {ddmm(hoje)}
              </h2>
              <dl className="mt-3 space-y-2 text-sm">
                <Linha rotulo={`Entradas (${doDia.inflowCount})`}>
                  <span className="valor-sensivel text-ok">{brl(doDia.inflowCents)}</span>
                </Linha>
                <Linha rotulo={`Saídas (${doDia.outflowCount})`}>
                  <span className="valor-sensivel text-red-700">{brl(doDia.outflowCents)}</span>
                </Linha>
                <Linha rotulo="Resultado do dia">
                  <span
                    className={`valor-sensivel ${doDia.resultCents > 0 ? "text-ok" : doDia.resultCents < 0 ? "text-red-700" : ""}`}
                  >
                    {sinal(doDia.resultCents)}
                  </span>
                </Linha>
              </dl>
            </Card>
          </section>

          <section aria-labelledby="alertas">
            <Card className="!p-5 sm:!p-6">
              <h2 id="alertas" className="text-lg">
                Alertas
              </h2>
              {alertas.length ? (
                <ul className="mt-3 space-y-2">
                  {alertas.map((a) => (
                    <li key={a.href}>
                      <Link href={a.href} className={`block rounded-2xl border px-4 py-3 text-sm transition-colors ${a.tom}`}>
                        <span className="block font-semibold">{a.titulo}</span>
                        <span className="mt-0.5 block">{a.texto}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted">Nenhum alerta no momento.</p>
              )}
            </Card>
          </section>

          <section aria-labelledby="limites">
            <Card className="!p-5 sm:!p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="limites" className="text-lg">
                  Limites Pix
                </h2>
                <Badge tone="warn">Demonstração</Badge>
              </div>
              <dl className="mt-3 space-y-2 text-sm">
                <Linha rotulo="Limite diário">
                  Usado <span className="valor-sensivel">{brl(doDia.outflowCents)}</span> de{" "}
                  <span className="valor-sensivel">{brl(limiteDiarioCents())}</span>
                </Linha>
                <Linha rotulo="Limite mensal">
                  <span className="font-normal text-muted">requer parceiro de Pix</span>
                </Linha>
                <Linha rotulo="Limite noturno (20h–6h)">
                  <span className="font-normal text-muted">requer parceiro de Pix</span>
                </Linha>
                <Linha rotulo="Teto por transferência">
                  <span className="valor-sensivel">{brl(payoutCeilingCents())}</span>
                </Linha>
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Limites de demonstração: os valores reais vêm do parceiro de Pix. O limite diário ainda não bloqueia
                saques; acima do teto por transferência, o saque é feito em parcelas.
              </p>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}

const VERMELHO = "border-red-200 bg-red-50 text-red-800 hover:border-red-300";
const AMBAR = "border-amber-200 bg-amber-50 text-amber-900 hover:border-amber-300";

function VerExtrato() {
  return (
    <Link href="/painel/extrato" className="text-sm font-semibold text-brand hover:underline">
      Ver extrato <span aria-hidden>→</span>
    </Link>
  );
}

function Kpi({ titulo, valor, faixa, children }: { titulo: string; valor: number; faixa: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white p-5">
      <div aria-hidden className={`-mx-5 -mt-5 mb-4 h-1 ${faixa}`} />
      <p className="text-sm font-semibold text-muted">{titulo}</p>
      <p className="valor-sensivel mt-1 break-words text-2xl font-bold tracking-tight tabular-nums">{brl(valor)}</p>
      <div className="mt-1 space-y-0.5 text-xs text-muted">{children}</div>
    </div>
  );
}

/** "+12,3% vs. período anterior"; sem base no período anterior (≤ 0), não aparece. */
function Delta({ atual, anterior, subirEhBom }: { atual: number; anterior: number; subirEhBom: boolean }) {
  const d = pctDelta(atual, anterior);
  if (d === null) return null;
  const cor = d === 0 ? "" : (d > 0) === subirEhBom ? "text-ok" : "text-red-700";
  return (
    <p className={`font-semibold ${cor}`}>
      <span className="valor-sensivel">{pct.format(d)}</span> vs. período anterior
    </p>
  );
}

function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-muted">{rotulo}</dt>
      <dd className="text-right font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function Movimento({ e }: { e: Lancamento }) {
  const entrada = e.amountCents >= 0;
  const titulo = e.bucket === "blocked" ? `${LEDGER_KIND[e.kind]} · ${LEDGER_BUCKET.blocked}` : LEDGER_KIND[e.kind];
  const href =
    e.refType === "charge"
      ? `/painel/cobrancas?id=${e.refId}`
      : e.refType === "payout"
        ? `/painel/saques/${e.refId}`
        : e.refType === "med_case"
          ? `/painel/med?id=${e.refId}`
          : null;
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        aria-hidden
        className={`grid size-8 shrink-0 place-items-center rounded-full ${entrada ? "bg-ok/10 text-ok" : "bg-red-50 text-red-700"}`}
      >
        <svg viewBox="0 0 16 16" className={`size-4 ${entrada ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 13V3M4 7l4-4 4 4" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        {href ? (
          <Link href={href} className="block truncate text-sm font-semibold text-ink hover:text-brand hover:underline">
            {titulo}
          </Link>
        ) : (
          <p className="truncate text-sm font-semibold text-ink">{titulo}</p>
        )}
        <p className="text-xs text-muted">{dataHora(e.createdAt)}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`valor-sensivel text-sm font-semibold tabular-nums ${entrada ? "text-ok" : "text-red-700"}`}>
          {sinal(e.amountCents)}
        </p>
        {e.balanceAfter !== null && (
          <p className="text-xs text-muted">
            Saldo <span className="valor-sensivel tabular-nums">{brl(e.balanceAfter)}</span>
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Entradas × saídas por dia em SVG puro (sem biblioteca), um par de barras por dia civil do período.
 * A lista escondida dá os mesmos números ao leitor de tela; com "ocultar saldos", o desenho some junto.
 */
function FluxoChart({ de, ate, fluxo, entradas, saidas }: { de: string; ate: string; fluxo: Dia[]; entradas: number; saidas: number }) {
  // `fluxo` só traz os dias com entrada ou saída: os outros entram zerados.
  const porDia = new Map(fluxo.map((f) => [f.day, f]));
  const serie: Dia[] = [];
  for (let day = de; day <= ate; day = somaDias(day, 1)) serie.push(porDia.get(day) ?? { day, inflowCents: 0, outflowCents: 0 });
  const n = serie.length;
  const max = Math.max(1, ...serie.map((s) => Math.max(s.inflowCents, s.outflowCents)));
  const H = 120;
  const alt = (v: number) => (v ? Math.max((v / max) * H, 2) : 0);
  const passo = Math.ceil(n / 7); // até 7 rótulos no eixo X
  return (
    <figure className="mt-4">
      <div aria-hidden className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-ok" />
          Entradas <span className="valor-sensivel font-semibold tabular-nums text-ink">{brl(entradas)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-red-600" />
          Saídas <span className="valor-sensivel font-semibold tabular-nums text-ink">{brl(saidas)}</span>
        </span>
      </div>
      {/* Esticado na largura (preserveAspectRatio none); por isso os rótulos ficam fora, em HTML. */}
      <div className="valor-sensivel mt-3">
        <svg viewBox={`0 0 ${n * 40} ${H}`} preserveAspectRatio="none" className="h-40 w-full" aria-hidden>
          {serie.map((s, i) => (
            <g key={s.day}>
              <rect x={i * 40 + 4} y={0} width={32} height={H} rx={3} className="fill-bg" />
              <rect x={i * 40 + 6} y={H - alt(s.inflowCents)} width={13} height={alt(s.inflowCents)} rx={2} className="fill-ok">
                <title>{`${ddmm(s.day)}: entradas ${brl(s.inflowCents)}`}</title>
              </rect>
              <rect x={i * 40 + 21} y={H - alt(s.outflowCents)} width={13} height={alt(s.outflowCents)} rx={2} className="fill-red-600">
                <title>{`${ddmm(s.day)}: saídas ${brl(s.outflowCents)}`}</title>
              </rect>
            </g>
          ))}
        </svg>
      </div>
      <div aria-hidden className="relative mt-2 h-4 text-[11px] text-muted">
        {serie.map(
          (s, i) =>
            i % passo === 0 && (
              <span key={s.day} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / n) * 100}%` }}>
                {ddmm(s.day)}
              </span>
            ),
        )}
      </div>
      <figcaption className="sr-only">
        <ul>
          {fluxo.map((f) => (
            <li key={f.day}>
              {`${ddmm(f.day)}: entradas `}
              <span className="valor-sensivel">{brl(f.inflowCents)}</span>, saídas{" "}
              <span className="valor-sensivel">{brl(f.outflowCents)}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
