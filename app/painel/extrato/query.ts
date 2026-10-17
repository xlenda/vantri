import { z } from "zod";
import { parseReais } from "@/lib/br/money";
import { ledgerEntries } from "@/lib/db/schema";
import { uuidOrUndefined } from "../lib";

// Filtros do extrato na URL, os mesmos para a tela e para os arquivos (CSV/XLSX): from/to (AAAA-MM-DD, dia de
// Brasília, `to` inclusivo), kind (repetido), direction (in|out), min/max (reais), visao=fecho, cursor.

export type LedgerKind = (typeof ledgerEntries.kind.enumValues)[number];
const KINDS: readonly string[] = ledgerEntries.kind.enumValues;

/** Acima disso o arquivo é recusado (nunca cortado calado). */
export const MAX_ROWS = 50_000;

export type Extrato = {
  from: string;
  to: string;
  kind?: LedgerKind[];
  direction?: "in" | "out";
  minCents?: number;
  maxCents?: number;
  fecho: boolean;
  cursor?: string;
};

const DAY_MS = 86_400_000;
const isDay = (s: string) => z.iso.date().safeParse(s).success;
// Aritmética de calendário em UTC: só conta dias, sem fuso.
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number) => new Date(ms(day) + n * DAY_MS).toISOString().slice(0, 10);
const firstOfMonth = (day: string) => `${day.slice(0, 8)}01`;

/** "2026-03-01" → "01/03/2026" (dia civil, sem fuso). */
export const diaBr = (day: string) => day.split("-").reverse().join("/");

/** Atalhos de período a partir de hoje (dia de Brasília). */
export const periodShortcuts = (today: string) => [
  { label: "Hoje", from: today, to: today },
  { label: "7 dias", from: addDays(today, -6), to: today },
  { label: "Este mês", from: firstOfMonth(today), to: today },
];

const reaisParam = (p: URLSearchParams, k: string) => {
  const s = p.get(k)?.trim();
  return s ? parseReais(s) : undefined; // null = digitado e inválido
};

/**
 * Lê e valida os filtros com as mesmas regras dos serviços (período de até 366 dias, tipos do razão, faixa de
 * valor), para os serviços nunca recusarem o que passou daqui. Sem datas: este mês. Só `to`: o mês de `to` até ele.
 */
export function parseExtrato(p: URLSearchParams, today: string): { ok: true; value: Extrato } | { ok: false; error: string } {
  const to = p.get("to") || today;
  const from = p.get("from") || firstOfMonth(to);
  if (!isDay(from) || !isDay(to) || from > to || (ms(to) - ms(from)) / DAY_MS + 1 > 366) {
    return {
      ok: false,
      error: "Período inválido. A data inicial precisa ser anterior ou igual à final, e o período pode ter no máximo 366 dias.",
    };
  }
  const kind = [...new Set(p.getAll("kind"))];
  const direction = p.get("direction") || undefined;
  if (kind.some((k) => !KINDS.includes(k)) || (direction !== undefined && direction !== "in" && direction !== "out")) {
    return { ok: false, error: "Filtro inválido. Limpe os filtros e escolha de novo." };
  }
  const minCents = reaisParam(p, "min");
  const maxCents = reaisParam(p, "max");
  if (minCents === null) return { ok: false, error: "Valor mínimo inválido. Digite em reais, por exemplo 10,00 ou 1.234,56." };
  if (maxCents === null) return { ok: false, error: "Valor máximo inválido. Digite em reais, por exemplo 10,00 ou 1.234,56." };
  if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
    return { ok: false, error: "Faixa de valor inválida: o valor mínimo precisa ser menor ou igual ao máximo." };
  }
  return {
    ok: true,
    value: {
      from,
      to,
      kind: kind.length ? (kind as LedgerKind[]) : undefined,
      direction,
      minCents,
      maxCents,
      fecho: p.get("visao") === "fecho",
      cursor: uuidOrUndefined(p.get("cursor") ?? undefined),
    },
  };
}

/** searchParams do Next → URLSearchParams (valores repetidos viram parâmetros repetidos). */
export function toParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of [v ?? []].flat()) p.append(k, x);
  return p;
}

/** `path` com os parâmetros atuais trocados por `set` (undefined apaga). Cursor e aviso de erro nunca seguem. */
export function extratoHref(path: string, p: URLSearchParams, set: Record<string, string | undefined> = {}): string {
  const n = new URLSearchParams(p);
  n.delete("cursor");
  n.delete("erro");
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) n.delete(k);
    else n.set(k, v);
  }
  const s = n.toString();
  return s ? `${path}?${s}` : path;
}
