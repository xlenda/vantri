import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { randomBase62 } from "@/lib/crypto";
import { isSimulator } from "@/lib/provider";
import { getBatch, listBatchPayouts, payoutCeilingCents, splitGreedy } from "@/lib/services/payouts";
import { feeText, painelSession, PIX_KEY_TYPES, uuidOrUndefined } from "../../lib";
import { type LoteView, Wizard } from "./wizard";

export const metadata: Metadata = { title: "Nova transferência — Vantri" };

export default async function NovoSaquePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const loteId = uuidOrUndefined(sp.lote);
  const lote = loteId ? await loteView(merchant.id, loteId, sp.repetido === "1") : undefined;
  // Chave nova a cada render, a mesma em todo reenvio deste assistente: clique duplo ou erro de rede não paga duas
  // vezes. Também é a key: depois do envio/retomada (redirect) o assistente remonta com o lote atualizado. Por isso
  // as ações só revalidam depois do sucesso: revalidar num erro trocaria a chave no meio de uma nova tentativa.
  const idempotencyKey = randomBase62(24);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <header>
        <Link href="/painel/saques" className="text-sm font-semibold text-brand hover:underline">
          ← Saques
        </Link>
        <p className="eyebrow mt-4">Sacar</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Nova transferência</h1>
      </header>
      <Wizard
        key={idempotencyKey}
        idempotencyKey={idempotencyKey}
        keyTypes={PIX_KEY_TYPES}
        fee={feeText(merchant.feeOutBps, merchant.feeOutFixedCents)}
        ceilingCents={payoutCeilingCents()}
        simulator={isSimulator()}
        lote={lote}
      />
    </div>
  );
}

/** Lote do banco, só do próprio lojista (de outro → 404, nunca o dado): parcelas planejadas + saques gravados. */
async function loteView(merchantId: string, id: string, replayed: boolean): Promise<LoteView> {
  const [batch, rows] = await Promise.all([getBatch(merchantId, id), listBatchPayouts(merchantId, id)]);
  if (!batch) notFound();
  const byIndex = new Map(rows.map((p) => [p.batchIndex, p]));
  return {
    id: batch.id,
    status: batch.status,
    totalCents: batch.totalCents,
    failedAtIndex: batch.failedAtIndex,
    replayed,
    parcels: splitGreedy(batch.totalCents, batch.chunkCents).map((amountCents, i) => {
      const p = byIndex.get(i);
      return { amountCents: p?.amountCents ?? amountCents, status: p?.status ?? "pending" };
    }),
  };
}
