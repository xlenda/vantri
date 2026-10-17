import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/app/components/ui/button";
import { Input, Select } from "@/app/components/ui/field";
import { Pager } from "@/app/components/ui/pager";
import { Table } from "@/app/components/ui/table";
import { withQuery } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import {
  actionLabel,
  type AuditFilters,
  auditFilterOptions,
  brasilia,
  listAudit,
  type Params,
  parseAuditFilters,
} from "@/lib/services/admin/audit";
import { pode } from "../perms-ui";
import { merchantOptions } from "../queries";

export const metadata: Metadata = { title: "Auditoria — Admin Vantri" };

const query = (f: AuditFilters) => ({ quem: f.actorUserId, acao: f.action, cliente: f.merchantId, de: f.from, ate: f.to });

export default async function AuditoriaPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { user } = await requireAdmin({ perm: "auditoria:ler" });
  const f = parseAuditFilters(await searchParams);
  const [{ rows, hasNext }, options, clients] = await Promise.all([listAudit(f), auditFilterOptions(), merchantOptions()]);
  // A ação filtrada aparece no seletor mesmo sem registro ainda.
  const actions = f.action && !options.actions.includes(f.action) ? [...options.actions, f.action] : options.actions;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl">Auditoria</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Quem fez o quê no admin, com os detalhes de cada ação. Só leitura: nenhum registro é editado ou removido.
          </p>
        </div>
        {pode(user.adminRole, "auditoria:exportar") && (
          <a href={withQuery("/admin/auditoria/export", query(f))} className={buttonClass("ghost")} download>
            Exportar CSV
          </a>
        )}
      </div>

      <form
        method="get"
        action="/admin/auditoria"
        className="mt-6 grid gap-4 rounded-3xl border border-line bg-white p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[1.4fr_1.4fr_1.4fr_1fr_1fr_auto] xl:items-end"
      >
        <Select label="Quem" name="quem" defaultValue={f.actorUserId ?? ""}>
          <option value="">Todos</option>
          {options.actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </Select>
        <Select label="Ação" name="acao" defaultValue={f.action ?? ""}>
          <option value="">Todas</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </Select>
        <Select label="Cliente" name="cliente" defaultValue={f.merchantId ?? ""}>
          <option value="">Todos</option>
          {clients.map((o) => (
            <option key={o.id} value={o.id}>
              {o.tradeName}
            </option>
          ))}
        </Select>
        <Input label="De" name="de" type="date" defaultValue={f.from} />
        <Input label="Até" name="ate" type="date" defaultValue={f.to} />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <button type="submit" className={buttonClass("primary")}>
            Filtrar
          </button>
          <Link href="/admin/auditoria" className={buttonClass("ghost")}>
            Limpar
          </Link>
        </div>
      </form>
      <p className="mt-2 text-xs text-muted">Datas no horário de Brasília. A exportação também fica registrada aqui.</p>

      <div className="mt-6">
        <Table
          caption="Registros de auditoria"
          columns={["Quando", "Quem", "Ação", "Cliente", "Detalhes"]}
          empty="Nenhum registro com estes filtros."
        >
          {rows.map(({ log, actorEmail, merchant }) => (
            <tr key={log.id}>
              <td className="whitespace-nowrap tabular-nums">{brasilia(log.createdAt)}</td>
              <td className="break-all">{actorEmail ?? <span className="text-muted">Sistema</span>}</td>
              <td>
                <span className="block font-semibold">{actionLabel(log.action)}</span>
                <span className="block font-mono text-xs text-muted">{log.action}</span>
              </td>
              <td>
                {merchant ? (
                  <Link href={`/admin/clientes/${merchant.id}`} className="font-semibold text-brand hover:underline">
                    {merchant.tradeName}
                  </Link>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td>
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-brand">Ver</summary>
                  <pre className="mt-2 max-w-sm overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-bg p-3 font-mono text-xs text-ink">
                    {JSON.stringify(log.meta, null, 2)}
                  </pre>
                </details>
              </td>
            </tr>
          ))}
        </Table>
        <Pager
          page={f.page}
          hasNext={hasNext}
          href={(p) => withQuery("/admin/auditoria", { ...query(f), pagina: p > 1 ? String(p) : undefined })}
        />
      </div>
    </>
  );
}
