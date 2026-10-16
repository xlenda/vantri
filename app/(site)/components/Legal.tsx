import type { ReactNode } from "react";
import { CNPJ, LEGAL_NAME } from "../site";

// Quem opera a Vantri, com o que existir nas env (sem inventar CNPJ).
export const EMPRESA = `${LEGAL_NAME || "a empresa responsável pela Vantri"}${CNPJ ? `, inscrita no CNPJ sob o nº ${CNPJ}` : ""}`;

export function Legal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="legal mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
      <p role="note" className="rounded-2xl border border-ink/10 bg-accent px-4 py-3 text-sm font-semibold text-ink">
        Modelo inicial — revisar com advogado antes de operar.
      </p>
      <h1 className="mt-8 text-4xl sm:text-5xl">{title}</h1>
      <p className="text-sm text-muted">Última atualização: 16 de outubro de 2026</p>
      {children}
    </article>
  );
}
