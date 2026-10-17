import type { Metadata } from "next";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Field, inputClass } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { maskDocument } from "@/lib/br/documents";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import { logError } from "@/lib/log";
import type { PayoutRow } from "@/lib/services/payouts";
import { searchTransactions } from "@/lib/services/search";
import { hasControlChars, painelSession, PIX_KEY_TYPES } from "../lib";

export const metadata: Metadata = { title: "Busca — Vantri" };

const LIMITE = 20;
const keyLabel = (t: PayoutRow["pixKeyType"]) => PIX_KEY_TYPES.find(([k]) => k === t)?.[1] ?? t;

/** Chave Pix na lista, nunca inteira: CPF/CNPJ pelo maskDocument; e-mail com a 1ª letra e o domínio; o resto, o fim. */
function maskPixKey(type: PayoutRow["pixKeyType"], key: string): string {
  if (type === "cpf" || type === "cnpj") return maskDocument(key);
  if (type === "email") return `${key[0]}***${key.slice(key.lastIndexOf("@"))}`;
  return `***${key.slice(-4)}`;
}

export default async function BuscaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Histórico</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Buscar transação</h1>
        <p className="mt-2 text-sm text-muted">Procura em todo o histórico, sem limite de período.</p>
      </header>

      <form method="get" role="search" className="max-w-2xl">
        <Field label="Identificador" htmlFor="q" hint="E2E, TxID, referência, nome do pagador, ID ou chave Pix do saque.">
          <div className="flex gap-2">
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={q}
              required
              minLength={2}
              aria-describedby="q-dica"
              className={`${inputClass} min-w-0 flex-1`}
            />
            <button type="submit" className={buttonClass("primary", "shrink-0")}>
              Buscar
            </button>
          </div>
        </Field>
      </form>

      {q.length === 1 && <p className="text-sm text-muted">Digite pelo menos 2 caracteres.</p>}
      {q.length > 1 && (
        // key: busca nova volta a mostrar "Buscando…" também na navegação pelo cliente.
        <Suspense key={q} fallback={<p role="status" className="text-sm text-muted">Buscando…</p>}>
          <Resultados merchantId={merchant.id} q={q} />
        </Suspense>
      )}
    </div>
  );
}

/** Só campos públicos: nada de brcode, id do provedor, chave de idempotência/hash nem chave Pix inteira. */
async function Resultados({ merchantId, q }: { merchantId: string; q: string }) {
  // Caractere de controle (NUL) o Postgres recusa em text: termo assim não casa nada, e não é falha.
  const r = hasControlChars(q)
    ? { charges: [], payouts: [] }
    : await searchTransactions(merchantId, q, LIMITE).catch((e: unknown) => {
        logError("painel: busca falhou", e, { merchant: merchantId });
        return null;
      });
  if (!r) return <Alert>Não foi possível buscar agora. Tente de novo — isto não significa que a transação não exista.</Alert>;
  if (!r.charges.length && !r.payouts.length) {
    return <Alert tone="info" className="break-words">{`Nenhuma transação encontrada para “${q}”.`}</Alert>;
  }

  return (
    <div className="space-y-8">
      <Grupo id="busca-cobrancas" titulo="Cobranças (Pix recebido)" n={r.charges.length}>
        <Table columns={["Criada em", "Identificação", "Pagador", "Valor", "Status", ""]} empty="Nenhuma cobrança encontrada." caption="Cobranças encontradas">
          {r.charges.map((c) => (
            <tr key={c.id}>
              <td className="whitespace-nowrap text-muted">{dataHora(c.createdAt)}</td>
              <td>
                <span className="block break-all font-medium">{c.externalRef}</span>
                <span className="block break-all text-xs text-muted">TxID {c.txid}</span>
                {c.endToEndId && <span className="block break-all text-xs text-muted">E2E {c.endToEndId}</span>}
              </td>
              <td>{c.payerName ?? <span className="text-muted">—</span>}</td>
              <td className="valor-sensivel whitespace-nowrap font-semibold tabular-nums">{brl(c.amountCents)}</td>
              <td>
                <StatusBadge kind="charge" status={c.status} />
              </td>
              <td className="text-right">
                <Link href={`/painel/cobrancas?id=${c.id}`} className="font-semibold text-brand hover:underline">
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </Table>
      </Grupo>

      <Grupo id="busca-saques" titulo="Transferências (Pix enviado)" n={r.payouts.length}>
        <Table columns={["Pedido em", "Identificação", "Valor", "Status", ""]} empty="Nenhuma transferência encontrada." caption="Transferências encontradas">
          {r.payouts.map((p) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap text-muted">{dataHora(p.createdAt)}</td>
              <td>
                <span className="block text-xs text-muted">{keyLabel(p.pixKeyType)}</span>
                <span className="block break-all font-medium">{maskPixKey(p.pixKeyType, p.pixKey)}</span>
                {p.endToEndId && <span className="block break-all text-xs text-muted">E2E {p.endToEndId}</span>}
              </td>
              <td className="valor-sensivel whitespace-nowrap font-semibold tabular-nums">{brl(p.amountCents)}</td>
              <td>
                <StatusBadge kind="payout" status={p.status} />
              </td>
              <td className="text-right">
                <Link href={`/painel/saques/${p.id}`} className="font-semibold text-brand hover:underline">
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </Table>
      </Grupo>
    </div>
  );
}

function Grupo({ id, titulo, n, children }: { id: string; titulo: string; n: number; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg">
        {titulo}
      </h2>
      {children}
      {n === LIMITE && <p className="text-sm text-muted">Mostrando as {LIMITE} mais recentes. Refine a busca para ver as outras.</p>}
    </section>
  );
}
