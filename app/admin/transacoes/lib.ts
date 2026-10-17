import { maskPixKey } from "@/app/painel/lib";
import { maskDocument } from "@/lib/br/documents";
import { dateTime } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { writeAudit } from "@/lib/services/admin/audit-util";
import { toChargeJson } from "@/lib/services/charges";
import { type PayoutRow, toPayoutJson } from "@/lib/services/payouts";
import { csvResponse } from "../admin-lib";
import { reais, todayDate } from "../format";
import { listChargesAdmin, listPayoutsAdmin, type TxFilters } from "../queries";

// Apoio de /admin/transacoes: tela e exportação (sem "use server": nada aqui vira endpoint).

export const STATUS_LABEL = {
  cobrancas: { pending: "Aguardando pagamento", paid: "Paga", expired: "Expirada" },
  saques: { processing: "Processando", completed: "Concluído", failed: "Falhou" },
} as const;

export const KEY_TYPES = { cpf: "CPF", cnpj: "CNPJ", email: "E-mail", phone: "Telefone", evp: "Aleatória" } as const;

/** Chave Pix como o admin vê: CPF/CNPJ mascarado (documento nunca completo); e-mail, celular e aleatória como estão. */
export const shownPixKey = (type: PayoutRow["pixKeyType"], key: string) =>
  type === "cpf" || type === "cnpj" ? maskDocument(key) : key;

/** Data ISO do JSON público → "16/10/2026, 21:07" (Brasília); sem data, "". */
export const when = (iso: string | null) => (iso ? dateTime(new Date(iso)) : "");

// ponytail: o arquivo inteiro em memória numa leitura só (igual ao extrato do painel); acima do teto recusa,
// nunca corta calado. Streaming se precisar de mais.
export const EXPORT_MAX_ROWS = 50_000;

type Csv = { header: string[]; rows: string[][] };

/**
 * CSV de /admin/transacoes com o filtro da tela (cliente, status, período), todas as páginas. As linhas saem do JSON
 * público (nada de id no parceiro, brcode, hash ou chave de idempotência) e sem dado do pagador (minimização; o
 * detalhe da tela mostra, mascarado). Uma leitura só: paginar por offset repetiria ou pularia linha se chegasse
 * transação nova no meio. Acima de `max` linhas: 422, sem arquivo e sem auditoria.
 */
export async function exportTransactions(f: TxFilters, actorUserId: string, max = EXPORT_MAX_ROWS): Promise<Response> {
  const csv = f.tipo === "saques" ? await payoutsCsv(f, max) : await chargesCsv(f, max);
  if (!csv) {
    return new Response("Transações demais para um arquivo só. Escolha um período menor ou filtre por cliente.", {
      status: 422,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const { tipo, merchantId, status, from, to } = f;
  await db().transaction((tx) =>
    writeAudit(tx, actorUserId, "export.transactions", { tipo, merchantId, status, from, to, rows: csv.rows.length }),
  );
  // from/to já passaram pelo z.iso.date() do parseTxFilters: seguros no nome do arquivo.
  return csvResponse(`${tipo}-vantri-${from && to ? `${from}-a-${to}` : todayDate()}.csv`, csv.header, csv.rows);
}

async function chargesCsv(f: Extract<TxFilters, { tipo: "cobrancas" }>, max: number): Promise<Csv | null> {
  const { rows, hasNext } = await listChargesAdmin({ ...f, page: 1 }, max);
  if (hasNext) return null;
  return {
    header: [
      "Criada em",
      "Cliente",
      "ID da cobrança",
      "txid",
      "Referência",
      "Descrição",
      "Valor (R$)",
      "Tarifa (R$)",
      "Líquido (R$)",
      "Status",
      "Paga em",
      "Vence em",
      "ID da transação (E2E)",
    ],
    rows: await Promise.all(
      rows.map(async ({ charge, tradeName }) => {
        const j = await toChargeJson(charge, { withQr: false });
        return [
          when(j.created_at),
          tradeName,
          j.id,
          j.txid,
          j.external_ref,
          j.description ?? "",
          reais(j.amount),
          reais(j.fee),
          reais(j.net),
          STATUS_LABEL.cobrancas[j.status],
          when(j.paid_at),
          when(j.expires_at),
          j.end_to_end_id ?? "",
        ];
      }),
    ),
  };
}

async function payoutsCsv(f: Extract<TxFilters, { tipo: "saques" }>, max: number): Promise<Csv | null> {
  const { rows, hasNext } = await listPayoutsAdmin({ ...f, page: 1 }, max);
  if (hasNext) return null;
  return {
    header: [
      "Pedido em",
      "Cliente",
      "ID do saque",
      "Valor (R$)",
      "Tarifa (R$)",
      "Tipo de chave",
      "Chave Pix",
      "Descrição",
      "Status",
      "Código da falha",
      "Concluído em",
      "ID da transação (E2E)",
    ],
    rows: rows.map(({ payout, tradeName }) => {
      const j = toPayoutJson(payout);
      return [
        when(j.created_at),
        tradeName,
        j.id,
        reais(j.amount),
        reais(j.fee),
        KEY_TYPES[j.pix_key_type],
        // Arquivo sai do sistema: chave do favorecido sempre mascarada (igual ao export de /admin/saques).
        maskPixKey(j.pix_key_type, j.pix_key),
        j.description ?? "",
        STATUS_LABEL.saques[j.status],
        j.failure_code ?? "",
        when(j.completed_at),
        j.end_to_end_id ?? "",
      ];
    }),
  };
}
