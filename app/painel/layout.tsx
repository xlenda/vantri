import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/app/(site)/components/Logo";
import { DemoBanner } from "@/app/components/demo-banner";
import { logoutAction } from "@/app/entrar/actions";
import { painelSession } from "./lib";
import { PainelNav } from "./nav";

export const metadata: Metadata = { title: "Painel — Vantri", robots: { index: false } };

export default async function PainelLayout({ children }: { children: ReactNode }) {
  const { user, merchant } = await painelSession();
  return (
    <div className="min-h-dvh overflow-x-clip min-[769px]:grid min-[769px]:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-b border-line bg-bg/80 px-4 pb-3 pt-4 min-[769px]:sticky min-[769px]:top-0 min-[769px]:flex min-[769px]:h-dvh min-[769px]:flex-col min-[769px]:border-b-0 min-[769px]:border-r min-[769px]:px-4 min-[769px]:py-6">
        <div className="mb-3 flex items-center justify-between gap-3 min-[769px]:mb-8 min-[769px]:px-2">
          <Link href="/painel" className="rounded-md" aria-label="Vantri, início do painel">
            <Logo className="h-7 w-auto" />
          </Link>
          <LogoutButton className="min-[769px]:hidden" />
        </div>
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
