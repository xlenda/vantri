"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";

/** Texto só de leitura com botão Copiar (copia-e-cola do Pix, chave de API, segredo do webhook). */
export function CopyField({ label, value, id, rows = 3 }: { label: string; value: string; id: string; rows?: number }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      (document.getElementById(id) as HTMLTextAreaElement | null)?.select(); // sem permissão: seleciona para Ctrl+C
    }
  }
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      <textarea
        id={id}
        readOnly
        rows={rows}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="block w-full resize-none break-all rounded-xl border border-line bg-bg px-3.5 py-2.5 font-mono text-xs text-ink focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15"
      />
      <Button variant="ghost" className="mt-2" onClick={copy}>
        {copied ? "Copiado" : "Copiar"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copiado para a área de transferência" : ""}
      </span>
    </div>
  );
}
