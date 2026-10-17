import { simulator } from "./simulator";
import type { PixProvider } from "./types";

export const isSimulator = () => process.env.PIX_PROVIDER === "simulator";

export function getProvider(): PixProvider {
  const name = process.env.PIX_PROVIDER;
  if (name === "simulator") return simulator;
  throw new Error(`provedor ${name || "(vazio)"} não configurado`);
}

/**
 * Conta aberta no simulador (`sim_…`) com o parceiro real ligado: o saldo dela nasceu do "Simular pagamento" e
 * nunca pode virar dinheiro de verdade. Cobrança e saque recusam até a conta ser aberta no parceiro.
 */
export const simulatedAccountOutsideSimulator = (providerAccountId: string) =>
  providerAccountId.startsWith("sim_") && !isSimulator();

export const SIMULATED_ACCOUNT_MESSAGE =
  "Esta conta é do ambiente de demonstração (Pix simulado) e não movimenta dinheiro de verdade. Fale com o suporte para abrir a conta na instituição parceira.";
