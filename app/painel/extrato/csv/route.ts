import { redirect } from "next/navigation";
import { ApiError } from "@/lib/api/http";
import { listStatement } from "@/lib/api/statement";
import type { ledgerEntries } from "@/lib/db/schema";
import { csvCell, diaBrasilia, LEDGER_BUCKET, LEDGER_KIND, LEDGER_REF, painelSession, withQuery } from "../../lib";

// ponytail: monta o arquivo inteiro em memória; acima disso recusa (nunca corta calado). Streaming se precisar de mais.
const MAX_ROWS = 50_000;
const stamp = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium" });

/** Centavos (sem sinal) → "1234,56": número que a planilha em pt-BR soma direto. */
const reais = (cents: number) => `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, "0")}`;

const HEADER = ["Data", "Lançamento", "Saldo", "Referência", "ID da referência", "Entrada (R$)", "Saída (R$)", "ID do lançamento"];
const line = (e: typeof ledgerEntries.$inferSelect) =>
  [
    stamp.format(e.createdAt),
    LEDGER_KIND[e.kind],
    LEDGER_BUCKET[e.bucket],
    LEDGER_REF[e.refType],
    e.refId,
    e.amountCents > 0 ? reais(e.amountCents) : "",
    e.amountCents < 0 ? reais(-e.amountCents) : "",
    e.id,
  ]
    .map(csvCell)
    .join(";");

/** /painel/extrato/csv?from&to — mesmo período e regras da tela (sem datas: últimos 30 dias). */
export async function GET(req: Request) {
  const { merchant } = await painelSession();
  const q = new URL(req.url).searchParams;
  const from = q.get("from") || undefined;
  const to = q.get("to") || undefined;

  const rows: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await listStatement(merchant.id, { from, to, cursor, limit: 100 });
      rows.push(...page.data.map(line));
      cursor = page.nextCursor ?? undefined;
      if (rows.length > MAX_ROWS) {
        return new Response("Lançamentos demais para um arquivo só. Escolha um período menor.", {
          status: 422,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
    } while (cursor);
  } catch (e) {
    if (e instanceof ApiError) redirect(withQuery("/painel/extrato", { from, to })); // a tela mostra o erro do período
    throw e;
  }

  // Aqui from/to já passaram pelo z.iso.date() do listStatement: seguros no nome do arquivo.
  const name = `extrato-vantri-${from && to ? `${from}-a-${to}` : diaBrasilia(new Date())}.csv`;
  // BOM: o Excel só lê como UTF-8 com ele.
  const body = "\uFEFF" + [HEADER.map(csvCell).join(";"), ...rows].join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
