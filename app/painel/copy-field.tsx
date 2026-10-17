"use client";

import { CopyButton } from "@/app/components/ui/copy-button";

/** Texto só de leitura com botão Copiar (copia-e-cola do Pix, chave de API, segredo do webhook). */
export function CopyField({ label, value, id, rows = 3 }: { label: string; value: string; id: string; rows?: number }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      {/* Sem permissão de área de transferência o botão avisa; focar no campo seleciona tudo para Ctrl+C. */}
      <textarea
        id={id}
        readOnly
        rows={rows}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="block w-full resize-none break-all rounded-xl border border-line bg-bg px-3.5 py-2.5 font-mono text-xs text-ink focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15"
      />
      <CopyButton text={value} className="mt-2" />
    </div>
  );
}
