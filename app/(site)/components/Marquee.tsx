import type { ReactNode } from "react";

// Faixa infinita só em CSS: a lista vai repetida em duas metades iguais e a pista anda -50%.
// Só a primeira cópia é lida por leitor de tela. Com movimento reduzido a pista para,
// as cópias somem e os itens quebram linha.
export function Marquee({ items, label, repeat = 2 }: { items: ReactNode[]; label: string; repeat?: number }) {
  const all = Array.from({ length: repeat * 2 }, () => items).flat();
  return (
    <div className="mx-auto max-w-6xl overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_12%,#000_88%,transparent)] motion-reduce:[mask-image:none]">
      <ul
        aria-label={label}
        className="flex w-max animate-marquee hover:[animation-play-state:paused] motion-reduce:w-auto motion-reduce:animate-none motion-reduce:flex-wrap motion-reduce:justify-center motion-reduce:gap-y-3 motion-reduce:px-4"
      >
        {all.map((it, i) => {
          const copy = i >= items.length;
          return (
            <li key={i} aria-hidden={copy || undefined} className={`shrink-0 pr-4 ${copy ? "motion-reduce:hidden" : ""}`}>
              {it}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
