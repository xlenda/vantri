"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/admin", "Início"],
  ["/admin/clientes", "Clientes"],
  ["/admin/transacoes", "Transações"],
  ["/admin/med", "MED"],
] as const;

export function AdminNav() {
  const path = usePathname();
  return (
    <nav aria-label="Admin" className="-mx-1 flex gap-1 overflow-x-auto">
      {LINKS.map(([href, label]) => {
        const current = href === "/admin" ? path === href : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:text-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
