import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/app/components/auth-shell";
import { DEMO_PUBLIC_TEXT, DemoBanner } from "@/app/components/demo-banner";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Criar conta — Vantri" };

export default async function CadastroPage({ searchParams }: { searchParams: Promise<{ enviado?: string | string[] }> }) {
  const { enviado } = await searchParams;

  if (enviado === "1") {
    return (
      <AuthShell title="Cadastro enviado">
        <Alert tone="ok">Recebemos seu cadastro. Você poderá entrar quando aprovarmos.</Alert>
        <Link href="/" className={buttonClass("ghost", "mt-6 w-full")}>
          Voltar para o início
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      wide
      title="Criar conta"
      subtitle="Para quem vende cursos, mentorias, e-books, comunidades, software e serviços digitais. Cada cadastro passa por análise antes de liberar o acesso."
    >
      <DemoBanner text={DEMO_PUBLIC_TEXT} className="mb-5 rounded-xl py-2" />
      <SignupForm />
      <p className="mt-6 text-center text-sm text-muted">
        Já tem conta?{" "}
        <Link href="/entrar" className="font-semibold text-brand hover:underline">
          Entrar
        </Link>
      </p>
    </AuthShell>
  );
}
