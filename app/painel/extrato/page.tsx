import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Field, Input, inputClass, Select } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { ApiError } from "@/lib/api/http";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import { logError } from "@/lib/log";
import type { ChargeRow } from "@/lib/services/charges";
import type { PayoutRow } from "@/lib/services/payouts";
import { searchTransactions } from "@/lib/services/search";
import { type DailyClosingRow, dailyClosing, listStatementWithBalance } from "@/lib/services/statement-extra";
import { periodSummary } from "@/lib/services/summary";
import { diaBrasilia, hasControlChars, LEDGER_KIND, LEDGER_REF, painelSession } from "../lib";
import { Pager } from "../pager";
import { diaBr, type Extrato, extratoHref, MAX_ROWS, parseExtrato, periodShortcuts, toParams } from "./query";

export const metadata: Metadata = { title: "Extrato — Vantri" };

const PATH = "/painel/extrato";
const FILTERS = ["kind", "direction", "min", "max"];
type Entry = Awaited<ReturnType<typeof listStatementWithBalance>>["data"][number];
type Summary = Awaited<ReturnType<typeof periodSummary>>;
type Found = { charges: ChargeRow[]; payouts: PayoutRow[] } | "curta" | "falha";

export default async function ExtratoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const p = toParams(await searchParams);
  const today = diaBrasilia(new Date());
  const q = (p.get("q") ?? "").trim();
  const searching = q ? search(merchant.id, q) : null; // em paralelo: não depende do período nem dos filtros

  const parsed = parseExtrato(p, today);
  const e = parsed.ok ? parsed.value : null;
  let error = parsed.ok ? null : parsed.error;
  let data: Awaited<ReturnType<typeof load>> | null = null;
  if (e) {
    try {
      data = await load(merchant.id, e);
    } catch (err) {
      // O parseExtrato já barra o que os serviços recusam; isto só cobre uma regra nova de um deles.
      if (!(err instanceof ApiError)) throw err;
      error = "Não foi possível aplicar esses filtros. Revise o período e os valores.";
    }
  }
  const found = searching && (await searching);
  const fecho = p.get("visao") === "fecho";
  const hasFilters = FILTERS.some((k) => p.get(k));
  const link = (set?: Record<string, string | undefined>, path = PATH) => extratoHref(path, p, set);

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Movimentação</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Extrato</h1>
        <p className="mt-2 text-sm text-muted">
          Cada entrada e saída do seu saldo, com o saldo após cada lançamento. Datas no horário de Brasília.
        </p>
      </header>

      <section aria-label="Buscar transação" className="space-y-4">
        <form method="get" role="search">
          <Hidden p={p} keys={["from", "to", "visao", ...FILTERS]} />
          <Field
            label="Buscar transação"
            htmlFor="q"
            hint="Por E2E, TxID, referência ou nome do pagador, em todo o histórico (independe do período e dos filtros)."
          >
            <div className="flex gap-2">
              <input
                id="q"
                name="q"
                type="search"
                defaultValue={q}
                required
                minLength={2}
                placeholder="E2E, TxID, referência ou nome"
                aria-describedby="q-dica"
                className={`${inputClass} min-w-0 flex-1`}
              />
              <button type="submit" className={buttonClass("primary", "shrink-0")}>
                Buscar
              </button>
            </div>
          </Field>
        </form>
        {found && <SearchResults q={q} r={found} clear={link({ q: undefined })} />}
      </section>

      <section aria-label="Período e filtros" className="space-y-4">
        <nav aria-label="Atalhos de período" className="flex flex-wrap gap-1.5">
          {periodShortcuts(today).map((s) => (
            <Pill key={s.label} href={link({ from: s.from, to: s.to })} active={e?.from === s.from && e?.to === s.to}>
              {s.label}
            </Pill>
          ))}
        </nav>
        <form method="get" className="space-y-4">
          {/* No fechamento os filtros não valem, mas seguem na URL para a volta aos lançamentos. */}
          <Hidden p={p} keys={fecho ? ["q", "visao", ...FILTERS] : ["q", "visao"]} />
          <div className="flex flex-wrap gap-3">
            <div className="w-full sm:w-44">
              <Input type="date" label="De" name="from" defaultValue={p.get("from") || e?.from} required />
            </div>
            <div className="w-full sm:w-44">
              <Input type="date" label="Até" name="to" defaultValue={p.get("to") || e?.to} required />
            </div>
          </div>
          {!fecho && <Filters p={p} open={hasFilters} />}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={buttonClass("primary")}>
              Filtrar
            </button>
            {hasFilters && !fecho && (
              <Link href={link(Object.fromEntries(FILTERS.map((k) => [k, undefined])))} className={buttonClass("ghost")}>
                Limpar filtros
              </Link>
            )}
          </div>
        </form>
      </section>

      {error && <Alert>{error}</Alert>}
      {p.get("erro") === "muitas-linhas" && (
        <Alert>{`O arquivo passaria de ${MAX_ROWS.toLocaleString("pt-BR")} lançamentos. Escolha um período menor ou use os filtros.`}</Alert>
      )}

      {e && data && (
        <>
          <Cards s={data.summary} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Visão" className="flex flex-wrap gap-1.5">
              <Pill href={link({ visao: undefined })} active={!e.fecho}>
                Lançamentos
              </Pill>
              <Pill href={link({ visao: "fecho" })} active={e.fecho}>
                Fechamento diário
              </Pill>
            </nav>
            {/* Sem `download`: arquivo vem como anexo; erro volta para esta tela com o aviso. */}
            <div className="flex flex-wrap gap-2">
              <a href={link({ from: e.from, to: e.to, q: undefined }, `${PATH}/csv`)} className={buttonClass("ghost")}>
                Baixar CSV
              </a>
              <a href={link({ from: e.from, to: e.to, q: undefined }, `${PATH}/xlsx`)} className={buttonClass("ghost")}>
                Baixar Excel (XLSX)
              </a>
            </div>
          </div>
          {data.closing && <Closing rows={data.closing} />}
          {data.list && (
            <Statement
              rows={data.list.data}
              filtered={hasFilters}
              noBalance={e.kind !== undefined || e.direction !== undefined}
              first={e.cursor ? link() : undefined}
              next={data.list.nextCursor ? link({ cursor: data.list.nextCursor }) : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}

async function load(merchantId: string, e: Extrato) {
  const { from, to, kind, direction, minCents, maxCents, cursor } = e;
  const [summary, list, closing] = await Promise.all([
    periodSummary(merchantId, from, to),
    e.fecho ? null : listStatementWithBalance(merchantId, { from, to, kind, direction, minCents, maxCents, cursor, limit: 50 }),
    e.fecho ? dailyClosing(merchantId, from, to) : null,
  ]);
  return { summary, list, closing };
}

/** Busca por identificador. Falha do banco vira "falha" (≠ "não existe", mapa §1.6), logada sem dado pessoal. */
async function search(merchantId: string, q: string): Promise<Found> {
  if (q.length < 2) return "curta";
  if (hasControlChars(q)) return { charges: [], payouts: [] }; // o Postgres recusa NUL em text: não casa nada, e não é falha
  try {
    return await searchTransactions(merchantId, q);
  } catch (err) {
    logError("extrato: busca falhou", err, { merchant: merchantId });
    return "falha";
  }
}

/** Dinheiro sempre num elemento só com a classe valor-sensivel (o "ocultar saldos" esconde). */
function Money({ cents, sign = false, className = "" }: { cents: number; sign?: boolean; className?: string }) {
  return <span className={`valor-sensivel ${className}`.trim()}>{`${sign && cents > 0 ? "+" : ""}${brl(cents)}`}</span>;
}

/** Repete parâmetros atuais num formulário GET (que só envia os próprios campos). */
function Hidden({ p, keys }: { p: URLSearchParams; keys: string[] }) {
  return <>{keys.flatMap((k) => p.getAll(k).map((v, i) => <input key={`${k}-${i}`} type="hidden" name={k} value={v} />))}</>;
}

function Pill({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${
        active ? "bg-ink text-white ring-ink" : "bg-white text-muted ring-line hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

function Filters({ p, open }: { p: URLSearchParams; open: boolean }) {
  const kinds = p.getAll("kind");
  return (
    <details open={open} className="rounded-2xl border border-line bg-white p-4 sm:p-5">
      <summary className="cursor-pointer text-sm font-semibold text-ink">Filtros: tipo, movimento e valor</summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Select label="Movimento" name="direction" defaultValue={p.get("direction") ?? ""}>
          <option value="">Entradas e saídas</option>
          <option value="in">Só entradas</option>
          <option value="out">Só saídas</option>
        </Select>
        <Input label="Valor mínimo" name="min" inputMode="decimal" placeholder="0,00" defaultValue={p.get("min") ?? ""} />
        <Input label="Valor máximo" name="max" inputMode="decimal" placeholder="0,00" defaultValue={p.get("max") ?? ""} />
      </div>
      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-semibold text-ink">Tipo de lançamento</legend>
        <div className="flex flex-wrap gap-2">
          {Object.entries(LEDGER_KIND).map(([k, label]) => (
            <label
              key={k}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-checked:border-brand has-checked:bg-brand/5"
            >
              <input type="checkbox" name="kind" value={k} defaultChecked={kinds.includes(k)} className="size-4 accent-brand" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-xs text-muted">
        Valores em reais, comparados sem o sinal (ex.: 1.234,56). Entrada e saída seguem o sinal do lançamento.
      </p>
    </details>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Totais do período inteiro, somados no servidor (periodSummary), não da página carregada. */
function Cards({ s }: { s: Summary }) {
  return (
    <section aria-labelledby="resumo" className="space-y-2">
      <h2 id="resumo" className="sr-only">
        Resumo do período
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Entradas no período" cents={s.inflowCents} tone="text-ok">
          {plural(s.inflowCount, "Pix recebido", "Pix recebidos")} · tarifas <Money cents={s.feeInCents} />
        </Stat>
        <Stat label="Saídas no período" cents={s.outflowCents} tone="text-red-700">
          {plural(s.outflowCount, "saque", "saques")} · tarifas <Money cents={s.feeOutCents} />
        </Stat>
        <Stat label="Resultado" cents={s.resultCents} tone={s.resultCents < 0 ? "text-red-700" : "text-ink"}>
          Entradas menos saídas, antes das tarifas
        </Stat>
      </div>
      <p className="text-xs text-muted">Totais do período inteiro: não mudam com os filtros nem com a página.</p>
    </section>
  );
}

function Stat({ label, cents, tone, children }: { label: string; cents: number; tone: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className={`valor-sensivel mt-1 text-2xl font-bold tracking-tight tabular-nums ${tone}`}>{brl(cents)}</p>
      <p className="mt-1 text-xs text-muted">{children}</p>
    </div>
  );
}

function Statement({
  rows,
  filtered,
  noBalance,
  first,
  next,
}: {
  rows: Entry[];
  filtered: boolean;
  noBalance: boolean;
  first?: string;
  next?: string;
}) {
  return (
    <section aria-labelledby="lancamentos" className="space-y-3">
      <h2 id="lancamentos" className="sr-only">
        Lançamentos
      </h2>
      {noBalance && (
        <Alert tone="info">
          Com filtro de tipo ou de movimento, a coluna Saldo após fica indisponível (—): o saldo após cada lançamento só é
          calculável sobre a conta inteira.
        </Alert>
      )}
      <Table
        columns={["Data", "Lançamento", "Referência", "Valor", "Saldo após"]}
        empty={filtered ? "Nenhum lançamento com esses filtros no período." : "Nenhum lançamento no período."}
        caption="Lançamentos do extrato"
      >
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="whitespace-nowrap text-muted">{dataHora(r.createdAt)}</td>
            <td className="whitespace-nowrap font-medium">
              {LEDGER_KIND[r.kind]}
              {r.bucket === "blocked" && <span className="block text-xs font-normal text-muted">no saldo bloqueado</span>}
            </td>
            <td>
              <RefLink e={r} />
            </td>
            <td className="whitespace-nowrap text-right font-semibold tabular-nums">
              <Money cents={r.amountCents} sign className={r.amountCents < 0 ? "text-red-700" : "text-ok"} />
            </td>
            <td className="whitespace-nowrap text-right tabular-nums">
              {r.balanceAfter === null ? (
                <>
                  <span aria-hidden className="text-muted">
                    —
                  </span>
                  <span className="sr-only">indisponível</span>
                </>
              ) : (
                <Money cents={r.balanceAfter} />
              )}
            </td>
          </tr>
        ))}
      </Table>
      <p className="text-xs text-muted">Saldo após: o saldo disponível logo depois do lançamento.</p>
      <Pager first={first} next={next} />
    </section>
  );
}

function RefLink({ e }: { e: Entry }) {
  const href =
    e.refType === "charge"
      ? `/painel/cobrancas?id=${e.refId}`
      : e.refType === "payout"
        ? `/painel/saques/${e.refId}`
        : e.refType === "med_case"
          ? `/painel/med?id=${e.refId}`
          : null;
  const label = `${LEDGER_REF[e.refType]} ${e.refId.slice(0, 8)}`;
  return href ? (
    <Link href={href} className="whitespace-nowrap text-brand hover:underline">
      {label}
    </Link>
  ) : (
    <span className="whitespace-nowrap text-muted">{label}</span>
  );
}

function Closing({ rows }: { rows: DailyClosingRow[] }) {
  const cell = (cents: number, strong = false) => (
    <td className={`whitespace-nowrap text-right tabular-nums ${strong ? "font-semibold" : ""}`}>
      <Money cents={cents} />
    </td>
  );
  return (
    <section aria-labelledby="fechamento" className="space-y-3">
      <h2 id="fechamento" className="text-lg">
        Fechamento diário
      </h2>
      <p className="text-sm text-muted">
        Saldo disponível na abertura e no fechamento de cada dia, no horário de Brasília. Dia sem movimento repete o
        fechamento do anterior. Fechamento = abertura + entradas − saídas − tarifas ± MED.
      </p>
      <Table columns={["Data", "Abertura", "Entradas", "Saídas", "Tarifas", "MED", "Fechamento"]} caption="Fechamento diário">
        {rows.map((d) => (
          <tr key={d.day}>
            <td className="whitespace-nowrap">{diaBr(d.day)}</td>
            {cell(d.openingCents)}
            {cell(d.inflowCents)}
            {cell(d.outflowCents)}
            {cell(d.feeCents)}
            {cell(d.medCents)}
            {cell(d.closingCents, true)}
          </tr>
        ))}
      </Table>
    </section>
  );
}

function SearchResults({ q, r, clear }: { q: string; r: Found; clear: string }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg">{`Busca: “${q}”`}</h2>
        <Link href={clear} className="text-sm font-semibold text-brand hover:underline">
          Limpar busca
        </Link>
      </div>
      {r === "curta" ? (
        <Alert tone="info">Digite pelo menos 2 caracteres para buscar.</Alert>
      ) : r === "falha" ? (
        <Alert>Não foi possível buscar agora. Tente de novo — isto não significa que a transação não exista.</Alert>
      ) : !r.charges.length && !r.payouts.length ? (
        <Alert tone="info">{`Nenhuma transação encontrada para “${q}”.`}</Alert>
      ) : (
        // Só campos públicos: nada de brcode, ids do provedor, chave de idempotência nem a chave Pix.
        <div className="grid gap-4 lg:grid-cols-2">
          <Group title="Cobranças (Pix recebido)" empty="Nenhuma cobrança.">
            {r.charges.map((c) => (
              <Hit
                key={c.id}
                href={`/painel/cobrancas?id=${c.id}`}
                title={c.payerName || c.description || "Cobrança Pix"}
                detail={c.endToEndId ? `E2E ${c.endToEndId}` : `TxID ${c.txid}`}
                at={c.createdAt}
                cents={c.amountCents}
                badge={<StatusBadge kind="charge" status={c.status} />}
              />
            ))}
          </Group>
          <Group title="Transferências (Pix enviado)" empty="Nenhuma transferência.">
            {r.payouts.map((p) => (
              <Hit
                key={p.id}
                href={`/painel/saques/${p.id}`}
                title={p.description || "Saque Pix"}
                detail={p.endToEndId ? `E2E ${p.endToEndId}` : `ID ${p.id}`}
                at={p.createdAt}
                cents={p.amountCents}
                badge={<StatusBadge kind="payout" status={p.status} />}
              />
            ))}
          </Group>
        </div>
      )}
    </div>
  );
}

function Group({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children.length ? <ul className="mt-2 divide-y divide-line">{children}</ul> : <p className="mt-2 text-sm text-muted">{empty}</p>}
    </section>
  );
}

function Hit({
  href,
  title,
  detail,
  at,
  cents,
  badge,
}: {
  href: string;
  title: string;
  detail: string;
  at: Date;
  cents: number;
  badge: ReactNode;
}) {
  return (
    <li>
      <Link href={href} className="-mx-2 flex items-start justify-between gap-3 rounded-xl px-2 py-2.5 hover:bg-bg">
        <span className="min-w-0">
          <span className="block truncate font-medium text-ink">{title}</span>
          <span className="block break-all text-xs text-muted">{detail}</span>
          <span className="block text-xs text-muted">{dataHora(at)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <Money cents={cents} className="font-semibold tabular-nums" />
          {badge}
        </span>
      </Link>
    </li>
  );
}
