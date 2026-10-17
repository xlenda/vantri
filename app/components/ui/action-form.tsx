"use client";

import { type ReactNode, useActionState } from "react";
import { Alert } from "./alert";

export type FormState = { error: string } | { ok: string } | undefined;

/**
 * Formulário de uma Server Action que responde `{ error }` ou `{ ok }`: mostra a resposta em cima dos campos.
 * Os campos vêm como children (podem ser renderizados no servidor).
 */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className}>
      {state && (
        <Alert tone={"error" in state ? "error" : "ok"} className="mb-4">
          {"error" in state ? state.error : state.ok}
        </Alert>
      )}
      {children}
    </form>
  );
}
