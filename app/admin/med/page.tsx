import { eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/app/components/ui/action-form";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input, Select } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, dateTime } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { charges, merchants } from "@/lib/db/schema";
import { deadlineBucket, listMedByDeadline, medKpis, merchantMedRates } from "@/lib/services/admin/med-queue";
import { listMedCases, listMedFiles, type MedCaseRow } from "@/lib/services/med";
import { DAY_MS, reais } from "../format";
import { pode } from "../perms-ui";
import { parseMedFilters } from "../queries";
import { closeMedAction, openTestMedAction } from "./actions";
import { Deadline, ratePct } from "./ui";

export const metadata: Metadata = { title: "MED — Admin Vantri" };

const PAGE = 20;
const HOUR_MS = 3_600_000;
const TABS = [
  [undefined, "Todos"],
  ["open", "Abertos"],
  ["defended", "Com defesa"],
  ["merchant_won", "A favor do lojista"],
  ["payer_refunded", "Devolvidos"],
] as const;
const TAB_CLASS =
  "rounded-full border border-line bg-white px-3.5 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-white";
// Faixa à esquerda do cartão com a cor do prazo (mesma régua do Deadline).
const EDGE = { red: "border-l-4 border-l-red-500", amber: "border-l-4 border-l-amber-400", ok: "" } as const;

export default async function MedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireAdmin({ perm: "med:ler" });
  // Só mostra/esconde abrir e encerrar: as ações re-checam med:operar no servidor.
  const canOperate = pode(user.adminRole, "med:operar");
  const simulator = process.env.PIX_PROVIDER === "simulator";
  const sp = await searchParams;
  const f = parseMedFilters(sp);
  // "Por prazo" (?ordem=prazo, o link da fila de pendências do início): só os sem desfecho, o mais urgente primeiro.
  const byDeadline = sp.ordem === "prazo";
  const [kpis, { data: cases, nextCursor }] = await Promise.all([
    medKpis(),
    byDeadline
      ? listMedByDeadline({ cursor: f.cursor, limit: PAGE, onlyOpen: true })
      : listMedCases(null, { status: f.status, cursor: f.cursor, limit: PAGE }),
  ]);
  const ids = [...new Set(cases.map((c) => c.merchantId))];
  const [names, rates] = await Promise.all([
    ids.length
      ? db()
          .select({ id: merchants.id, tradeName: merchants.tradeName })
          .from(merchants)
          .where(inArray(merchants.id, ids))
          .then((rows) => new Map(rows.map((m) => [m.id, m.tradeName])))
      : new Map<string, string>(),
    merchantMedRates(ids),
  ]);
  const href = (q: Record<string, string | undefined>) =>
    `/admin/med?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined))}`;
  const base = byDeadline ? { ordem: "prazo" } : { status: f.status };

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">MED</h1>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
        Pedidos de devolução do Mecanismo Especial de Devolução. Ao abrir, o valor fica bloqueado no saldo do cliente até
        o encerramento.
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Em aberto" value={kpis.open} />
        <Kpi label="Bloqueado" value={brl(kpis.blockedCents)} />
        <Kpi label="Vencem hoje" value={kpis.dueToday} tone={kpis.dueToday ? "amber" : undefined} />
        <Kpi label="Prazo vencido" value={kpis.overdue} tone={kpis.overdue ? "red" : undefined} />
        <Kpi label="Defesas a enviar" value={kpis.defensePendingSend} hint="envio requer parceiro" />
        <Kpi label="Tempo médio até o desfecho" value={duration(kpis.avgResolutionMs)} hint="últimos 30 dias" />
      </dl>

      {simulator && canOperate && <TestMed chargeId={f.chargeId} />}

      <nav aria-label="Ordenar e filtrar" className="mt-8 flex flex-wrap gap-2">
        <Link href={href({ ordem: "prazo" })} aria-current={byDeadline ? "page" : undefined} className={TAB_CLASS}>
          Por prazo
        </Link>
        {TABS.map(([status, label]) => (
          <Link
            key={label}
            href={href({ status })}
            aria-current={!byDeadline && f.status === status ? "page" : undefined}
            className={TAB_CLASS}
          >
            {label}
          </Link>
        ))}
      </nav>

      <ul className="mt-4 space-y-4">
        {cases.length === 0 && (
          <li className="rounded-2xl border border-line bg-white px-4 py-6 text-center text-sm text-muted">
            {byDeadline ? "Nenhum MED aguardando desfecho." : "Nenhum caso de MED com este filtro."}
          </li>
        )}
        {cases.map((c) => (
          <li key={c.id}>
            <MedCard
              c={c}
              tradeName={names.get(c.merchantId) ?? "—"}
              rate={rates.get(c.merchantId) ?? 0}
              simulator={simulator}
              canOperate={canOperate}
            />
          </li>
        ))}
      </ul>

      {(f.cursor || nextCursor) && (
        <nav aria-label="Paginação" className="mt-4 flex justify-between gap-3">
          {f.cursor ? (
            <Link href={href(base)} className={buttonClass("ghost")}>
              {byDeadline ? "Mais urgentes" : "Mais recentes"}
            </Link>
          ) : (
            <span />
          )}
          {nextCursor && (
            <Link href={href({ ...base, apos: nextCursor })} className={buttonClass("ghost")}>
              Próxima
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

const KPI_TONE = { red: "border-red-200 bg-red-50 text-red-800", amber: "border-amber-200 bg-amber-50 text-amber-900" };

function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: keyof typeof KPI_TONE }) {
  return (
    <div className={`rounded-2xl border p-4 ${tone ? KPI_TONE[tone] : "border-line bg-white"}`}>
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-bold tabular-nums">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-muted">{hint}</dd>}
    </div>
  );
}

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < HOUR_MS) return "menos de 1 h";
  if (ms < 48 * HOUR_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${(ms / DAY_MS).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;
}

async function MedCard({
  c,
  tradeName,
  rate,
  simulator,
  canOperate,
}: {
  c: MedCaseRow;
  tradeName: string;
  rate: number;
  simulator: boolean;
  canOperate: boolean;
}) {
  const files = c.defenseText ? await listMedFiles(c.id, { role: "admin" }) : [];
  const closable = c.status === "open" || c.status === "defended";
  return (
    <article className={`rounded-3xl border border-line bg-white p-5 ${EDGE[deadlineBucket(c)]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/admin/clientes/${c.merchantId}`} className="font-semibold text-brand hover:underline">
            {tradeName}
          </Link>
          <span className="block text-xs text-muted">Taxa de MED (30 dias): {ratePct(rate)}</span>
          <p className="mt-0.5 text-2xl font-bold tabular-nums">{brl(c.amountCents)}</p>
        </div>
        <StatusBadge kind="med" status={c.status} />
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-semibold text-muted">Motivo</dt>
          <dd>{c.reason}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-muted">Aberto em</dt>
          <dd>{dateTime(c.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-muted">Prazo da defesa</dt>
          <dd>
            <Deadline c={c} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-muted">{c.closedAt ? "Encerrado em" : "Cobrança"}</dt>
          <dd className={c.closedAt ? "" : "break-all font-mono text-xs"}>
            {c.closedAt ? dateTime(c.closedAt) : c.chargeId}
          </dd>
        </div>
      </dl>
      <Link href={`/admin/med/${c.id}`} className="mt-3 inline-block text-sm font-semibold text-brand hover:underline">
        Ver caso e linha do tempo
      </Link>

      {c.defenseText && (
        <details className="mt-4 rounded-2xl bg-bg/70 p-4 text-sm">
          <summary className="cursor-pointer font-semibold">Defesa do cliente</summary>
          <p className="mt-3 whitespace-pre-wrap break-words leading-relaxed">{c.defenseText}</p>
          {files.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {files.map((f) => (
                <li key={f.id}>
                  <a href={`/admin/med/arquivo/${f.id}`} className="break-all font-semibold text-brand hover:underline">
                    Baixar {f.filename}
                  </a>{" "}
                  <span className="text-xs text-muted">({Math.max(1, Math.round(f.sizeBytes / 1024))} KB)</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {/* Encerrar à mão só no simulador: com o parceiro, o desfecho chega pelo webhook dele. */}
      {!simulator && closable && <p className="mt-4 text-sm text-muted">Aguardando o desfecho do parceiro.</p>}
      {/* Continua montado depois de encerrar para a resposta da ação aparecer. Sem nada visível dentro (só os
          inputs ocultos que o React põe em formulário de Server Action), não ocupa espaço. */}
      {simulator && canOperate && (
        <ActionForm action={closeMedAction} className="has-[>div]:mt-4">
          {closable && (
            <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <input type="hidden" name="caseId" value={c.id} />
              <Select label="Encerrar o caso" name="outcome" required defaultValue="" id={`outcome-${c.id}`}>
                <option value="" disabled>
                  Escolha o desfecho
                </option>
                <option value="merchant_won">A favor do lojista (libera o valor bloqueado)</option>
                <option value="payer_refunded">Devolver ao pagador (debita o valor bloqueado)</option>
              </Select>
              <SubmitButton variant="ghost" pendingText="Encerrando…">
                Encerrar MED
              </SubmitButton>
            </div>
          )}
        </ActionForm>
      )}
    </article>
  );
}

/** Só com o simulador. `chargeId` vem de "Abrir MED de teste" na lista de transações. */
async function TestMed({ chargeId }: { chargeId?: string }) {
  const [charge] = chargeId
    ? await db()
        .select({ amountCents: charges.amountCents, status: charges.status, tradeName: merchants.tradeName })
        .from(charges)
        .innerJoin(merchants, eq(merchants.id, charges.merchantId))
        .where(eq(charges.id, chargeId))
    : [];
  return (
    <Card className="mt-6">
      <h2 className="text-lg">Abrir MED de teste</h2>
      <p className="mt-1 text-sm text-muted">
        Simula um MED do parceiro numa cobrança paga. Escolha a cobrança em{" "}
        <Link href="/admin/transacoes?tipo=cobrancas&status=paid" className="font-semibold text-brand">
          Transações
        </Link>{" "}
        ou cole o ID dela.
      </p>
      {charge && (
        <p className="mt-3 text-sm">
          Cobrança de <strong>{charge.tradeName}</strong>: {brl(charge.amountCents)}
          {charge.status !== "paid" && " (não está paga)"}
        </p>
      )}
      <ActionForm action={openTestMedAction} className="mt-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <Input label="ID da cobrança" name="chargeId" required maxLength={64} defaultValue={chargeId} className="font-mono" />
          <Input
            label="Valor (R$)"
            name="amount"
            inputMode="decimal"
            required
            maxLength={16}
            defaultValue={charge ? reais(charge.amountCents) : undefined}
          />
          <SubmitButton pendingText="Abrindo…">Abrir MED</SubmitButton>
        </div>
      </ActionForm>
    </Card>
  );
}
