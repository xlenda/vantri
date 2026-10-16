"use client";

import { useActionState } from "react";
import { Alert } from "./ui/alert";
import { Input } from "./ui/field";
import { SubmitButton } from "./ui/submit-button";

type State = { error: string } | undefined;

/** Campo do código de 6 dígitos do app autenticador (login com 2FA e ativação do 2FA). */
export function TotpForm({
  action,
  submitLabel,
  autoFocus = false,
}: {
  action: (prev: State, fd: FormData) => Promise<State>;
  submitLabel: string;
  /** Só onde o campo é o primeiro passo; na ativação o QR vem antes (foco rolaria a tela e abriria o teclado). */
  autoFocus?: boolean;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert>{state.error}</Alert>}
      <Input
        label="Código de 6 dígitos"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus={autoFocus}
        className="text-center font-semibold tracking-[0.4em]"
      />
      <SubmitButton className="w-full">{submitLabel}</SubmitButton>
    </form>
  );
}
