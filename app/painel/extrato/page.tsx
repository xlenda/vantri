import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/field";
import { Table } from "@/app/components/ui/table";
import { ApiError } from "@/lib/api/http";
import { listStatement } from "@/lib/api/statement";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import type { ledgerEntries } from "@/lib/db/schema";
import { LEDGER_BUCKET, LEDGER_KIND, LEDGER_REF, painelSession, uuidOrUndefined, withQuery } from "../lib";
import { Pager } from "../pager";

export const metadata: Metadata = { title: "Extrato — Vantri" };

type Entry = typeof ledgerEntries.$inferSelect;
const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

export default async function ExtratoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const from = str(sp.from);
  const to = str(sp.to);
  const cursor = uuidOrUndefined(sp.cursor);

  let page: Awaited<ReturnType<typeof listStatement>> = { data: [], nextCursor: null };
  let invalid = false;
  try {
    page = await listStatement(merchant.id, { from, to, cursor, limit: 50 });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    invalid = true;
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Movimentação</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Extrato</h1>
        <p className="mt-2 text-sm text-muted">Cada entrada e saída do seu saldo. Sem datas, mostra os últimos 30 dias.</p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-44">
          <Input type="date" label="De" name="from" defaultValue={from} />
        </div>
        <div className="w-full sm:w-44">
          <Input type="date" label="Até" name="to" defaultValue={to} />
        </div>
        <button type="submit" className={buttonClass("primary")}>
          Filtrar
        </button>
        <a href={withQuery("/painel/extrato/csv", { from, to })} className={buttonClass("ghost")} download>
          Baixar CSV
        </a>
      </form>

      {invalid && (
        <Alert>Período inválido. A data inicial precisa ser anterior ou igual à final, e o período pode ter no máximo 366 dias.</Alert>
      )}

      <section className="space-y-3">
        <Table columns={["Data", "Lançamento", "Saldo", "Referência", "Valor"]} empty="Nenhum lançamento no período." caption="Extrato">
          {page.data.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap text-muted">{dataHora(e.createdAt)}</td>
              <td className="whitespace-nowrap font-medium">{LEDGER_KIND[e.kind]}</td>
              <td className="text-muted">{LEDGER_BUCKET[e.bucket]}</td>
              <td>
                <RefLink e={e} />
              </td>
              <td className={`whitespace-nowrap text-right font-semibold tabular-nums ${e.amountCents < 0 ? "text-red-700" : "text-ok"}`}>
                {e.amountCents > 0 ? "+" : ""}
                {brl(e.amountCents)}
              </td>
            </tr>
          ))}
        </Table>
        <Pager
          first={cursor ? withQuery("/painel/extrato", { from, to }) : undefined}
          next={page.nextCursor ? withQuery("/painel/extrato", { from, to, cursor: page.nextCursor }) : undefined}
        />
      </section>
    </div>
  );
}

function RefLink({ e }: { e: Entry }) {
  const href =
    e.refType === "charge" ? `/painel/cobrancas?id=${e.refId}` : e.refType === "med_case" ? `/painel/med?id=${e.refId}` : e.refType === "payout" ? "/painel/saques" : null;
  const label = `${LEDGER_REF[e.refType]} ${e.refId.slice(0, 8)}`;
  return href ? (
    <Link href={href} className="whitespace-nowrap text-brand hover:underline">
      {label}
    </Link>
  ) : (
    <span className="whitespace-nowrap text-muted">{label}</span>
  );
}
