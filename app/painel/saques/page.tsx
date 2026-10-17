import type { Metadata } from "next";
import { Alert } from "@/app/components/ui/alert";
import { Card } from "@/app/components/ui/card";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { randomBase62 } from "@/lib/crypto";
import { getBalance } from "@/lib/money/ledger";
import { getPayout, listPayouts, type PayoutRow } from "@/lib/services/payouts";
import { brl, dataHora, feeText, painelSession, PIX_KEY_TYPES, uuidOrUndefined, withQuery } from "../lib";
import { Pager } from "../pager";
import { PayoutForm } from "./payout-form";

export const metadata: Metadata = { title: "Saques — Vantri" };

const keyLabel = (t: PayoutRow["pixKeyType"]) => PIX_KEY_TYPES.find(([k]) => k === t)?.[1] ?? t;

export default async function SaquesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const cursor = uuidOrUndefined(sp.cursor);
  const doneId = uuidOrUndefined(sp.feito);
  const [balance, list, done] = await Promise.all([
    getBalance(merchant.id),
    listPayouts(merchant.id, { cursor, limit: 20 }),
    doneId ? getPayout(merchant.id, doneId) : null, // de outro lojista → null
  ]);

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Sacar</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Saques</h1>
      </header>

      {done && <DoneAlert p={done} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Card className="h-fit">
          <p className="text-sm font-semibold text-muted">Disponível para saque</p>
          <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{brl(balance.available)}</p>
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
          <Table columns={["Pedido em", "Chave Pix", "Valor", "Tarifa", "Status"]} empty="Nenhum saque ainda." caption="Saques">
            {list.data.map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap text-muted">{dataHora(p.createdAt)}</td>
                <td>
                  <span className="block text-xs text-muted">{keyLabel(p.pixKeyType)}</span>
                  <span className="break-all font-medium">{p.pixKey}</span>
                </td>
                <td className="whitespace-nowrap font-semibold tabular-nums">{brl(p.amountCents)}</td>
                <td className="whitespace-nowrap tabular-nums text-muted">{brl(p.feeCents)}</td>
                <td>
                  <StatusBadge kind="payout" status={p.status} />
                  {p.status === "failed" && <span className="mt-1 block text-xs text-muted">Valor e tarifa estornados</span>}
                </td>
              </tr>
            ))}
          </Table>
          <Pager
            first={cursor ? "/painel/saques" : undefined}
            next={list.nextCursor ? withQuery("/painel/saques", { cursor: list.nextCursor }) : undefined}
          />
        </section>
      </div>
    </div>
  );
}

function DoneAlert({ p }: { p: PayoutRow }) {
  if (p.status === "failed") {
    return (
      <Alert>
        O saque de {brl(p.amountCents)} não foi concluído pelo banco
        {p.failureCode ? ` (${p.failureCode})` : ""}. O valor e a tarifa voltaram para o seu saldo.
      </Alert>
    );
  }
  return (
    <Alert tone="ok">
      {p.status === "completed"
        ? `Saque de ${brl(p.amountCents)} enviado para ${p.pixKey}.`
        : `Saque de ${brl(p.amountCents)} em processamento. Ele aparece como concluído assim que o banco confirmar.`}
    </Alert>
  );
}
