import type { ReactNode } from "react";
import { Logo } from "@/app/(site)/components/Logo";
import { RC16 } from "@/app/(site)/site";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { brl, dateTime } from "@/lib/br/money";
import { isSimulator } from "@/lib/provider";
import type { PublicReceipt } from "@/lib/services/receipt";

/**
 * Comprovante de Pix enviado: o mesmo cartão no painel (para imprimir) e na verificação pública. Só os campos do
 * `PublicReceipt` (valor, status, E2E, data): nenhum dado pessoal do favorecido. `valor-sensivel` só tem efeito
 * dentro do #painel (ocultar saldos); fora dele não muda nada.
 */
export function Recibo({ r, children }: { r: PublicReceipt; children?: ReactNode }) {
  return (
    <article
      id="comprovante"
      className="rounded-3xl border border-line bg-white p-6 sm:p-8 print:rounded-none print:border-0 print:p-0"
    >
      <div className="flex items-center justify-between gap-3">
        <Logo className="h-7 w-auto" />
        <StatusBadge kind="payout" status={r.status} />
      </div>
      <h1 className="mt-6 text-lg">Comprovante de Pix enviado</h1>
      <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">
        <span className="valor-sensivel">{brl(r.amountCents)}</span>
      </p>
      {isSimulator() && (
        <p className="mt-4 rounded-xl border border-line px-3 py-2 text-xs font-semibold">
          Comprovante de demonstração: Pix simulado, nenhum dinheiro foi movimentado.
        </p>
      )}
      <dl className="mt-6 space-y-3 text-sm">
        <Linha rotulo="Data e hora">{r.completedAt ? `${dateTime(r.completedAt)} (horário de Brasília)` : "—"}</Linha>
        <Linha rotulo="Tipo">Pix enviado</Linha>
        <Linha rotulo="Identificador da transação (E2E)">
          <span className="break-all font-mono text-xs">{r.endToEndId ?? "—"}</span>
        </Linha>
      </dl>
      {children}
      <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-muted">{RC16}</p>
    </article>
  );
}

export function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{rotulo}</dt>
      <dd className="break-words font-medium text-ink">{children}</dd>
    </div>
  );
}
