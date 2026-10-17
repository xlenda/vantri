// Dinheiro em centavos inteiros e datas no horário de Brasília: leitura do que a pessoa digita e exibição.
// Uma regra só para painel e admin.

const MAX_REAIS_DIGITS = 9; // até R$ 999.999.999,99; os limites de verdade são dos serviços

/**
 * Valor em reais digitado em pt-BR → centavos inteiros. Aceita "1.234,56", "1234,56", "1234.56", "R$ 10".
 * Ambíguo ou inválido → null: "1.234" (milhar ou decimal?), "1,234", vírgula sem centavos, sinal, espaço no meio.
 */
export function parseReais(input: string): number | null {
  const s = input.trim().replace(/^R\$\s*/i, "");
  const m =
    /^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/.exec(s) ?? // milhar com ponto exige centavos com vírgula
    /^(\d+)(?:,(\d{1,2}))?$/.exec(s) ??
    /^(\d+)\.(\d{1,2})$/.exec(s);
  if (!m) return null;
  const reais = m[1].replaceAll(".", "");
  if (reais.length > MAX_REAIS_DIGITS) return null;
  return Number(reais) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

const brlFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
/** Só exibição: centavos inteiros → "R$ 1.234,56". */
export const brl = (cents: number) => brlFmt.format(cents / 100);

const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  dateStyle: "short",
  timeStyle: "short",
});
/** "16/10/2026, 21:07" no horário de Brasília. */
export const dateTime = (d: Date) => dateTimeFmt.format(d);
