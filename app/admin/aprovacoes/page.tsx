import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/app/components/ui/action-form";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/field";
import { Badge } from "@/app/components/ui/status-badge";
import { feeText } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, dateTime } from "@/lib/br/money";
import { type ApprovalKind, listPendingApprovals } from "@/lib/services/admin/approvals";
import type { Fees } from "@/lib/services/merchants";
import { OpButton } from "../clientes/op-button";
import { CodeInput } from "../equipe/forms";
import { decideApprovalAction } from "./actions";

export const metadata: Metadata = { title: "Aprovações — Admin Vantri" };

const KIND_LABEL: Record<ApprovalKind, string> = {
  balance_adjustment: "Ajuste de saldo",
  payout_reversal: "Estorno manual de saque",
  fee_change: "Mudança de taxa",
  merchant_reactivate: "Reativação de cliente",
};

type Pending = Awaited<ReturnType<typeof listPendingApprovals>>[number];

/** O que a aprovação aplica, em uma frase. O payload foi validado por tipo ao criar o pedido (requestApproval). */
function effect(r: Pending): ReactNode {
  switch (r.kind) {
    case "balance_adjustment": {
      const cents = r.amountCents ?? 0;
      return `${cents < 0 ? "Débito" : "Crédito"} de ${brl(Math.abs(cents))} no saldo disponível`;
    }
    case "payout_reversal": {
      const { payoutId } = r.payload as { payoutId: string };
      return (
        <>
          {`Marcar o saque como falho e devolver ${brl(r.amountCents ?? 0)} (valor + tarifa) ao disponível. `}
          <Link href={`/admin/saques/${payoutId}`} className="font-semibold text-brand">
            Ver o saque
          </Link>
        </>
      );
    }
    case "fee_change": {
      const [now, next] = [r.currentFees, r.payload as Fees];
      return `Pix recebido: ${feeText(now.feeInBps, now.feeInFixedCents)} → ${feeText(next.feeInBps, next.feeInFixedCents)}. Pix enviado: ${feeText(now.feeOutBps, now.feeOutFixedCents)} → ${feeText(next.feeOutBps, next.feeOutFixedCents)}.`;
    }
    case "merchant_reactivate":
      return "Reativar o cliente: volta a usar o painel e a API.";
  }
}

export default async function AprovacoesPage() {
  const { user } = await requireAdmin({ perm: "quatro_olhos:aprovar" });
  const rows = await listPendingApprovals();

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Aprovações</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Quatro olhos: ajuste de saldo, estorno manual de saque, mudança de taxa de cliente ativo e reativação de cliente
        só acontecem quando um segundo administrador aprova. Quem pediu não aprova o próprio pedido. Aprovar aplica na
        hora; recusar não aplica nada.
      </p>

      {rows.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-muted">Nenhum pedido esperando aprovação.</p>
        </Card>
      ) : (
        <ul className="mt-6 space-y-4">
          {rows.map((r) => (
            <li key={r.id}>
              <Card>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg">{KIND_LABEL[r.kind]}</h2>
                  <Badge tone="warn">aguardando aprovação</Badge>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
                  <Row label="Cliente">
                    <Link href={`/admin/clientes/${r.merchantId}`} className="font-semibold text-brand">
                      {r.tradeName}
                    </Link>
                  </Row>
                  <Row label="O que muda">{effect(r)}</Row>
                  <Row label="Motivo">{r.reason}</Row>
                  <Row label="Pedido por">{`${r.requesterEmail} em ${dateTime(r.createdAt)}`}</Row>
                </dl>
                <Decide id={r.id} own={r.requestedBy === user.id} />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** Aprovar ou recusar, com código 2FA novo. No próprio pedido não há Aprovar (e o servidor recusaria: self_approval). */
function Decide({ id, own }: { id: string; own: boolean }) {
  return (
    <ActionForm action={decideApprovalAction} className="mt-5 space-y-4 border-t border-line pt-5">
      <input type="hidden" name="id" value={id} />
      <Input
        label="Motivo da recusa"
        name="reason"
        id={`motivo-${id}`}
        maxLength={500}
        hint="Só para recusar. Fica na auditoria: não escreva dados pessoais (documento, chave Pix)."
      />
      <CodeInput id={`codigo-${id}`} />
      {own && <p className="text-sm font-semibold text-muted">Pedido seu: outro administrador precisa aprovar.</p>}
      <div className="flex flex-wrap gap-2">
        {!own && <OpButton op="approve">Aprovar e aplicar</OpButton>}
        <OpButton op="reject" variant="ghost">
          Recusar
        </OpButton>
      </div>
    </ActionForm>
  );
}
