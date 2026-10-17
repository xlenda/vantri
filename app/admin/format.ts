// Formatação e leitura de valores do admin. Dinheiro em centavos, taxa em pontos-base (149 = 1,49%).

export const DAY_MS = 86_400_000;
const BRT_MS = 3 * 3_600_000; // Brasília, UTC−3 sem horário de verão (mesma regra do extrato da API)

/** Início (ms) do dia AAAA-MM-DD em Brasília. */
export const dayStart = (date: string) => Date.parse(`${date}T00:00:00-03:00`);

/** Início (ms) do dia de hoje em Brasília. */
export const todayStart = (now = Date.now()) => Math.floor((now - BRT_MS) / DAY_MS) * DAY_MS + BRT_MS;

const fixed2 = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/** "R$ 1.234,56". Só exibição. */
export const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** 149 → "1,49" (valor do campo de %). */
export const percent = (bps: number) => (bps / 100).toLocaleString("pt-BR", fixed2);

/** 123456 → "1234,56" (valor do campo de R$). */
export const reais = (cents: number) => (cents / 100).toLocaleString("pt-BR", { ...fixed2, useGrouping: false });

const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});
export const dateTime = (d: Date) => dateTimeFmt.format(d);

/** Lista branca de campos do formulário, como texto ("" se ausente ou arquivo). */
export function formFields<K extends string>(fd: FormData, keys: readonly K[]): Record<K, string> {
  const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
  return Object.fromEntries(keys.map((k) => [k, text(fd.get(k))])) as Record<K, string>;
}

// Conta em inteiros (nunca float): parte inteira × 100 + centavos.
const toHundredths = (int: string, frac = "") => Number(int.replaceAll(".", "")) * 100 + Number(frac.padEnd(2, "0"));

/** "1,49" / "1.49" / "1,49%" → 149. Até 2 casas. Sem faixa: quem chama confere. Inválido → null. */
export function parsePercent(raw: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(raw.trim().replace(/\s*%$/, ""));
  return m ? toHundredths(m[1], m[2]) : null;
}

/**
 * Reais → centavos. Aceita "1.234,56", "1234,56", "1234.56", "12", "R$ 2,00"; até 2 casas.
 * Ponto seguido de 3 dígitos é milhar ("1.000" = mil reais). Inválido → null.
 */
export function parseReais(raw: string): number | null {
  const s = raw.trim().replace(/^R\$\s*/, "");
  const m = /^(\d{1,3}(?:\.\d{3})+|\d{1,9})(?:,(\d{1,2}))?$/.exec(s) ?? /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? toHundredths(m[1], m[2]) : null;
}
