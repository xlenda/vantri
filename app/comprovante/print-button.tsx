"use client";

import { Button } from "@/app/components/ui/button";

/** Abre a impressão do navegador ("Salvar como PDF"): o PDF sai do HTML, sem dependência nova. */
export function PrintButton() {
  return (
    <Button variant="primary" className="print:hidden" onClick={() => window.print()}>
      Imprimir ou salvar PDF
    </Button>
  );
}
