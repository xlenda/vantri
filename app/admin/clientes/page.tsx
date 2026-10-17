import type { Metadata } from "next";
import Link from "next/link";
import { Pager } from "@/app/components/ui/pager";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { requireUser } from "@/lib/auth/guards";
import { SEGMENT_LABELS, type Segment } from "@/lib/br/documents";
import { dateTime } from "@/lib/br/money";
import { listMerchantsAdmin, parseMerchantFilters } from "../queries";
import { CreateMerchantForm } from "./create-form";

export const metadata: Metadata = { title: "Clientes — Admin Vantri" };

const TABS = [
  [undefined, "Todos"],
  ["pending", "Pendentes"],
  ["active", "Ativos"],
  ["suspended", "Suspensos"],
  ["rejected", "Recusados"],
] as const;

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser({ role: "admin" });
  const f = parseMerchantFilters(await searchParams);
  const { rows, hasNext } = await listMerchantsAdmin(f);
  const href = (status: string | undefined, page = 1) =>
    `/admin/clientes?${new URLSearchParams({ ...(status && { status }), ...(page > 1 && { pagina: String(page) }) })}`;

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Clientes</h1>

      <details className="group mt-6 rounded-3xl border border-line bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 font-semibold [&::-webkit-details-marker]:hidden">
          Criar cliente
          <span aria-hidden className="text-xl leading-none text-muted transition-transform group-open:rotate-45">
            +
          </span>
        </summary>
        <div className="border-t border-line p-5">
          <CreateMerchantForm />
        </div>
      </details>

      <nav aria-label="Filtrar por status" className="mt-8 flex flex-wrap gap-2">
        {TABS.map(([status, label]) => (
          <Link
            key={label}
            href={href(status)}
            aria-current={f.status === status ? "page" : undefined}
            className="rounded-full border border-line bg-white px-3.5 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
          >
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-4">
        <Table
          caption="Clientes"
          columns={["Cliente", "Segmento", "Status", "Cadastro"]}
          empty="Nenhum cliente com este filtro."
        >
          {rows.map((m) => (
            <tr key={m.id}>
              <td>
                <Link href={`/admin/clientes/${m.id}`} className="font-semibold text-brand hover:underline">
                  {m.tradeName}
                </Link>
                <span className="block text-xs text-muted">{m.legalName}</span>
              </td>
              <td>{SEGMENT_LABELS[m.segment as Segment] ?? m.segment}</td>
              <td>
                <span className="flex flex-wrap gap-1.5">
                  <StatusBadge kind="merchant" status={m.status} />
                  {m.needsManualReview && m.status === "pending" && <Badge tone="warn">revisão manual</Badge>}
                </span>
              </td>
              <td className="whitespace-nowrap text-muted">{dateTime(m.createdAt)}</td>
            </tr>
          ))}
        </Table>
        <Pager page={f.page} hasNext={hasNext} href={(p) => href(f.status, p)} />
      </div>
    </>
  );
}
