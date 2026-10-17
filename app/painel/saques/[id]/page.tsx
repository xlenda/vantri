import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Linha } from "@/app/comprovante/recibo";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import { getPayout } from "@/lib/services/payouts";
import { failureReason, maskPixKey, painelSession, PIX_KEY_TYPES } from "../../lib";

export const metadata: Metadata = { title: "Saque — Vantri" };

export default async function SaqueDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  const { merchant } = await painelSession();
  const { id } = await params;
  const p = await getPayout(merchant.id, id); // de outro lojista (ou id inválido) → null
  if (!p) notFound();
  const tipo = PIX_KEY_TYPES.find(([k]) => k === p.pixKeyType)?.[1] ?? p.pixKeyType;

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/painel/saques" className="inline-block text-sm font-semibold text-brand hover:underline">
        <span aria-hidden>←</span> Saques
      </Link>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted">Saque Pix</p>
            <h1 className="text-2xl tabular-nums sm:text-3xl">
              <span className="valor-sensivel">{brl(p.amountCents)}</span>
            </h1>
          </div>
          <StatusBadge kind="payout" status={p.status} />
        </div>

        {p.status === "failed" && (
          <Alert className="mt-5">
            <strong>Motivo:</strong> {failureReason(p.failureCode)}. O valor e a tarifa voltaram para o seu saldo.
          </Alert>
        )}
        {p.status === "processing" && (
          <Alert tone="info" className="mt-5">
            Aguardando a confirmação do banco. O saque aparece como concluído (ou com o motivo da falha) assim que ele
            responder.{" "}
            <Link href={`/painel/saques/${p.id}`} className="font-semibold text-brand hover:underline">
              Atualizar status
            </Link>
          </Alert>
        )}

        <dl className="mt-6 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Linha rotulo={`Chave Pix (${tipo})`}>{maskPixKey(p.pixKeyType, p.pixKey)}</Linha>
          <Linha rotulo="Tarifa">
            <span className="valor-sensivel">{brl(p.feeCents)}</span>
          </Linha>
          <Linha rotulo="Pedido em">{dataHora(p.createdAt)}</Linha>
          {p.completedAt && <Linha rotulo="Concluído em">{dataHora(p.completedAt)}</Linha>}
          <Linha rotulo="ID da transação (E2E)">
            <span className="break-all font-mono text-xs">{p.endToEndId ?? "—"}</span>
          </Linha>
          <Linha rotulo="ID do saque">
            <span className="break-all font-mono text-xs">{p.id}</span>
          </Linha>
          {p.description && <Linha rotulo="Descrição">{p.description}</Linha>}
        </dl>

        <div className="mt-6 border-t border-line pt-5">
          {p.status === "completed" ? (
            <Link href={`/painel/saques/${p.id}/comprovante`} className={buttonClass("primary")}>
              Ver comprovante
            </Link>
          ) : (
            <p className="text-sm text-muted">
              {p.status === "processing"
                ? "O comprovante fica disponível quando o saque for concluído."
                : "Saque não concluído, sem comprovante."}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
