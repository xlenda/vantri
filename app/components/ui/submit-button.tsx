"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonVariant } from "./button";

/** Botão de envio que trava enquanto a Server Action do formulário roda. */
export function SubmitButton({
  children,
  pendingText = "Aguarde…",
  variant,
  className,
}: {
  children: ReactNode;
  pendingText?: string;
  variant?: ButtonVariant;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} className={className} disabled={pending}>
      {pending ? pendingText : children}
    </Button>
  );
}
