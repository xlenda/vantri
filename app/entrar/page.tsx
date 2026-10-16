import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/app/components/auth-shell";
import { Alert } from "@/app/components/ui/alert";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar — Vantri" };

export default async function EntrarPage({ searchParams }: { searchParams: Promise<{ motivo?: string | string[] }> }) {
  const { motivo } = await searchParams;
  return (
    <AuthShell title="Entrar" subtitle="Acesse o painel da sua conta Vantri.">
      {motivo === "suspenso" && (
        <Alert tone="info" className="mb-5">
          Sua sessão foi encerrada porque a conta não está ativa no momento.
        </Alert>
      )}
      <LoginForm />
      <p className="mt-6 text-center text-sm text-muted">
        Ainda não tem conta?{" "}
        <Link href="/cadastro" className="font-semibold text-brand hover:underline">
          Criar conta
        </Link>
      </p>
    </AuthShell>
  );
}
