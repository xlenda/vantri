import { redirect } from "next/navigation";
import { ApiError } from "@/lib/api/http";
import { buildXlsx, XLSX_MIME } from "@/lib/export/xlsx";
import { dailyClosing, listStatementWithBalance } from "@/lib/services/statement-extra";
import { csvCell, diaBrasilia, LEDGER_BUCKET, LEDGER_KIND, LEDGER_REF } from "../lib";
import { diaBr, type Extrato, extratoHref, MAX_ROWS, parseExtrato } from "./query";

/** Célula do arquivo: texto, ou centavos (inteiro) que cada formato escreve como dinheiro. */
type Cell = string | number;
export type Sheet = { name: string; title: string; header: string[]; rows: Cell[][] };

const stamp = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium" });

/** Centavos com sinal → "-1234,56", número que a planilha em pt-BR soma. Só sinal, dígitos e vírgula: não é fórmula. */
export function reais(cents: number): string {
  const a = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(a / 100)},${String(a % 100).padStart(2, "0")}`;
}

const STATEMENT = [
  "Data",
  "Lançamento",
  "Saldo afetado",
  "Referência",
  "ID da referência",
  "Entrada (R$)",
  "Saída (R$)",
  "Saldo após (R$)",
  "ID do lançamento",
];
const CLOSING = ["Data", "Abertura (R$)", "Entradas (R$)", "Saídas (R$)", "Tarifas (R$)", "MED (R$)", "Fechamento (R$)"];

/** Linhas do arquivo: o extrato com os filtros da tela, ou o fechamento diário. null = passou de `max` lançamentos. */
export async function exportSheet(merchantId: string, e: Extrato, max = MAX_ROWS): Promise<Sheet | null> {
  const period = `${e.from}-a-${e.to}`;
  if (e.fecho) {
    const days = await dailyClosing(merchantId, e.from, e.to);
    return {
      name: `fechamento-diario-vantri-${period}`,
      title: "Fechamento diário",
      header: CLOSING,
      rows: days.map((d) => [diaBr(d.day), d.openingCents, d.inflowCents, d.outflowCents, d.feeCents, d.medCents, d.closingCents]),
    };
  }
  // Uma leitura só (o serviço relê o histórico do lojista a cada chamada): max + 1 linhas dizem se passou do teto.
  // ponytail: arquivo inteiro em memória (até MAX_ROWS); streaming se precisar de mais.
  const { from, to, kind, direction, minCents, maxCents } = e;
  const { data } = await listStatementWithBalance(merchantId, { from, to, kind, direction, minCents, maxCents, limit: max + 1 });
  if (data.length > max) return null;
  const rows: Cell[][] = data.map((r) => [
    stamp.format(r.createdAt),
    LEDGER_KIND[r.kind],
    LEDGER_BUCKET[r.bucket],
    LEDGER_REF[r.refType],
    r.refId,
    r.amountCents > 0 ? r.amountCents : "",
    r.amountCents < 0 ? -r.amountCents : "",
    r.balanceAfter ?? "", // com filtro de tipo/movimento o saldo corrido não existe: célula vazia, nunca um número errado
    r.id,
  ]);
  return { name: `extrato-vantri-${period}`, title: "Extrato", header: STATEMENT, rows };
}

/** CSV com BOM (o Excel só lê UTF-8 com ele) e ";": texto passa pelo csvCell; dinheiro vai como número pt-BR. */
export const toCsv = (s: Sheet) =>
  "﻿" +
  [s.header.map(csvCell), ...s.rows.map((r) => r.map((v) => (typeof v === "number" ? reais(v) : csvCell(v))))]
    .map((r) => r.join(";"))
    .join("\r\n") +
  "\r\n";

// Reais como número (o Excel soma). c / 100 é exato no arquivo: String(c / 100) dá as duas casas certas.
const toXlsx = (s: Sheet) => buildXlsx(s.title, s.header, s.rows.map((r) => r.map((v) => (typeof v === "number" ? v / 100 : v))));

/**
 * GET das rotas csv/xlsx (depois do painelSession): os mesmos filtros da tela. Filtro inválido ou arquivo grande
 * demais volta para a tela, que explica — o link não é `download`, então o lojista vê o aviso em vez de um arquivo quebrado.
 */
export async function exportResponse(merchantId: string, req: Request, format: "csv" | "xlsx"): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const back = (set?: Record<string, string>) => redirect(extratoHref("/painel/extrato", params, set));
  const parsed = parseExtrato(params, diaBrasilia(new Date()));
  if (!parsed.ok) return back();
  let sheet: Sheet | null;
  try {
    sheet = await exportSheet(merchantId, parsed.value);
  } catch (err) {
    if (err instanceof ApiError) return back(); // o serviço recusou: a tela mostra o motivo
    throw err;
  }
  if (!sheet) return back({ erro: "muitas-linhas" });
  const body = format === "csv" ? toCsv(sheet) : new Uint8Array(await toXlsx(sheet));
  return new Response(body, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : XLSX_MIME,
      // Nome só com o período já validado (dígitos e hífens): seguro entre aspas.
      "content-disposition": `attachment; filename="${sheet.name}.${format}"`,
      "cache-control": "no-store",
    },
  });
}
