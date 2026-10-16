import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/app/(site)/components/Logo";
import { Card } from "./ui/card";

/** Moldura das telas de acesso (entrar, cadastro, 2FA, senha): logo, cartão central e links legais. */
export function AuthShell({
  title,
  subtitle,
  wide = false,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative min-h-dvh overflow-x-clip">
      <div aria-hidden className="grid-bg pointer-events-none absolute inset-x-0 top-0 h-[26rem]" />
      <main className={`relative mx-auto flex min-h-dvh w-full flex-col px-4 py-8 sm:py-14 ${wide ? "max-w-xl" : "max-w-md"}`}>
        <Link href="/" className="mx-auto mb-8 rounded-md" aria-label="Vantri, página inicial">
          <Logo className="h-8 w-auto" />
        </Link>
        <Card>
          <h1 className="text-2xl sm:text-[1.75rem]">{title}</h1>
          {subtitle && <p className="mt-2 text-sm leading-relaxed text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </Card>
        <p className="mt-auto pt-8 text-center text-xs text-muted">
          <Link href="/termos" className="hover:text-ink">
            Termos de uso
          </Link>
          <span aria-hidden> · </span>
          <Link href="/privacidade" className="hover:text-ink">
            Política de privacidade
          </Link>
        </p>
      </main>
    </div>
  );
}
