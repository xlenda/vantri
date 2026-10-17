import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass } from "@/app/components/ui/button";
import { Input, Select } from "@/app/components/ui/field";
import { Pager } from "@/app/components/ui/pager";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { maskDocument } from "@/lib/br/documents";
import { brl, dateTime } from "@/lib/br/money";
import { toChargeJson } from "@/lib/services/charges";
import { toPayoutJson } from "@/lib/services/payouts";
import { pode } from "../perms-ui";
import { listChargesAdmin, listPayoutsAdmin, merchantOptions, parseTxFilters, type TxFilters } from "../queries";
import { KEY_TYPES, shownPixKey, STATUS_LABEL, when } from "./lib";

export const metadata: Metadata = { title: "Transações — Admin Vantri" };

function query(f: TxFilters, page = f.page, path = "/admin/transacoes") {
  const p = new URLSearchParams({ tipo: f.tipo });
  if (f.merchantId) p.set("cliente", f.merchantId);
  if (f.status) p.set("status", f.status);
  if (f.from) p.set("de", f.from);
  if (f.to) p.set("ate", f.to);
  if (page > 1) p.set("pagina", String(page));
  return `${path}?${p}`;
}

export default async function TransacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireAdmin({ perm: "transacoes:ler" });
  const f = parseTxFilters(await searchParams);
  const [options, table] = await Promise.all([
    merchantOptions(),
    f.tipo === "saques" ? payoutsTable(f) : chargesTable(f),
  ]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl">Transações</h1>
        {/* Esconder é só cosmético: a rota re-checa a permissão. <a>, não <Link>: o prefetch do Link chamaria a rota. */}
        {pode(user.adminRole, "transacoes:exportar") && (
          <a href={query(f, 1, "/admin/transacoes/export")} className={buttonClass("ghost")}>
            Exportar CSV
          </a>
        )}
      </div>

      <nav aria-label="Tipo" className="mt-6 inline-flex rounded-full border border-line bg-white p-1">
        {(
          [
            ["cobrancas", "Cobranças"],
            ["saques", "Saques"],
          ] as const
        ).map(([tipo, label]) => (
          <Link
            key={tipo}
            href={query({ tipo, merchantId: f.merchantId, from: f.from, to: f.to, page: 1 })}
            aria-current={f.tipo === tipo ? "page" : undefined}
            className="rounded-full px-4 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
          >
            {label}
          </Link>
        ))}
      </nav>

      <form
        method="get"
        action="/admin/transacoes"
        className="mt-4 grid gap-4 rounded-3xl border border-line bg-white p-5 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1fr_1fr_auto] lg:items-end"
      >
        <input type="hidden" name="tipo" value={f.tipo} />
        <Select label="Cliente" name="cliente" defaultValue={f.merchantId ?? ""}>
          <option value="">Todos</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.tradeName}
            </option>
          ))}
        </Select>
        <Select label="Status" name="status" defaultValue={f.status ?? ""}>
          <option value="">Todos</option>
          {Object.entries(STATUS_LABEL[f.tipo]).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Input label="De" name="de" type="date" defaultValue={f.from} />
        <Input label="Até" name="ate" type="date" defaultValue={f.to} />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <button type="submit" className={buttonClass("primary")}>
            Filtrar
          </button>
          <Link href={`/admin/transacoes?tipo=${f.tipo}`} className={buttonClass("ghost")}>
            Limpar
          </Link>
        </div>
      </form>
      <p className="mt-2 text-xs text-muted">
        Datas no horário de Brasília: pelo dia da criação ou, com o status “Paga”, pelo dia do pagamento.
      </p>

      <div className="mt-6">{table}</div>
    </>
  );
}

// Funções (não componentes async): resolvem antes da renderização, em paralelo com a lista de clientes.
async function payoutsTable(f: Extract<TxFilters, { tipo: "saques" }>) {
  const { rows, hasNext } = await listPayoutsAdmin(f);
  return (
    <>
      <Table
        caption="Saques"
        columns={["Pedido em", "Cliente", "Valor", "Taxa", "Chave Pix", "Status", "Detalhe"]}
        empty="Nenhum saque com estes filtros."
      >
        {rows.map(({ payout: p, tradeName }) => {
          const j = toPayoutJson(p);
          return (
            <tr key={p.id}>
              <td className="whitespace-nowrap">{dateTime(p.createdAt)}</td>
              <td>
                <Link href={`/admin/clientes/${p.merchantId}`} className="font-semibold text-brand hover:underline">
                  {tradeName}
                </Link>
              </td>
              <td className="tabular-nums">{brl(p.amountCents)}</td>
              <td className="tabular-nums text-muted">{brl(p.feeCents)}</td>
              <td>
                <span className="block text-xs text-muted">{KEY_TYPES[p.pixKeyType]}</span>
                <span className="break-all font-mono text-xs">{shownPixKey(p.pixKeyType, p.pixKey)}</span>
              </td>
              <td>
                <StatusBadge kind="payout" status={p.status} />
                {p.failureCode && <span className="mt-1 block font-mono text-xs text-muted">{p.failureCode}</span>}
              </td>
              <td>
                <Detail
                  items={[
                    ["ID do saque", j.id],
                    ["Descrição", j.description],
                    ["Concluído em", when(j.completed_at)],
                    ["ID da transação (E2E)", j.end_to_end_id],
                  ]}
                >
                  <Link href={`/admin/saques/${p.id}`} className="mt-2 inline-block text-xs font-semibold text-brand hover:underline">
                    Abrir operação do saque
                  </Link>
                </Detail>
              </td>
            </tr>
          );
        })}
      </Table>
      <Pager page={f.page} hasNext={hasNext} href={(p) => query(f, p)} />
    </>
  );
}

async function chargesTable(f: Extract<TxFilters, { tipo: "cobrancas" }>) {
  const { rows, hasNext } = await listChargesAdmin(f);
  const simulator = process.env.PIX_PROVIDER === "simulator";
  const items = await Promise.all(rows.map(async (r) => ({ ...r, j: await toChargeJson(r.charge, { withQr: false }) })));
  return (
    <>
      <Table
        caption="Cobranças"
        columns={["Criada em", "Cliente", "Valor", "Taxa", "Status", "Detalhe"]}
        empty="Nenhuma cobrança com estes filtros."
      >
        {items.map(({ charge: c, tradeName, j }) => (
          <tr key={c.id}>
            <td className="whitespace-nowrap">{dateTime(c.createdAt)}</td>
            <td>
              <Link href={`/admin/clientes/${c.merchantId}`} className="font-semibold text-brand hover:underline">
                {tradeName}
              </Link>
            </td>
            <td className="tabular-nums">{brl(c.amountCents)}</td>
            <td className="tabular-nums text-muted">{brl(c.feeCents)}</td>
            <td>
              <StatusBadge kind="charge" status={c.status} />
              {c.paidAt && <span className="mt-1 block whitespace-nowrap text-xs text-muted">paga {dateTime(c.paidAt)}</span>}
            </td>
            <td>
              <Detail
                items={[
                  ["ID da cobrança", j.id],
                  ["txid", j.txid],
                  ["Referência", j.external_ref],
                  ["Descrição", j.description],
                  ["Líquido", brl(j.net)],
                  ["Vence em", when(j.expires_at)],
                  ["Pagador", j.payer?.name],
                  // Já vem gravado mascarado; mascarar de novo não muda nada e segura uma gravação errada.
                  ["Documento do pagador", j.payer?.document_masked && maskDocument(j.payer.document_masked)],
                  ["ID da transação (E2E)", j.end_to_end_id],
                ]}
              />
              {simulator && c.status === "paid" && (
                <Link href={`/admin/med?cobranca=${c.id}`} className="mt-1 inline-block text-xs font-semibold text-brand">
                  Abrir MED de teste
                </Link>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <Pager page={f.page} hasNext={hasNext} href={(p) => query(f, p)} />
    </>
  );
}

/** Detalhe inline, sem JS: campos do JSON público; vazio vira "—". */
function Detail({ items, children }: { items: Array<[string, string | null | undefined]>; children?: ReactNode }) {
  return (
    <details>
      <summary className="cursor-pointer whitespace-nowrap text-xs font-semibold text-brand">Ver detalhes</summary>
      <dl className="mt-2 grid min-w-[16rem] gap-1.5 text-xs">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="break-words font-medium text-ink">{value || "—"}</dd>
          </div>
        ))}
      </dl>
      {children}
    </details>
  );
}
