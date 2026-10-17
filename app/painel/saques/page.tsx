import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { inputClass } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import { randomBase62 } from "@/lib/crypto";
import { getBalance } from "@/lib/money/ledger";
import { isSimulator } from "@/lib/provider";
import { countPayoutsByStatus, getPayout, listPayouts, type PayoutRow } from "@/lib/services/payouts";
import { failureReason, feeText, maskPixKey, painelSession, PIX_KEY_TYPES, uuidOrUndefined, withQuery } from "../lib";
import { Pager } from "../pager";
import { PayoutForm } from "./payout-form";

export const metadata: Metadata = { title: "Saques — Vantri" };

const keyLabel = (t: PayoutRow["pixKeyType"]) => PIX_KEY_TYPES.find(([k]) => k === t)?.[1] ?? t;

// Abas por status; o número de cada uma vem do histórico inteiro (countPayoutsByStatus), não da página.
const TABS = [
  ["all", "Todos"],
  ["processing", "Em processamento"],
  ["completed", "Concluídos"],
  ["failed", "Falhou"],
] as const;

export default async function SaquesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const status = TABS.find(([s]) => s !== "all" && s === sp.status)?.[0] as PayoutRow["status"] | undefined;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const cursor = uuidOrUndefined(sp.cursor);
  const doneId = uuidOrUndefined(sp.feito);
  const [balance, list, counts, done] = await Promise.all([
    getBalance(merchant.id),
    listPayouts(merchant.id, { cursor, limit: 20, status, q }),
    countPayoutsByStatus(merchant.id, q),
    doneId ? getPayout(merchant.id, doneId) : null, // de outro lojista → null
  ]);
  const qs = (p: Record<string, string | undefined>) => withQuery("/painel/saques", p);

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Sacar</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Saques</h1>
      </header>

      {done && <DoneAlert p={done} replayed={sp.repetido === "1"} simulator={isSimulator()} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Card className="h-fit">
          <p className="text-sm font-semibold text-muted">Disponível para saque</p>
          <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">
            <span className="valor-sensivel">{brl(balance.available)}</span>
          </p>
          <div className="mt-6">
            {/* Chave nova a cada render: reenviar o mesmo formulário não cria um segundo saque. */}
            <PayoutForm
              idempotencyKey={randomBase62(24)}
              keyTypes={PIX_KEY_TYPES}
              fee={feeText(merchant.feeOutBps, merchant.feeOutFixedCents)}
            />
          </div>
        </Card>

        <section aria-labelledby="historico" className="min-w-0 space-y-3">
          <h2 id="historico" className="text-lg">
            Histórico
          </h2>
          <form method="get" role="search" className="flex gap-2">
            {status && <input type="hidden" name="status" value={status} />}
            <label htmlFor="busca-saque" className="sr-only">
              Buscar por chave Pix ou E2E
            </label>
            <input
              id="busca-saque"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Chave Pix ou E2E"
              autoComplete="off"
              className={`${inputClass} min-w-0 flex-1`}
            />
            <button type="submit" className={buttonClass("ghost")}>
              Buscar
            </button>
          </form>
          <nav aria-label="Filtrar por status" className="flex flex-wrap items-center gap-1.5">
            {TABS.map(([s, label]) => {
              const active = (status ?? "all") === s;
              return (
                <Link
                  key={s}
                  href={qs({ status: s === "all" ? undefined : s, q })}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${
                    active ? "bg-ink text-white ring-ink" : "bg-white text-muted ring-line hover:text-ink"
                  }`}
                >
                  {label} <span className="tabular-nums">({counts[s]})</span>
                </Link>
              );
            })}
            {q && (
              <Link href={qs({ status })} className="px-2 text-xs font-semibold text-brand hover:underline">
                Limpar busca
              </Link>
            )}
          </nav>
          <Table
            columns={["Pedido em", "Chave Pix", "Valor", "Tarifa", "Status", ""]}
            empty={q ? "Nenhum saque encontrado para essa busca." : status ? "Nenhum saque com esse status." : "Nenhum saque ainda."}
            caption="Saques"
          >
            {list.data.map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap text-muted">{dataHora(p.createdAt)}</td>
                <td>
                  <span className="block text-xs text-muted">{keyLabel(p.pixKeyType)}</span>
                  <span className="break-all font-medium">{maskPixKey(p.pixKeyType, p.pixKey)}</span>
                </td>
                <td className="whitespace-nowrap font-semibold tabular-nums">
                  <span className="valor-sensivel">{brl(p.amountCents)}</span>
                </td>
                <td className="whitespace-nowrap tabular-nums text-muted">
                  <span className="valor-sensivel">{brl(p.feeCents)}</span>
                </td>
                <td>
                  <StatusBadge kind="payout" status={p.status} />
                  {p.status === "failed" && (
                    <span className="mt-1 block text-xs text-muted">
                      Motivo: {failureReason(p.failureCode)}. Valor e tarifa estornados.
                    </span>
                  )}
                </td>
                <td className="text-right">
                  <Link href={`/painel/saques/${p.id}`} className="font-semibold text-brand hover:underline">
                    Ver
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
          <Pager
            first={cursor ? qs({ status, q }) : undefined}
            next={list.nextCursor ? qs({ status, q, cursor: list.nextCursor }) : undefined}
          />
        </section>
      </div>
    </div>
  );
}

function DoneAlert({ p, replayed, simulator }: { p: PayoutRow; replayed: boolean; simulator: boolean }) {
  if (replayed) return <Alert tone="info">Este saque já tinha sido enviado (mesma solicitação).</Alert>;
  // No simulador nenhum Pix sai de verdade: o texto não pode dizer que o dinheiro foi enviado.
  const saque = simulator ? "saque simulado" : "saque";
  if (p.status === "failed") {
    return (
      <Alert>
        O {saque} de {brl(p.amountCents)} não foi concluído{simulator ? "" : " pelo banco"}. Motivo:{" "}
        {failureReason(p.failureCode)}. O valor e a tarifa voltaram para o seu saldo.
      </Alert>
    );
  }
  return (
    <Alert tone="ok">
      {p.status !== "completed"
        ? `Saque de ${brl(p.amountCents)} em processamento. Ele aparece como concluído assim que o banco confirmar.`
        : simulator
          ? `Saque simulado de ${brl(p.amountCents)} concluído para ${p.pixKey}. Nenhum dinheiro de verdade foi enviado.`
          : `Saque de ${brl(p.amountCents)} enviado para ${p.pixKey}.`}
    </Alert>
  );
}
