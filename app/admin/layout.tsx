import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/app/(site)/components/Logo";
import { buttonClass } from "@/app/components/ui/button";
import { logoutAction } from "@/app/entrar/actions";
import { requireUser } from "@/lib/auth/guards";
import { AdminNav } from "./nav";

export const metadata: Metadata = { title: "Admin — Vantri", robots: { index: false, follow: false } };

// O layout não roda de novo em navegação no cliente: cada página, ação e rota chama requireUser também.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requireUser({ role: "admin" });
  return (
    <div className="min-h-dvh overflow-x-clip">
      {process.env.PIX_PROVIDER === "simulator" && (
        <p className="bg-accent px-4 py-1.5 text-center text-xs font-semibold text-ink">
          Ambiente de teste: Pix simulado, sem dinheiro de verdade.
        </p>
      )}
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <Link href="/admin" className="flex items-center gap-2 rounded-md" aria-label="Início do admin">
            <Logo className="h-7 w-auto" />
            <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
              Admin
            </span>
          </Link>
          <div className="order-last w-full sm:order-none sm:w-auto">
            <AdminNav />
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-muted md:inline">{user.email}</span>
            <form action={logoutAction}>
              <button type="submit" className={buttonClass("ghost", "h-9 px-4")}>
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-10">{children}</main>
    </div>
  );
}
