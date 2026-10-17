import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/app/(site)/components/Logo";
import { DemoBanner } from "@/app/components/demo-banner";
import { buttonClass } from "@/app/components/ui/button";
import { logoutAction } from "@/app/entrar/actions";
import { requireUser } from "@/lib/auth/guards";
import { isSimulator } from "@/lib/provider";
import { AdminNav } from "./nav";
import { ROLE_LABEL } from "./perms-ui";
import { AdminSearch } from "./search-box";

export const metadata: Metadata = { title: "Admin — Vantri", robots: { index: false, follow: false } };

// O layout não roda de novo em navegação no cliente: cada página, ação e rota chama requireUser/requireAdmin também.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requireUser({ role: "admin" });
  const role = user.adminRole;
  const env = isSimulator() ? "Demonstração" : "Produção";

  // Rodapé com o papel e o Sair; reaproveitado no sidebar (desktop) e no topo (mobile).
  const userFooter = (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{user.email}</p>
        <p className="text-xs text-white/50">{role ? ROLE_LABEL[role] : "Sem papel definido"}</p>
      </div>
      <form action={logoutAction}>
        <button type="submit" className={buttonClass("ghost", "h-9 border-white/15 bg-transparent px-4 text-white hover:border-white/50")}>
          Sair
        </button>
      </form>
    </div>
  );

  return (
    <div className="min-h-dvh bg-[#140f29] text-white md:flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-white/10 bg-[#1b1438] px-4 py-5 md:flex">
        <Link href="/admin" className="mb-6 flex items-center gap-2 rounded-md px-1" aria-label="Início do admin">
          <Logo tone="dark" className="h-7 w-auto" />
          <span className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
            Admin
          </span>
        </Link>
        <div className="flex-1 overflow-y-auto">
          <AdminNav role={role} />
        </div>
        <div className="mt-4 border-t border-white/10 pt-4">{userFooter}</div>
      </aside>

      {/* Coluna de conteúdo */}
      <div className="flex min-w-0 flex-1 flex-col">
        <DemoBanner />

        {/* Topo mobile: marca + menu em acordeão */}
        <header className="border-b border-white/10 bg-[#1b1438] px-4 py-3 md:hidden">
          <div className="flex items-center justify-between gap-3">
            <Link href="/admin" className="flex items-center gap-2 rounded-md" aria-label="Início do admin">
              <Logo tone="dark" className="h-6 w-auto" />
              <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                Admin
              </span>
            </Link>
          </div>
          <div className="mt-3">
            <AdminSearch />
          </div>
          <details className="mt-3 border-t border-white/10 pt-3">
            <summary className="cursor-pointer list-none rounded-lg bg-white/5 px-3 py-2 text-sm font-semibold text-white marker:hidden">
              Menu
            </summary>
            <div className="mt-3">
              <AdminNav role={role} />
            </div>
            <div className="mt-4 border-t border-white/10 pt-4">{userFooter}</div>
          </details>
        </header>

        {/* Barra de busca (desktop) + ambiente */}
        <div className="hidden items-center gap-4 border-b border-white/10 bg-[#1b1438] px-6 py-3 md:flex">
          <div className="min-w-0 flex-1">
            <AdminSearch />
          </div>
          <span className="shrink-0 rounded-full border border-white/15 px-3 py-1 text-xs font-semibold text-white/70">
            Ambiente: {env}
          </span>
        </div>

        {/* Conteúdo claro (as páginas usam os componentes claros de ui/*) */}
        <main className="flex-1 bg-bg px-4 py-6 text-ink sm:px-6 sm:py-10">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
