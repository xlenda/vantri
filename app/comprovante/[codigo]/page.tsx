import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/app/(site)/components/Logo";
import { DEMO_PUBLIC_TEXT, DemoBanner } from "@/app/components/demo-banner";
import { Alert } from "@/app/components/ui/alert";
import { Card } from "@/app/components/ui/card";
import { decodeReceiptId, publicReceipt } from "@/lib/services/receipt";
import { PrintButton } from "../print-button";
import { Recibo } from "../recibo";

export const metadata: Metadata = { title: "Verificar comprovante — Vantri", robots: { index: false, follow: false } };

/**
 * Verificação pública, sem login: só o código (id embutido + HMAC), nunca o id sozinho. Código que não confere,
 * saque inexistente ou não concluído dão a mesma resposta. Mostra só valor, status, E2E e data.
 */
export default async function ComprovantePublicoPage({ params }: { params: Promise<{ codigo: string }> }) {
  const { codigo } = await params;
  const id = decodeReceiptId(codigo);
  const r = id ? await publicReceipt(codigo, id) : null;

  return (
    <div className="min-h-dvh overflow-x-clip">
      <DemoBanner text={DEMO_PUBLIC_TEXT} />
      <main className="mx-auto w-full max-w-md px-4 py-8 sm:py-12">
        {r ? (
          <div className="space-y-5">
            <Alert tone="ok" className="print:hidden">
              Comprovante autêntico: o código confere com um Pix concluído na Vantri.
            </Alert>
            <Recibo r={r} />
            <PrintButton />
          </div>
        ) : (
          <Card>
            <Link href="/" className="inline-block rounded-md" aria-label="Vantri, página inicial">
              <Logo className="h-7 w-auto" />
            </Link>
            <h1 className="mt-6 text-2xl">Comprovante não encontrado</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              O código não confere com nenhum Pix concluído. Confira se o endereço foi copiado inteiro, do jeito que está
              no comprovante.
            </p>
          </Card>
        )}
      </main>
    </div>
  );
}
