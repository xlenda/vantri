import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/app/components/ui/button";
import { Pager } from "@/app/components/ui/pager";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { pode } from "@/lib/auth/perms";
import { dateTime } from "@/lib/br/money";
import type { merchants } from "@/lib/db/schema";
import { maskEmail } from "../admin-lib";
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
  const { user } = await requireAdmin({ perm: "clientes:ler" });
  const f = parseMerchantFilters(await searchParams);
  const { rows, hasNext } = await listMerchantsAdmin(f);
  const href = (status: string | undefined, page = 1) =>
    `/admin/clientes?${new URLSearchParams({ ...(status && { status }), ...(page > 1 && { pagina: String(page) }) })}`;

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Clientes</h1>

      {/* Só mostra a quem cadastra; a action re-checa clientes:cadastro no servidor. */}
      {pode(user.adminRole, "clientes:cadastro") && (
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
      )}

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
        <h2 className="text-lg">Sellers</h2>
        <p className="mt-1 text-sm text-muted">
          Lista resumida, sem documento, telefone ou credenciais. O documento (mascarado) fica na operação do cliente.
        </p>
        <div className="mt-3">
          <Table
            caption="Sellers"
            columns={["Seller", "Conta", "KYC", "API", "Desde", <span key="op" className="sr-only">Ações</span>]}
            empty="Nenhum cliente com este filtro."
          >
            {rows.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="font-semibold">{m.tradeName}</span>
                  <span className="block text-xs text-muted">
                    <span className="font-mono">{`#${m.id.slice(0, 8)}`}</span>
                    {` · ${m.email ? maskEmail(m.email) : "sem usuário"}`}
                  </span>
                </td>
                <td>
                  <StatusBadge kind="merchant" status={m.status} />
                </td>
                <td>
                  <Kyc status={m.status} manual={m.needsManualReview} />
                </td>
                <td>
                  {m.status === "active" ? <Badge tone="ok">Liberada</Badge> : <Badge tone="muted">Bloqueada</Badge>}
                </td>
                <td className="whitespace-nowrap text-muted">{dateTime(m.createdAt)}</td>
                <td className="text-right">
                  <Link href={`/admin/clientes/${m.id}`} className={buttonClass("ghost", "whitespace-nowrap")}>
                    Operação
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
          <Pager page={f.page} hasNext={hasNext} href={(p) => href(f.status, p)} />
        </div>
      </div>
    </>
  );
}

/** KYC = conferência do cadastro (documento e CNAE). KYC documental depende do parceiro e não é simulado aqui. */
function Kyc({ status, manual }: { status: (typeof merchants.$inferSelect)["status"]; manual: boolean }) {
  if (status === "pending") return <Badge tone="warn">{manual ? "Revisão manual" : "Em revisão"}</Badge>;
  if (status === "rejected") return <Badge tone="muted">Recusado</Badge>;
  return <Badge tone="ok">Aprovado</Badge>;
}
