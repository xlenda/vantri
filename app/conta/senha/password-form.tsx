"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { changePasswordAction } from "../actions";

export function PasswordForm({ home }: { home: string }) {
  const [state, action] = useActionState(changePasswordAction, undefined);

  if (state && "done" in state) {
    return (
      <div className="space-y-5">
        <Alert tone="ok">Senha alterada. As outras sessões abertas foram encerradas.</Alert>
        <Link href={home} className={buttonClass("primary", "w-full")}>
          Continuar
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {state && <Alert>{state.error}</Alert>}
      <Input label="Senha atual" name="current" type="password" autoComplete="current-password" required maxLength={256} />
      <Input
        label="Senha nova"
        name="next"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        maxLength={256}
        hint="Mínimo de 12 caracteres. Uma frase longa é mais forte e mais fácil de lembrar."
      />
      <Input label="Confirme a senha nova" name="confirm" type="password" autoComplete="new-password" required maxLength={256} />
      <SubmitButton className="w-full" pendingText="Salvando…">
        Trocar senha
      </SubmitButton>
    </form>
  );
}
