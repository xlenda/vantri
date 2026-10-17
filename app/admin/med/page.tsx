import { eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/components/ui/action-form";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input, Select } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { charges, merchants } from "@/lib/db/schema";
import { listMedCases, listMedFiles, type MedCaseRow } from "@/lib/services/med";
import { brl, dateTime, reais } from "../format";
import { parseMedFilters } from "../queries";
import { closeMedAction, openTestMedAction } from "./actions";

export const metadata: Metadata = { title: "MED — Admin Vantri" };

const PAGE = 20;
const TABS = [
  [undefined, "Todos"],
  ["open", "Abertos"],
  ["defended", "Com defesa"],
  ["merchant_won", "A favor do lojista"],
  ["payer_refunded", "Devolvidos"],
] as const;

export default async function MedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser({ role: "admin" });
  const f = parseMedFilters(await searchParams);
  const { data: cases, nextCursor } = await listMedCases(null, { status: f.status, cursor: f.cursor, limit: PAGE });
  const ids = [...new Set(cases.map((c) => c.merchantId))];
  const names = new Map(
    ids.length
      ? (
          await db()
            .select({ id: merchants.id, tradeName: merchants.tradeName })
            .from(merchants)
            .where(inArray(merchants.id, ids))
        ).map((m) => [m.id, m.tradeName])
      : [],
  );
  const href = (status?: string, cursor?: string) =>
    `/admin/med?${new URLSearchParams({ ...(status && { status }), ...(cursor && { apos: cursor }) })}`;

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">MED</h1>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
        Pedidos de devolução do Mecanismo Especial de Devolução. Ao abrir, o valor fica bloqueado no saldo do cliente até
        o encerramento.
      </p>

      {process.env.PIX_PROVIDER === "simulator" && <TestMed chargeId={f.chargeId} />}

      <nav aria-label="Filtrar por status" className="mt-8 flex flex-wrap gap-2">
        {TABS.map(([status, label]) => (
          <Link
            key={label}
            href={href(status)}
            aria-current={f.status === status ? "page" : undefined}
            className="rounded-full border border-line bg-white px-3.5 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
          >
            {label}
          </Link>
        ))}
      </nav>

      <ul className="mt-4 space-y-4">
        {cases.length === 0 && (
          <li className="rounded-2xl border border-line bg-white px-4 py-6 text-center text-sm text-muted">
            Nenhum caso de MED com este filtro.
          </li>
        )}
        {cases.map((c) => (
          <li key={c.id}>
            <MedCard c={c} tradeName={names.get(c.merchantId) ?? "—"} />
          </li>
        ))}
      </ul>

      {(f.cursor || nextCursor) && (
        <nav aria-label="Paginação" className="mt-4 flex justify-between gap-3">
          {f.cursor ? (
            <Link href={href(f.status)} className={buttonClass("ghost")}>
              Mais recentes
            </Link>
          ) : (
            <span />
          )}
          {nextCursor && (
            <Link href={href(f.status, nextCursor)} className={buttonClass("ghost")}>
              Próxima
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

async function MedCard({ c, tradeName }: { c: MedCaseRow; tradeName: string }) {
  const files = c.defenseText ? await listMedFiles(c.id, { role: "admin" }) : [];
  const closable = c.status === "open" || c.status === "defended";
  return (
    <article className="rounded-3xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/admin/clientes/${c.merchantId}`} className="font-semibold text-brand hover:underline">
            {tradeName}
          </Link>
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
          <dd>{dateTime(c.defenseDeadline)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-muted">{c.closedAt ? "Encerrado em" : "Cobrança"}</dt>
          <dd className={c.closedAt ? "" : "break-all font-mono text-xs"}>
            {c.closedAt ? dateTime(c.closedAt) : c.chargeId}
          </dd>
        </div>
      </dl>

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

      {/* Continua montado depois de encerrar para a resposta da ação aparecer. Sem nada visível dentro (só os
          inputs ocultos que o React põe em formulário de Server Action), não ocupa espaço. */}
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
