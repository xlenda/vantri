"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, type ButtonVariant } from "@/app/components/ui/button";

/** Botão de envio que manda `op` (qual ação) e trava enquanto o formulário roda. */
export function OpButton({
  op,
  variant,
  skipValidation = false,
  children,
}: {
  op: string;
  variant?: ButtonVariant;
  /** Recusar não precisa da caixa de confirmação marcada. */
  skipValidation?: boolean;
  children: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="op"
      value={op}
      formNoValidate={skipValidation}
      disabled={pending}
      className={buttonClass(variant)}
    >
      {children}
    </button>
  );
}
