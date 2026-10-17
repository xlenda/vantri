"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const ITEMS = [
  ["/painel", "Início"],
  ["/painel/cobrancas", "Cobranças"],
  ["/painel/extrato", "Extrato"],
  ["/painel/saques", "Saques"],
  ["/painel/integracoes", "Integrações"],
  ["/painel/med", "MED"],
] as const;

/** Menu do painel: coluna na lateral; até 768 px vira uma faixa no topo que rola dentro dela mesma. */
export function PainelNav() {
  const path = usePathname();
  const activeRef = useRef<HTMLAnchorElement>(null);
  // Na faixa do celular, o item atual pode estar fora da tela: traz para a vista (sem rolar a página).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); // o Chrome novo devolve Promise: não retornar
  }, [path]);
  return (
    <nav aria-label="Painel" className="-mx-4 scroll-px-4 overflow-x-auto px-4 min-[769px]:mx-0 min-[769px]:overflow-visible min-[769px]:px-0">
      <ul className="flex gap-1 min-[769px]:flex-col">
        {ITEMS.map(([href, label]) => {
          const active = href === "/painel" ? path === href : path.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                ref={active ? activeRef : undefined}
                aria-current={active ? "page" : undefined}
                className={`block whitespace-nowrap rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors ${
                  active ? "bg-ink text-white" : "text-muted hover:bg-white hover:text-ink"
                }`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
