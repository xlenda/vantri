"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

export type Aba = { id: string; label: string; content: ReactNode };

/**
 * Abas do detalhe da transação (padrão WAI-ARIA: setas, Home e End trocam de aba). O conteúdo de cada aba vem pronto
 * do servidor; aqui é só a troca. Ao abrir, o foco vai para o título do painel (`tituloId`): no celular o painel fica
 * acima da lista e o foco o traz à vista; no leitor de tela, anuncia o que abriu.
 */
export function DetailTabs({ abas, tituloId }: { abas: Aba[]; tituloId: string }) {
  const [atual, setAtual] = useState(0);
  const base = useId();
  const botoes = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    document.getElementById(tituloId)?.focus();
  }, [tituloId]);

  function onKeyDown(e: KeyboardEvent) {
    const n = abas.length;
    const alvos: Record<string, number> = { ArrowRight: (atual + 1) % n, ArrowLeft: (atual - 1 + n) % n, Home: 0, End: n - 1 };
    const alvo = alvos[e.key];
    if (alvo === undefined) return;
    e.preventDefault();
    setAtual(alvo);
    botoes.current[alvo]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Detalhe da transação"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        {abas.map((a, i) => (
          <button
            key={a.id}
            ref={(el) => {
              botoes.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-aba-${a.id}`}
            aria-selected={i === atual}
            aria-controls={`${base}-painel-${a.id}`}
            tabIndex={i === atual ? 0 : -1}
            onClick={() => setAtual(i)}
            className="shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-semibold text-muted transition-colors hover:text-ink aria-selected:border-ink aria-selected:text-ink"
          >
            {a.label}
          </button>
        ))}
      </div>
      {abas.map((a, i) => (
        <div
          key={a.id}
          role="tabpanel"
          id={`${base}-painel-${a.id}`}
          aria-labelledby={`${base}-aba-${a.id}`}
          tabIndex={0}
          hidden={i !== atual}
          className="pt-5"
        >
          {a.content}
        </div>
      ))}
    </div>
  );
}
