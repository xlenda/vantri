import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { CopyButton } from "@/app/components/ui/copy-button";
import { Input } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { maskDocument } from "@/lib/br/documents";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import type { medEvents } from "@/lib/db/schema";
import { type ChargeRow, getCharge, toChargeJson } from "@/lib/services/charges";
import { listMedEvents } from "@/lib/services/med";
import { getPayout, type PayoutRow, toPayoutJson } from "@/lib/services/payouts";
import { searchTransactions } from "@/lib/services/search";
import { type DeliveryListRow, listDeliveries } from "@/lib/webhooks/attempts";
import { CopyField } from "../copy-field";
import { EVENT_LABEL, painelSession, PIX_KEY_TYPES, withQuery } from "../lib";
import { Pager } from "../pager";
import { type Aba, DetailTabs } from "./detail";
import { listTransactions, medCaseIdsOfCharge, parseTxFilters, type Tx } from "./queries";

export const metadata: Metadata = { title: "Transações — Vantri" };

const BASE = "/painel/transacoes";
const TITULO = "detalhe-titulo";

const TIPOS = [
  [undefined, "Todas"],
  ["cobrancas", "Cobranças"],
  ["saques", "Saques"],
] as const;
const SITUACOES = [
  [undefined, "Todas"],
  ["andamento", "Em andamento"],
  ["concluidas", "Concluídas"],
  ["falhas", "Expiradas e falhas"],
] as const;

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function TransacoesPage({ searchParams }: { searchParams: Search }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const f = parseTxFilters(sp);
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 100) : "";
  const id = typeof sp.id === "string" ? sp.id : undefined;
  const periodoInvalido = !!(f.de && f.ate && f.de > f.ate);
  const filtros = { tipo: f.tipo, situacao: f.situacao, de: f.de, ate: f.ate };
  // Abrir/fechar o detalhe mantém a busca, ou os filtros e a página, em que a pessoa está.
  const aqui = q ? { q } : { ...filtros, cursor: f.cursor };

  const [list, found, selected] = await Promise.all([
    q || periodoInvalido ? null : listTransactions(merchant.id, f),
    q.length >= 2 ? searchTransactions(merchant.id, q, 50) : null,
    id ? findTx(merchant.id, id) : null, // de outro lojista → null
  ]);
  const detalhe = selected && (await loadDetail(merchant.id, selected));
  const hrefDe = (txId: string) => withQuery(BASE, { ...aqui, id: txId });

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Pix</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Transações</h1>
        <p className="mt-2 text-sm text-muted">Cobranças e saques num lugar só. Escolha uma transação para ver o detalhe.</p>
      </header>

      <form method="get" action={BASE} role="search" className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:max-w-md sm:flex-1">
          <Input label="Buscar" name="q" defaultValue={q} maxLength={100} placeholder="E2E, TxID, referência, chave Pix ou nome" />
        </div>
        <button type="submit" className={buttonClass("primary")}>
          Buscar
        </button>
        {q && (
          <Link href={BASE} className={buttonClass("ghost")}>
            Limpar busca
          </Link>
        )}
      </form>

      {id && !selected && <Alert>Transação não encontrada.</Alert>}

      <div className={detalhe ? "grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] xl:items-start" : undefined}>
        {/* Antes da lista no HTML (no celular fica em cima, na largura toda); à direita a partir de xl. */}
        {detalhe && (
          <aside
            aria-labelledby={TITULO}
            className="min-w-0 rounded-3xl border border-line bg-white p-5 sm:p-6 xl:sticky xl:top-6 xl:col-start-2 xl:row-start-1 xl:max-h-[calc(100dvh-3rem)] xl:overflow-y-auto"
          >
            <Detalhe d={detalhe} fechar={withQuery(BASE, aqui)} />
          </aside>
        )}

        <section aria-label="Transações" className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1">
          {q ? (
            <Busca q={q} found={found} hrefDe={hrefDe} selecionado={selected?.row.id} />
          ) : (
            <>
              <div className="space-y-3">
                <Pills label="Tipo" itens={TIPOS} atual={f.tipo} href={(tipo) => withQuery(BASE, { ...filtros, tipo })} />
                <Pills
                  label="Situação"
                  itens={SITUACOES}
                  atual={f.situacao}
                  href={(situacao) => withQuery(BASE, { ...filtros, situacao })}
                />
                <form method="get" action={BASE} className="flex flex-wrap items-end gap-3">
                  {f.tipo && <input type="hidden" name="tipo" value={f.tipo} />}
                  {f.situacao && <input type="hidden" name="situacao" value={f.situacao} />}
                  <div className="w-full sm:w-44">
                    <Input type="date" label="De" name="de" defaultValue={f.de} />
                  </div>
                  <div className="w-full sm:w-44">
                    <Input type="date" label="Até" name="ate" defaultValue={f.ate} />
                  </div>
                  <button type="submit" className={buttonClass("ghost")}>
                    Filtrar período
                  </button>
                  {(f.de || f.ate) && (
                    <Link
                      href={withQuery(BASE, { tipo: f.tipo, situacao: f.situacao })}
                      className="py-3 text-sm font-semibold text-brand hover:underline"
                    >
                      Limpar período
                    </Link>
                  )}
                </form>
                <p className="text-xs text-muted">Período pelo dia de criação, no horário de Brasília.</p>
              </div>

              {periodoInvalido && <Alert>Período inválido: a data inicial precisa ser anterior ou igual à final.</Alert>}
              {list &&
                (list.data.length ? (
                  <TxItens itens={list.data} hrefDe={hrefDe} selecionado={selected?.row.id} />
                ) : (
                  <Vazio>
                    {f.tipo || f.situacao || f.de || f.ate || f.cursor ? (
                      "Nenhuma transação com estes filtros."
                    ) : (
                      <>
                        Nenhuma transação ainda.{" "}
                        <Link href="/painel/cobrancas" className="font-semibold text-brand hover:underline">
                          Crie uma cobrança
                        </Link>{" "}
                        para receber o primeiro Pix.
                      </>
                    )}
                  </Vazio>
                ))}
              {list && (
                <Pager
                  first={f.cursor ? withQuery(BASE, filtros) : undefined}
                  next={list.nextCursor ? withQuery(BASE, { ...filtros, cursor: list.nextCursor }) : undefined}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

async function findTx(merchantId: string, id: string): Promise<Tx | null> {
  const [charge, payout] = await Promise.all([getCharge(merchantId, id), getPayout(merchantId, id)]);
  return charge ? { kind: "charge", row: charge } : payout ? { kind: "payout", row: payout } : null;
}

type MedEvento = Awaited<ReturnType<typeof listMedEvents>>[number];
type Dados = {
  t: Tx;
  json: object; // aba Payloads
  net: number | null; // "você recebe" da cobrança, como o JSON público calcula
  entregas: DeliveryListRow[];
  med: Array<{ caseId: string; events: MedEvento[] }>;
};

/** Tudo que as abas mostram, já do lojista da sessão (as entregas e o MED também filtram por ele). */
async function loadDetail(merchantId: string, t: Tx): Promise<Dados> {
  const json =
    t.kind === "charge" ? await toChargeJson(t.row, { withQr: false }) : { ...toPayoutJson(t.row), pix_key: chave(t.row) };
  const caseIds = t.kind === "charge" ? await medCaseIdsOfCharge(merchantId, t.row.id) : [];
  const [entregas, med] = await Promise.all([
    // Entregas cujo data.id é a transação (ou um MED dela).
    Promise.all([t.row.id, ...caseIds].map((term) => listDeliveries(merchantId, { term, limit: 25 }))),
    Promise.all(
      caseIds.map(async (caseId) => ({ caseId, events: await listMedEvents(caseId, { role: "merchant", merchantId }) })),
    ),
  ]);
  return {
    t,
    json,
    net: "net" in json ? json.net : null,
    entregas: entregas.flatMap((r) => r.data).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    med,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lista

/** Chave Pix para exibir: CPF/CNPJ mascarado (como o pagador); e-mail, celular e chave aleatória como estão. */
const chave = (p: PayoutRow) => (p.pixKeyType === "cpf" || p.pixKeyType === "cnpj" ? maskDocument(p.pixKey) : p.pixKey);
const keyLabel = (t: PayoutRow["pixKeyType"]) => PIX_KEY_TYPES.find(([k]) => k === t)?.[1] ?? t;

const titulo = (t: Tx) =>
  t.kind === "charge" ? t.row.description || t.row.payerName || "Cobrança Pix" : t.row.description || `Para ${chave(t.row)}`;

function Badge({ t }: { t: Tx }) {
  return t.kind === "charge" ? <StatusBadge kind="charge" status={t.row.status} /> : <StatusBadge kind="payout" status={t.row.status} />;
}

/** Valor em reais: toda quantia da tela passa por aqui (o "ocultar saldos" esconde a classe valor-sensivel). */
function Valor({ cents }: { cents: number }) {
  return <span className="valor-sensivel tabular-nums">{brl(cents)}</span>;
}

function Seta({ entrada }: { entrada: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid size-9 shrink-0 place-items-center rounded-full ${entrada ? "bg-ok/10 text-ok" : "bg-bg text-muted"}`}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d={entrada ? "M17 7 7 17M7 9v8h8" : "M7 17 17 7M9 7h8v8"} />
      </svg>
    </span>
  );
}

function TxItens({ itens, hrefDe, selecionado }: { itens: Tx[]; hrefDe: (id: string) => string; selecionado?: string }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
      {itens.map((t) => (
        <li key={t.row.id}>
          {/* scroll={false}: no computador a lista fica onde está; o painel pega o foco ao abrir (detail.tsx). */}
          <Link
            href={hrefDe(t.row.id)}
            scroll={false}
            aria-current={t.row.id === selecionado ? "true" : undefined}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg/60 aria-[current=true]:bg-brand/5"
          >
            <Seta entrada={t.kind === "charge"} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-ink">{titulo(t)}</span>
              <span className="block truncate text-xs text-muted">
                {t.kind === "charge" ? "Cobrança" : "Saque"} · {dataHora(t.row.createdAt)}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <span className="font-semibold">
                <Valor cents={t.row.amountCents} />
              </span>
              <Badge t={t} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Pills({
  label,
  itens,
  atual,
  href,
}: {
  label: string;
  itens: ReadonlyArray<readonly [string | undefined, string]>;
  atual?: string;
  href: (v: string | undefined) => string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1.5">
      {itens.map(([v, nome]) => (
        <Link
          key={nome}
          href={href(v)}
          aria-current={v === atual ? "page" : undefined}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${
            v === atual ? "bg-ink text-white ring-ink" : "bg-white text-muted ring-line hover:text-ink"
          }`}
        >
          {nome}
        </Link>
      ))}
    </nav>
  );
}

function Vazio({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-sm text-muted">{children}</p>;
}

function Busca({
  q,
  found,
  hrefDe,
  selecionado,
}: {
  q: string;
  found: { charges: ChargeRow[]; payouts: PayoutRow[] } | null;
  hrefDe: (id: string) => string;
  selecionado?: string;
}) {
  const itens: Tx[] = found
    ? [
        ...found.charges.map((row) => ({ kind: "charge" as const, row })),
        ...found.payouts.map((row) => ({ kind: "payout" as const, row })),
      ].sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime())
    : [];
  return (
    <div className="space-y-3">
      <h2 className="text-lg">Resultados da busca</h2>
      {!found ? (
        <Vazio>Digite pelo menos 2 caracteres para buscar.</Vazio>
      ) : itens.length ? (
        <TxItens itens={itens} hrefDe={hrefDe} selecionado={selecionado} />
      ) : (
        <Vazio>Nada encontrado para “{q}”.</Vazio>
      )}
      <p className="text-xs text-muted">
        A busca olha o histórico inteiro, sem os filtros da lista: E2E, TxID, referência, ID do saque, chave Pix e o começo
        do nome do pagador. Mostra até 50 cobranças e 50 saques.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Detalhe (abas)

const DL = "grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2";

function Item({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-ink">{children}</dd>
    </div>
  );
}

function Copiavel({ valor }: { valor: string }) {
  return (
    <span className="flex items-start justify-between gap-2">
      <span className="min-w-0 select-all break-all font-mono text-xs leading-7">{valor}</span>
      <CopyButton text={valor} className="h-7 shrink-0 px-2.5 text-xs" />
    </span>
  );
}

function Nota({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-sm leading-relaxed text-muted">{children}</p>;
}

function Detalhe({ d, fechar }: { d: Dados; fechar: string }) {
  const { t } = d;
  const abas: Aba[] = [
    ...(t.kind === "charge" ? abasCobranca(t.row, d) : abasSaque(t.row)),
    { id: "webhooks", label: "Webhooks", content: <Entregas entregas={d.entregas} kind={t.kind} /> },
    { id: "timeline", label: "Timeline", content: <Linha eventos={t.kind === "charge" ? eventosCobranca(t.row, d.med) : eventosSaque(t.row)} /> },
    { id: "payloads", label: "Payloads", content: <Payload json={d.json} kind={t.kind} /> },
  ];
  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t.kind === "charge" ? "Entrada" : "Saída"}</p>
          <h2 id={TITULO} tabIndex={-1} className="mt-1 text-lg">
            {t.kind === "charge" ? "Cobrança Pix" : "Saque Pix"}
          </h2>
          <p className="mt-1 text-2xl font-bold">
            <Valor cents={t.row.amountCents} />
          </p>
          <div className="mt-2">
            <Badge t={t} />
          </div>
        </div>
        <Link href={fechar} scroll={false} className={buttonClass("ghost", "h-9 shrink-0 px-3")}>
          Fechar
        </Link>
      </div>
      <DetailTabs key={t.row.id} abas={abas} tituloId={TITULO} />
    </>
  );
}

function abasCobranca(c: ChargeRow, d: Dados): Aba[] {
  const e2e = c.endToEndId ? <Copiavel valor={c.endToEndId} /> : c.status === "pending" ? "Aparece quando a cobrança for paga." : "—";
  return [
    {
      id: "resumo",
      label: "Resumo",
      content: (
        <dl className={DL}>
          <Item label="ID da cobrança" wide>
            <Copiavel valor={c.id} />
          </Item>
          <Item label="TxID" wide>
            <Copiavel valor={c.txid} />
          </Item>
          <Item label="Referência (external_ref)" wide>
            <Copiavel valor={c.externalRef} />
          </Item>
          <Item label="Identificador do Pix (E2E)" wide>
            {e2e}
          </Item>
          <Item label="Criada em">{dataHora(c.createdAt)}</Item>
          {c.status === "paid" ? (
            c.paidAt && <Item label="Paga em">{dataHora(c.paidAt)}</Item>
          ) : (
            <Item label={c.status === "expired" ? "Expirou em" : "Expira em"}>{dataHora(c.expiresAt)}</Item>
          )}
          <Item label="Pagador">{c.payerName ?? (c.status === "pending" ? "Aparece quando a cobrança for paga." : "—")}</Item>
          {/* Gravado já mascarado (applyChargePaid usa maskDocument). */}
          <Item label="Documento do pagador">{c.payerDocumentMasked ?? "—"}</Item>
          <Item label="Descrição" wide>
            {c.description || "—"}
          </Item>
        </dl>
      ),
    },
    {
      id: "pix",
      label: "Pix",
      content: (
        <div className="space-y-4">
          {c.status === "pending" ? (
            <>
              <CopyField id="pix-copia-e-cola" label="Pix copia e cola" value={c.brcode} rows={4} />
              <p className="text-sm text-muted">Vale até {dataHora(c.expiresAt)}.</p>
            </>
          ) : (
            <p className="text-sm text-muted">
              {c.status === "paid"
                ? "Cobrança paga: o copia e cola já foi usado."
                : "Cobrança expirada: o copia e cola não aceita mais pagamento."}
            </p>
          )}
          <dl className={DL}>
            <Item label="TxID" wide>
              <Copiavel valor={c.txid} />
            </Item>
            <Item label="Identificador do Pix (E2E)" wide>
              {e2e}
            </Item>
          </dl>
          <Link href={`/painel/cobrancas?id=${c.id}`} className={buttonClass("ghost")}>
            {c.status === "pending" ? "Ver QR Code" : "Abrir cobrança"}
          </Link>
        </div>
      ),
    },
    {
      id: "financeiro",
      label: "Financeiro",
      content: (
        <>
          <dl className={DL}>
            <Item label="Valor">
              <Valor cents={c.amountCents} />
            </Item>
            <Item label="Tarifa">
              <Valor cents={c.feeCents} />
            </Item>
            <Item label={c.status === "paid" ? "Você recebeu" : "Você recebe"}>
              {c.status === "expired" || d.net === null ? "—" : <Valor cents={d.net} />}
            </Item>
            <Item label="Direção">Entrada (Pix recebido)</Item>
            <Item label="Moeda">Real (BRL)</Item>
          </dl>
          <Nota>
            {c.status === "paid"
              ? "A tarifa foi descontada no recebimento e o líquido entrou no saldo disponível."
              : c.status === "pending"
                ? "A tarifa só é descontada quando o Pix for pago."
                : "Expirou sem pagamento: nada entrou no saldo e nenhuma tarifa foi cobrada."}{" "}
            A tarifa é a da sua conta quando a cobrança foi criada.
          </Nota>
        </>
      ),
    },
  ];
}

function abasSaque(p: PayoutRow): Aba[] {
  const e2e = p.endToEndId ? <Copiavel valor={p.endToEndId} /> : p.status === "processing" ? "Aparece quando o banco confirmar." : "—";
  return [
    {
      id: "resumo",
      label: "Resumo",
      content: (
        <>
          <dl className={DL}>
            <Item label="ID do saque" wide>
              <Copiavel valor={p.id} />
            </Item>
            <Item label="Identificador do Pix (E2E)" wide>
              {e2e}
            </Item>
            <Item label="Pedido em">{dataHora(p.createdAt)}</Item>
            {p.completedAt && <Item label="Concluído em">{dataHora(p.completedAt)}</Item>}
            {p.failureCode && (
              <Item label="Código da falha">
                <span className="font-mono text-xs">{p.failureCode}</span>
              </Item>
            )}
            {p.batchIndex !== null && <Item label="Saque parcelado">Parcela {p.batchIndex + 1}</Item>}
            <Item label="Descrição" wide>
              {p.description || "—"}
            </Item>
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={`/painel/saques/${p.id}`} className={buttonClass("ghost")}>
              Abrir saque
            </Link>
            {p.status === "completed" && (
              <Link href={`/painel/saques/${p.id}/comprovante`} className={buttonClass("ghost")}>
                Comprovante
              </Link>
            )}
          </div>
        </>
      ),
    },
    {
      id: "pix",
      label: "Pix",
      content: (
        <dl className={DL}>
          <Item label="Tipo de chave">{keyLabel(p.pixKeyType)}</Item>
          <Item label="Chave Pix">
            <span className="break-all">{chave(p)}</span>
          </Item>
          <Item label="Identificador do Pix (E2E)" wide>
            {e2e}
          </Item>
          <Item label="Favorecido" wide>
            Nome e instituição de quem recebeu: requer parceiro de Pix.
          </Item>
        </dl>
      ),
    },
    {
      id: "financeiro",
      label: "Financeiro",
      content: (
        <>
          <dl className={DL}>
            <Item label="Valor">
              <Valor cents={p.amountCents} />
            </Item>
            <Item label="Tarifa">
              <Valor cents={p.feeCents} />
            </Item>
            <Item label="Direção">Saída (Pix enviado)</Item>
            <Item label="Moeda">Real (BRL)</Item>
          </dl>
          <Nota>
            {p.status === "failed"
              ? "O banco não concluiu o envio: o valor e a tarifa voltaram para o seu saldo."
              : p.status === "processing"
                ? "O valor e a tarifa já saíram do seu saldo. Se o banco recusar, os dois voltam."
                : "O valor e a tarifa saíram do seu saldo disponível."}
          </Nota>
        </>
      ),
    },
  ];
}

function Entregas({ entregas, kind }: { entregas: DeliveryListRow[]; kind: Tx["kind"] }) {
  if (!entregas.length) {
    return (
      <div className="space-y-2 text-sm leading-relaxed text-muted">
        <p>Nenhuma entrega de webhook desta transação.</p>
        <p>
          Elas aparecem quando {kind === "charge" ? "a cobrança é paga ou expira" : "o saque é concluído ou falha"} e um
          webhook seu assina o evento.{" "}
          <Link href="/painel/integracoes" className="font-semibold text-brand hover:underline">
            Configurar webhooks
          </Link>
        </p>
      </div>
    );
  }
  const label = EVENT_LABEL as Record<string, string>;
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line">
      {entregas.map((e) => (
        <li key={e.id} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-ink">{label[e.eventType] ?? e.eventType}</span>
            <StatusBadge kind="delivery" status={e.status} />
          </div>
          <p className="break-all text-xs text-muted">{e.url}</p>
          <p className="text-xs text-muted">
            {dataHora(e.createdAt)} · {e.attempts === 1 ? "1 tentativa" : `${e.attempts} tentativas`}
            {e.lastStatusCode ? ` · HTTP ${e.lastStatusCode}` : ""}
          </p>
          <Link href={`/painel/integracoes/entregas/${e.id}`} className="inline-block text-xs font-semibold text-brand hover:underline">
            Inspecionar entrega
          </Link>
        </li>
      ))}
    </ul>
  );
}

type Evento = { quando?: Date; texto: string; previsto?: boolean; href?: string };

// Anotação interna da equipe (`note`) não é do lojista: fica de fora.
const MED_EVENTO = {
  opened: "MED aberto pelo banco do pagador",
  funds_blocked: "Valor bloqueado no seu saldo",
  defense_submitted: "Você enviou a defesa",
  defense_sent: "Defesa enviada ao parceiro",
  analysis: "Em análise no parceiro",
  closed_merchant_won: "MED encerrado a seu favor (valor liberado)",
  closed_payer_refunded: "MED encerrado com devolução ao pagador (valor debitado)",
  closed: "MED encerrado",
} satisfies Record<Exclude<(typeof medEvents.$inferSelect)["type"], "note">, string>;

function eventosCobranca(c: ChargeRow, med: Dados["med"]): Evento[] {
  const fim: Evento | null =
    c.status === "paid"
      ? c.paidAt && { quando: c.paidAt, texto: c.payerName ? `Pagamento recebido de ${c.payerName}` : "Pagamento recebido" }
      : c.status === "expired"
        ? { quando: c.expiresAt, texto: "Expirou sem pagamento" }
        : { quando: c.expiresAt, texto: "Expira se não for paga", previsto: true };
  const disputas = med.flatMap(({ caseId, events }) =>
    events.flatMap((e): Evento[] =>
      e.type === "note"
        ? []
        : [{ quando: e.createdAt, texto: MED_EVENTO[e.type], href: e.type === "opened" ? `/painel/med?id=${caseId}` : undefined }],
    ),
  );
  return [{ quando: c.createdAt, texto: "Cobrança criada" }, ...(fim ? [fim] : []), ...disputas];
}

function eventosSaque(p: PayoutRow): Evento[] {
  return [
    { quando: p.createdAt, texto: "Saque pedido: valor e tarifa saíram do saldo" },
    p.status === "completed"
      ? { quando: p.completedAt ?? undefined, texto: "Pix enviado (concluído)" }
      : p.status === "failed"
        ? { texto: "Não concluído pelo banco: valor e tarifa voltaram para o saldo" }
        : { texto: "Aguardando a confirmação do banco" },
  ];
}

function Linha({ eventos }: { eventos: Evento[] }) {
  return (
    <ol className="space-y-3">
      {eventos.map((e, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${e.previsto ? "bg-line" : "bg-brand"}`} />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-ink">{e.texto}</p>
            {e.quando && (
              <p className="text-xs text-muted">
                {e.previsto ? "Previsto: " : ""}
                {dataHora(e.quando)}
              </p>
            )}
            {e.href && (
              <Link href={e.href} className="text-xs font-semibold text-brand hover:underline">
                Ver caso de MED
              </Link>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Payload({ json, kind }: { json: object; kind: Tx["kind"] }) {
  const texto = JSON.stringify(json, null, 2);
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-muted">
        {kind === "charge"
          ? "JSON público da cobrança, o mesmo dos webhooks (pela API vem também a imagem do QR, em qr_code_base64)."
          : "JSON público do saque, o mesmo da API e dos webhooks. Chave CPF/CNPJ aparece mascarada nesta tela."}
      </p>
      <pre className="valor-sensivel max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-ink">
        {texto}
      </pre>
      <CopyButton text={texto} label="Copiar JSON" />
    </div>
  );
}
