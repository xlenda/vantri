"use client";

import { useActionState } from "react";
import { Turnstile } from "@/app/components/turnstile";
import { Alert } from "@/app/components/ui/alert";
import { Input } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { loginAction } from "./actions";

export function LoginForm() {
  const [state, action] = useActionState(loginAction, undefined);
  return (
    <form action={action} className="space-y-4">
      {state && <Alert>{state.error}</Alert>}
      <Input
        label="E-mail"
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        defaultValue={state?.email}
      />
      <Input label="Senha" name="password" type="password" autoComplete="current-password" required maxLength={256} />
      <Turnstile resetKey={state} />
      <SubmitButton className="w-full" pendingText="Entrando…">
        Entrar
      </SubmitButton>
    </form>
  );
}
