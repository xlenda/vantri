import { z } from "zod";
import { onlyDigits } from "./documents";

export type CnpjLookup = { ok: true; legalName: string; cnaes: string[]; active: boolean } | { ok: false };

// Só os campos usados; o resto da resposta da BrasilAPI é ignorado.
const cnae = z.int().nonnegative().transform((n) => String(n).padStart(7, "0"));
const body = z.object({
  razao_social: z.string(),
  cnae_fiscal: cnae,
  cnaes_secundarios: z.array(z.object({ codigo: cnae })).default([]),
  descricao_situacao_cadastral: z.string(),
});

/** Qualquer falha (rede, timeout, não-200, corpo inesperado) vira `{ ok: false }`: o cadastro segue para revisão manual. */
export async function lookupCnpj(cnpj: string, fetcher: typeof fetch = fetch): Promise<CnpjLookup> {
  try {
    const res = await fetcher(`https://brasilapi.com.br/api/cnpj/v1/${onlyDigits(cnpj)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) return { ok: false };
    const r = body.safeParse(await res.json());
    if (!r.success) return { ok: false };
    return {
      ok: true,
      legalName: r.data.razao_social,
      cnaes: [r.data.cnae_fiscal, ...r.data.cnaes_secundarios.map((c) => c.codigo)],
      active: r.data.descricao_situacao_cadastral === "ATIVA",
    };
  } catch {
    return { ok: false };
  }
}
