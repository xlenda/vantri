import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/app/components/auth-shell";
import { TotpForm } from "@/app/components/totp-form";
import { accessSession, homeFor } from "@/app/conta/acesso";
import { logoutAction, totpLoginAction } from "../actions";

export const metadata: Metadata = { title: "Verificação em duas etapas — Vantri" };

export default async function Entrar2faPage() {
  const { s } = await accessSession();
  if (!s.user.totpEnabled) redirect("/conta/2fa");
  if (s.session.mfaPassed) redirect(homeFor(s.user.role));
  return (
    <AuthShell
      title="Verificação em duas etapas"
      subtitle="Abra o app autenticador no celular e digite o código de 6 dígitos da Vantri."
    >
      <TotpForm action={totpLoginAction} submitLabel="Verificar e entrar" autoFocus />
      <form action={logoutAction} className="mt-5 text-center">
        <button type="submit" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
          Sair e entrar com outra conta
        </button>
      </form>
    </AuthShell>
  );
}
