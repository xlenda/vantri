"use client";

import { useState } from "react";
import { Button, type ButtonVariant } from "./button";

/** Copia `text` para a área de transferência e confirma no próprio botão (e para o leitor de tela). */
export function CopyButton({
  text,
  label = "Copiar",
  variant = "ghost",
  className,
}: {
  text: string;
  label?: string;
  variant?: ButtonVariant;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("ok");
    } catch {
      setState("fail"); // sem permissão ou fora de HTTPS: o texto continua na tela para copiar à mão
    }
    setTimeout(() => setState("idle"), 2500);
  }
  return (
    <Button variant={variant} className={className} onClick={copy}>
      <span aria-live="polite">{state === "ok" ? "Copiado" : state === "fail" ? "Não deu, copie à mão" : label}</span>
    </Button>
  );
}
