import { isSimulator } from "@/lib/provider";

export const DEMO_PUBLIC_TEXT = "Ambiente de demonstração: o Pix é simulado e ainda não movimenta dinheiro.";

/** Aviso de ambiente enquanto PIX_PROVIDER=simulator (admin, painel, vitrine e cadastro); fora dele, nada. */
export function DemoBanner({
  text = "Ambiente de demonstração: Pix simulado, sem dinheiro de verdade.",
  className = "",
}: {
  text?: string;
  className?: string;
}) {
  if (!isSimulator()) return null;
  return <p className={`bg-accent px-4 py-1.5 text-center text-xs font-semibold text-ink ${className}`}>{text}</p>;
}
