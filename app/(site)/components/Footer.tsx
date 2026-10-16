import { CNPJ, LEGAL_NAME, RC16 } from "../site";
import { Logo } from "./Logo";

const COLS: [string, [string, string][]][] = [
  [
    "Produto",
    [
      ["Recursos", "/#recursos"],
      ["Preço", "/#precos"],
      ["Perguntas frequentes", "/#faq"],
      ["Documentação", "/docs"],
    ],
  ],
  [
    "Conta",
    [
      ["Entrar", "/entrar"],
      ["Criar conta", "/cadastro"],
    ],
  ],
  [
    "Legal",
    [
      ["Termos de uso", "/termos"],
      ["Política de privacidade", "/privacidade"],
    ],
  ],
];

export function Footer() {
  return (
    <footer className="bg-ink text-white">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo tone="dark" className="h-8 w-auto" />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/70">Cobrança Pix para quem vende cursos, mentorias, e-books, comunidades e SaaS.</p>
          </div>
          {COLS.map(([titulo, links]) => (
            <nav key={titulo} aria-label={titulo}>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-white/70">{titulo}</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                {links.map(([nome, href]) => (
                  <li key={href}>
                    <a href={href} className="text-white/85 hover:text-accent">
                      {nome}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-12 border-t border-white/15 pt-6 text-xs leading-relaxed text-white/70">
          <p className="max-w-3xl">{RC16}</p>
          <p className="mt-4">
            © {new Date().getFullYear()} {LEGAL_NAME || "Vantri"}
            {CNPJ && <> · CNPJ {CNPJ}</>}
          </p>
        </div>
      </div>
    </footer>
  );
}
