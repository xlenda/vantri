import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/app/components/auth-shell";
import { accessSession, homeFor } from "../acesso";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Trocar senha — Vantri" };

export default async function SenhaPage() {
  const { s } = await accessSession();
  if (!s.session.mfaPassed) redirect("/entrar/2fa");
  return (
    <AuthShell
      title="Trocar senha"
      subtitle={
        s.user.mustChangePassword
          ? "Sua senha atual é temporária. Crie uma senha sua para continuar."
          : "Ao trocar, as outras sessões abertas da sua conta são encerradas."
      }
    >
      <PasswordForm home={homeFor(s.user.role)} />
    </AuthShell>
  );
}
