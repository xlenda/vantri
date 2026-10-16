import type { ReactNode } from "react";

const TONES = {
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-brand/20 bg-brand/5 text-ink",
  ok: "border-ok/30 bg-ok/10 text-ink",
} as const;

/** Aviso em bloco. Erro é anunciado na hora pelo leitor de tela (role=alert). */
export function Alert({
  tone = "error",
  className = "",
  children,
}: {
  tone?: keyof typeof TONES;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-2xl border px-4 py-3 text-sm leading-relaxed ${TONES[tone]} ${className}`}
    >
      {children}
    </div>
  );
}
