// Fonte única dos valores públicos da vitrine (env com fallback) e do aviso RC 16.
const env = (v: string | undefined) => v?.trim() ?? "";

const siteUrl = env(process.env.NEXT_PUBLIC_SITE_URL);
// Produção sem a URL pública: OpenAPI, sitemap e robots sairiam com localhost. Falha alto no build (o navegador
// não vê VERCEL_ENV, então lá nunca lança).
if (!siteUrl && process.env.VERCEL_ENV === "production") {
  throw new Error("NEXT_PUBLIC_SITE_URL não definida: obrigatória em produção (VERCEL_ENV=production).");
}
export const SITE_URL = (siteUrl || "http://localhost:3000").replace(/\/+$/, "");
export const PSP_NAME = env(process.env.NEXT_PUBLIC_PSP_NAME) || "instituição parceira";
export const LEGAL_NAME = env(process.env.NEXT_PUBLIC_COMPANY_LEGAL_NAME);
export const CNPJ = env(process.env.NEXT_PUBLIC_COMPANY_CNPJ);
// Encarregado (DPO) da LGPD, art. 41: nome e contato públicos. Vazio = a política mostra "Pendente" (definir antes de operar).
export const DPO_NAME = env(process.env.NEXT_PUBLIC_DPO_NAME);
export const DPO_EMAIL = env(process.env.NEXT_PUBLIC_DPO_EMAIL);

export const RC16 = `A Vantri não é instituição financeira nem instituição de pagamento autorizada a funcionar pelo Banco Central do Brasil. As contas e as transações Pix são operadas por ${PSP_NAME}, instituição autorizada pelo Banco Central do Brasil.`;

// Defaults de taxa (Global Constraints): fee_in 149 bps, fee_out fixo 100 centavos.
export const FEE_IN = "1,49%";
export const FEE_OUT = "R$ 1,00";
// Exemplo coerente com computeFee(19700, 149, 0) = 294.
export const EXAMPLE = { sale: "R$ 197,00", fee: "R$ 2,94", net: "R$ 194,06", kept: 98.51 };
