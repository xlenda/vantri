// Valores dos campos do admin. Dinheiro em centavos, taxa em pontos-base (149 = 1,49%).
// Leitura de R$ e exibição de valor/data são as de lib/br/money (as mesmas do painel).

export const DAY_MS = 86_400_000;
const BRT_MS = 3 * 3_600_000; // Brasília, UTC−3 sem horário de verão (mesma regra do extrato da API)

/** Início (ms) do dia AAAA-MM-DD em Brasília. */
export const dayStart = (date: string) => Date.parse(`${date}T00:00:00-03:00`);

/** Início (ms) do dia de hoje em Brasília. */
export const todayStart = (now = Date.now()) => Math.floor((now - BRT_MS) / DAY_MS) * DAY_MS + BRT_MS;

/** Hoje em Brasília, AAAA-MM-DD (o início do dia é 03:00 UTC da mesma data). */
export const todayDate = (now = Date.now()) => new Date(todayStart(now)).toISOString().slice(0, 10);

const fixed2 = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/** 149 → "1,49" (valor do campo de %). */
export const percent = (bps: number) => (bps / 100).toLocaleString("pt-BR", fixed2);

/** 123456 → "1234,56" (valor do campo de R$; sem milhar, que o parseReais estrito recusaria em "1.000"). */
export const reais = (cents: number) => (cents / 100).toLocaleString("pt-BR", { ...fixed2, useGrouping: false });

/** Lista branca de campos do formulário, como texto ("" se ausente ou arquivo). */
export function formFields<K extends string>(fd: FormData, keys: readonly K[]): Record<K, string> {
  const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
  return Object.fromEntries(keys.map((k) => [k, text(fd.get(k))])) as Record<K, string>;
}

/** "1,49" / "1.49" / "1,49%" → 149. Até 2 casas, conta em inteiros. Sem faixa: quem chama confere. Inválido → null. */
export function parsePercent(raw: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(raw.trim().replace(/\s*%$/, ""));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
}
