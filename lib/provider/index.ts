import { simulator } from "./simulator";
import type { PixProvider } from "./types";

export function getProvider(): PixProvider {
  const name = process.env.PIX_PROVIDER;
  if (name === "simulator") return simulator;
  throw new Error(`provedor ${name || "(vazio)"} não configurado`);
}
