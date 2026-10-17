import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SITE_URL } from "@/app/(site)/site";
import { PrintButton } from "@/app/comprovante/print-button";
import { Linha, Recibo } from "@/app/comprovante/recibo";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { CopyButton } from "@/app/components/ui/copy-button";
import { getPayout } from "@/lib/services/payouts";
import { receiptCode } from "@/lib/services/receipt";
import { failureReason, painelSession } from "../../../lib";

export const metadata: Metadata = { title: "Comprovante do saque — Vantri" };

// Impressão: só o comprovante, sem a casca do painel; o valor sai impresso mesmo com "ocultar saldos" ligado.
const PRINT_CSS =
  "@media print{#painel{display:block!important;min-height:0}#painel>aside,#painel main>:not(:has(#comprovante)){display:none!important}" +
  "#painel main{padding:0;max-width:none}#painel[data-ocultar] #comprovante .valor-sensivel{visibility:visible}" +
  "#painel[data-ocultar] #comprovante .valor-sensivel::after{content:none}}";

export default async function ComprovanteSaquePage({ params }: { params: Promise<{ id: string }> }) {
  const { merchant } = await painelSession();
  const { id } = await params;
  const p = await getPayout(merchant.id, id); // de outro lojista (ou id inválido) → null
  if (!p) notFound();

  const voltar = (
    <Link href={`/painel/saques/${p.id}`} className={buttonClass("ghost", "print:hidden")}>
      Voltar ao saque
    </Link>
  );

  // Só saque concluído tem comprovante; nos outros, o porquê.
  if (p.status !== "completed") {
    return (
      <div className="max-w-xl space-y-6">
        <header>
          <p className="eyebrow">Sacar</p>
          <h1 className="mt-1 text-2xl sm:text-3xl">Comprovante do saque</h1>
        </header>
        <Alert tone="info">
          {p.status === "processing"
            ? "O comprovante fica disponível quando o saque for concluído."
            : `Saque não concluído, sem comprovante. Motivo: ${failureReason(p.failureCode)}. O valor e a tarifa voltaram para o seu saldo.`}
        </Alert>
        {voltar}
      </div>
    );
  }

  const code = receiptCode(p.id);
  const url = `${SITE_URL}/comprovante/${code}`;
  return (
    <div className="mx-auto max-w-md space-y-5">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div className="flex flex-wrap gap-2 print:hidden">
        <PrintButton />
        {voltar}
      </div>
      <Recibo r={p}>
        <dl className="mt-6 space-y-3 border-t border-line pt-4 text-sm">
          <Linha rotulo="Código de autenticação">
            <span className="break-all font-mono text-xs">{code}</span>
          </Linha>
          <Linha rotulo="Confira a autenticidade em">
            <span className="break-all text-xs">{url}</span>
          </Linha>
        </dl>
        <p className="mt-4 text-xs text-muted">Dados bancários do favorecido: disponíveis com o parceiro de Pix (plano 2).</p>
      </Recibo>
      <CopyButton text={url} label="Copiar link de verificação" className="print:hidden" />
    </div>
  );
}
