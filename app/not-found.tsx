import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/app/components/ui/button";

export const metadata: Metadata = { title: "Página não encontrada — Vantri" };

/** 404 em PT-BR (o padrão do Next é em inglês). Vale também para id de outro lojista: não diz se existe. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 py-16 text-center">
      <p className="eyebrow">Erro 404</p>
      <h1 className="mt-2 text-2xl sm:text-3xl">Página não encontrada</h1>
      <p className="mt-3 text-sm text-muted">Este endereço não existe ou não está disponível para a sua conta.</p>
      <Link href="/" className={buttonClass("primary", "mt-6")}>
        Voltar ao início
      </Link>
    </main>
  );
}
