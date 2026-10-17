import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/app/components/ui/button";
import { Input, Select } from "@/app/components/ui/field";
import { Pager } from "@/app/components/ui/pager";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { requireUser } from "@/lib/auth/guards";
import { maskDocument } from "@/lib/br/documents";
import { brl, dateTime } from "../format";
import { listChargesAdmin, listPayoutsAdmin, merchantOptions, parseTxFilters, type TxFilters } from "../queries";

export const metadata: Metadata = { title: "Transações — Admin Vantri" };

const STATUS = {
  cobrancas: [
    ["pending", "Aguardando pagamento"],
    ["paid", "Paga"],
    ["expired", "Expirada"],
  ],
  saques: [
    ["processing", "Processando"],
    ["completed", "Concluído"],
    ["failed", "Falhou"],
  ],
} as const;

const KEY_TYPES = { cpf: "CPF", cnpj: "CNPJ", email: "E-mail", phone: "Telefone", evp: "Aleatória" } as const;

function query(f: TxFilters, page = f.page) {
  const p = new URLSearchParams({ tipo: f.tipo });
  if (f.merchantId) p.set("cliente", f.merchantId);
  if (f.status) p.set("status", f.status);
  if (f.from) p.set("de", f.from);
  if (f.to) p.set("ate", f.to);
  if (page > 1) p.set("pagina", String(page));
  return `/admin/transacoes?${p}`;
}

export default async function TransacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser({ role: "admin" });
  const f = parseTxFilters(await searchParams);
  const options = await merchantOptions();

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Transações</h1>

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
          {STATUS[f.tipo].map(([value, label]) => (
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
      <p className="mt-2 text-xs text-muted">Datas pelo dia da criação, no horário de Brasília.</p>

      <div className="mt-6">
        {f.tipo === "saques" ? <PayoutsTable f={f} /> : <ChargesTable f={f} />}
      </div>
    </>
  );
}

async function PayoutsTable({ f }: { f: Extract<TxFilters, { tipo: "saques" }> }) {
  const { rows, hasNext } = await listPayoutsAdmin(f);
  return (
    <>
      <Table
        caption="Saques"
        columns={["Pedido em", "Cliente", "Valor", "Taxa", "Chave Pix", "Status"]}
        empty="Nenhum saque com estes filtros."
      >
        {rows.map(({ payout: p, tradeName }) => (
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
              <span className="break-all font-mono text-xs">
                {p.pixKeyType === "cpf" || p.pixKeyType === "cnpj" ? maskDocument(p.pixKey) : p.pixKey}
              </span>
            </td>
            <td>
              <StatusBadge kind="payout" status={p.status} />
              {p.failureCode && <span className="mt-1 block font-mono text-xs text-muted">{p.failureCode}</span>}
            </td>
          </tr>
        ))}
      </Table>
      <Pager page={f.page} hasNext={hasNext} href={(p) => query(f, p)} />
    </>
  );
}

async function ChargesTable({ f }: { f: Extract<TxFilters, { tipo: "cobrancas" }> }) {
  const { rows, hasNext } = await listChargesAdmin(f);
  const simulator = process.env.PIX_PROVIDER === "simulator";
  return (
    <>
      <Table
        caption="Cobranças"
        columns={["Criada em", "Cliente", "Valor", "Taxa", "Status", "Identificação"]}
        empty="Nenhuma cobrança com estes filtros."
      >
        {rows.map(({ charge: c, tradeName }) => (
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
              <span className="block font-mono text-xs text-muted">{c.id}</span>
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
