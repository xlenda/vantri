"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AdminRole, Perm } from "@/lib/auth/perms";
import { pode } from "./perms-ui";

type Item = { href: string; label: string; perm?: Perm };
type Group = { title: string; items: Item[] };

// Menu do backoffice (molde Wavex). Cada item esconde quando `pode(role, perm)` é falso —
// mas isso é só cosmético: a própria página/ação re-checa a permissão no servidor (requireAdmin).
// "Visão do suporte" (/admin) não tem perm: é a base que todo papel de admin enxerga.
const GROUPS: Group[] = [
  {
    title: "Atendimento",
    items: [
      { href: "/admin", label: "Visão do suporte" },
      { href: "/admin/clientes", label: "Clientes e sellers", perm: "clientes:ler" },
      { href: "/admin/transacoes", label: "Transações PIX", perm: "transacoes:ler" },
      { href: "/admin/saques", label: "Saques", perm: "saques:operar" },
    ],
  },
  {
    title: "Integrações",
    items: [{ href: "/admin/webhooks", label: "Webhooks", perm: "webhooks:operar" }],
  },
  {
    title: "Compliance",
    items: [
      { href: "/admin/clientes/analise", label: "Análise KYC", perm: "clientes:cadastro" },
      { href: "/admin/med", label: "MED", perm: "med:ler" },
      { href: "/admin/auditoria", label: "Auditoria", perm: "auditoria:ler" },
      { href: "/admin/acessos", label: "Acessos", perm: "acessos:ler" },
    ],
  },
  {
    title: "Equipe",
    items: [
      { href: "/admin/equipe", label: "Equipe e papéis", perm: "equipe:gerir" },
      // Suporte e operador operam usuários (2FA, senha, sessões) sem gerir a equipe: sem este item não achavam a tela.
      { href: "/admin/equipe?aba=usuarios", label: "Usuários", perm: "usuarios:operar" },
      { href: "/admin/aprovacoes", label: "Aprovações", perm: "quatro_olhos:aprovar" },
      { href: "/admin/tarifas", label: "Tarifas", perm: "tarifas:gerir" },
      { href: "/admin/saude", label: "Saúde", perm: "saude:ler" },
    ],
  },
];

// Item ativo = o href mais longo que é prefixo do caminho (/admin só no caminho exato).
function activeHref(path: string, hrefs: string[]): string | null {
  const matches = hrefs.filter((h) => (h === "/admin" ? path === h : path === h || path.startsWith(`${h}/`)));
  return matches.length ? matches.reduce((a, b) => (b.length > a.length ? b : a)) : null;
}

export function AdminNav({ role }: { role: AdminRole | null }) {
  const path = usePathname() ?? "";
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => !it.perm || pode(role, it.perm)),
  })).filter((g) => g.items.length > 0);
  const active = activeHref(
    path,
    groups.flatMap((g) => g.items.map((it) => it.href)),
  );

  return (
    <nav aria-label="Seções do admin" className="text-sm">
      {groups.map((g) => (
        <div key={g.title} className="mb-5 last:mb-0">
          <p className="px-3 text-[11px] font-bold uppercase tracking-wider text-white/40">{g.title}</p>
          <ul className="mt-1.5 space-y-0.5">
            {g.items.map((it) => (
              <li key={it.href}>
                <Link
                  href={it.href}
                  aria-current={active === it.href ? "page" : undefined}
                  className="block rounded-lg px-3 py-2 font-medium text-white/75 transition-colors hover:bg-white/5 hover:text-white aria-[current=page]:bg-brand aria-[current=page]:text-white"
                >
                  {it.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
