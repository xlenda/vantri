import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/app/(site)/components/Logo";
import { DemoBanner } from "@/app/components/demo-banner";
import { buttonClass } from "@/app/components/ui/button";
import { logoutAction } from "@/app/entrar/actions";
import { brl } from "@/lib/br/money";
import { getBalance } from "@/lib/money/ledger";
import { painelSession } from "./lib";
import { BalanceToggle, OcultarSaldosInit, PainelNav } from "./nav";

export const metadata: Metadata = { title: "Painel — Vantri", robots: { index: false } };

export default async function PainelLayout({ children }: { children: ReactNode }) {
  const { user, merchant } = await painelSession();
  const { available } = await getBalance(merchant.id);
  return (
    // suppressHydrationWarning: o script do OcultarSaldosInit põe data-ocultar aqui antes da hidratação.
    <div
      id="painel"
      suppressHydrationWarning
      className="min-h-dvh overflow-x-clip min-[769px]:grid min-[769px]:grid-cols-[15rem_minmax(0,1fr)]"
    >
      <OcultarSaldosInit />
      <aside className="border-b border-line bg-bg/80 px-4 pb-3 pt-4 min-[769px]:sticky min-[769px]:top-0 min-[769px]:flex min-[769px]:h-dvh min-[769px]:flex-col min-[769px]:overflow-y-auto min-[769px]:border-b-0 min-[769px]:border-r min-[769px]:px-4 min-[769px]:py-6">
        <div className="mb-3 flex items-center justify-between gap-3 min-[769px]:mb-8 min-[769px]:px-2">
          <Link href="/painel" className="rounded-md" aria-label="Vantri, início do painel">
            <Logo className="h-7 w-auto" />
          </Link>
          <LogoutButton className="min-[769px]:hidden" />
        </div>
        {/* No celular vira uma linha (valor à esquerda, botões à direita); na lateral, cartão empilhado. */}
        <section
          aria-label="Saldo"
          className="mb-3 flex items-center gap-3 rounded-2xl border border-line bg-white p-3 min-[769px]:mb-6 min-[769px]:block min-[769px]:p-4"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <p className="text-xs font-semibold text-muted">Disponível</p>
              <BalanceToggle />
            </div>
            <p className="valor-sensivel break-words font-bold tabular-nums text-ink min-[769px]:text-lg">{brl(available)}</p>
          </div>
          <div className="flex shrink-0 gap-2 min-[769px]:mt-3 min-[769px]:grid min-[769px]:grid-cols-2">
            <Link href="/painel/cobrancas" className={buttonClass("primary", "px-3")}>
              Cobrar
            </Link>
            <Link href="/painel/saques/novo" className={buttonClass("ghost", "px-3")}>
              Sacar
            </Link>
          </div>
        </section>
        <PainelNav />
        <div className="mt-auto hidden px-2 min-[769px]:block">
          <p className="truncate text-sm font-semibold text-ink">{merchant.tradeName}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
          <LogoutButton className="mt-3" />
        </div>
      </aside>
      <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-6 sm:px-8 sm:py-10">
        {/* Dentro do conteúdo, não acima da grade: a barra lateral fixa ocupa a altura toda da tela. */}
        <DemoBanner className="mb-6 rounded-xl py-2" />
        {children}
      </main>
    </div>
  );
}

function LogoutButton({ className = "" }: { className?: string }) {
  return (
    <form action={logoutAction} className={className}>
      <button type="submit" className="rounded-lg text-sm font-semibold text-muted underline-offset-4 hover:text-ink hover:underline">
        Sair
      </button>
    </form>
  );
}
