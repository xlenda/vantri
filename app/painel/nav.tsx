"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const ITEMS = [
  ["/painel", "Início"],
  ["/painel/cobrancas", "Cobranças"],
  ["/painel/extrato", "Extrato"],
  ["/painel/saques", "Saques"],
  ["/painel/integracoes", "Integrações"],
  ["/painel/med", "MED"],
  ["/painel/conta", "Conta"],
] as const;

// Ocultar saldos: atributo data-ocultar em #painel (raiz do layout) + CSS; todo valor em dinheiro leva a classe
// valor-sensivel. Preferência no localStorage ("1" = oculto). Na raiz do layout e não no <html>: o script abaixo
// marca antes da hidratação, e só no elemento do layout dá para suprimir o aviso de atributo a mais.
const OCULTAR_KEY = "vantri-ocultar-saldos";
const OCULTAR_CSS =
  "#painel[data-ocultar] .valor-sensivel{position:relative;visibility:hidden}" +
  '#painel[data-ocultar] .valor-sensivel::after{content:"••••••";content:"••••••"/"valor oculto";position:absolute;' +
  "inset:0;display:grid;align-content:center;padding:inherit;overflow:hidden;white-space:nowrap;visibility:visible}";
const OCULTAR_SCRIPT = `try{if(localStorage.getItem("${OCULTAR_KEY}")==="1")document.getElementById("painel").setAttribute("data-ocultar","")}catch(e){}`;
const raiz = () => document.getElementById("painel");

/** CSS + script do "ocultar saldos": primeiro filho de #painel, para o saldo não aparecer até a hidratação. */
export function OcultarSaldosInit() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: OCULTAR_CSS }} />
      <script dangerouslySetInnerHTML={{ __html: OCULTAR_SCRIPT }} />
    </>
  );
}

/** Olho do card de saldo: liga/desliga data-ocultar em #painel e grava a escolha. */
export function BalanceToggle() {
  const [oculto, setOculto] = useState(false);
  // Navegação pelo cliente não roda o script do HTML: aplica a preferência aqui, antes da pintura.
  useLayoutEffect(() => {
    let salvo = false;
    try {
      salvo = localStorage.getItem(OCULTAR_KEY) === "1";
    } catch {
      // aba privada/armazenamento bloqueado: começa visível
    }
    raiz()?.toggleAttribute("data-ocultar", salvo);
    setOculto(salvo);
  }, []);
  function toggle() {
    const v = !oculto;
    raiz()?.toggleAttribute("data-ocultar", v);
    setOculto(v);
    try {
      localStorage.setItem(OCULTAR_KEY, v ? "1" : "0");
    } catch {
      // sem localStorage a escolha vale só até recarregar
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={oculto}
      aria-label="Ocultar saldos"
      className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-ink"
    >
      <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
        {oculto && <path d="m3 3 18 18" />}
      </svg>
    </button>
  );
}

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
