"use client";

import { motion, useScroll, useSpring } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "./Logo";

const NAV = [
  ["Produto", "/#produto"],
  ["Recursos", "/#recursos"],
  ["Desenvolvedores", "/#dev"],
  ["Preço", "/#precos"],
  ["FAQ", "/#faq"],
];

export function Header() {
  const [open, setOpen] = useState(false);
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 25, mass: 0.4 });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    // O menu do celular fica no fluxo do header (não `fixed`): backdrop-filter prende filhos fixos.
    <header className="sticky top-0 z-50 border-b border-line/80 bg-bg/85 backdrop-blur-xl">
      <motion.div aria-hidden style={{ scaleX }} className="absolute inset-x-0 top-0 h-0.5 origin-left bg-gradient-to-r from-brand via-accent to-brand" />
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="shrink-0 rounded-md" aria-label="Vantri, página inicial">
          <Logo className="h-7 w-auto" />
        </Link>
        <nav aria-label="Principal" className="hidden md:block">
          <ul className="flex items-center gap-7 text-sm font-medium text-muted">
            {NAV.map(([nome, href]) => (
              <li key={href}>
                <a href={href} className="transition-colors hover:text-ink">
                  {nome}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <a href="/entrar" className="btn hidden px-4 hover:bg-white sm:inline-flex">
            Entrar
          </a>
          <a href="/cadastro" className="btn btn-primary h-10 px-4">
            Começar
          </a>
          <button
            type="button"
            className="grid size-10 place-items-center rounded-full border border-line bg-white md:hidden"
            aria-expanded={open}
            aria-controls="menu-celular"
            aria-label={open ? "Fechar menu" : "Abrir menu"}
            onClick={() => setOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" aria-hidden className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
      <nav id="menu-celular" aria-label="Menu" hidden={!open} className="border-t border-line md:hidden">
        <ul className="mx-auto max-w-6xl space-y-1 px-4 py-4 sm:px-6">
          {NAV.map(([nome, href]) => (
            <li key={href}>
              <a href={href} onClick={() => setOpen(false)} className="block rounded-xl px-3 py-3 text-base font-semibold hover:bg-white">
                {nome}
              </a>
            </li>
          ))}
          <li className="pt-2">
            <a href="/entrar" className="btn btn-ghost w-full">
              Entrar
            </a>
          </li>
        </ul>
      </nav>
    </header>
  );
}
