import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/field";
import { Pager } from "@/app/components/ui/pager";
import { Table } from "@/app/components/ui/table";
import { withQuery } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { type AccessFilters, EVENT_LABEL, listAccess, parseAccessFilters } from "@/lib/services/admin/access";
import { brasilia, type Params, utc } from "@/lib/services/admin/audit";
import { pode } from "../perms-ui";

export const metadata: Metadata = { title: "Acessos — Admin Vantri" };

const query = (f: AccessFilters) => ({ email: f.email, usuario: f.userId, ip: f.ip, de: f.from, ate: f.to });

export default async function AcessosPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { user } = await requireAdmin({ perm: "acessos:ler" });
  const f = parseAccessFilters(await searchParams);
  const { rows, hasNext } = await listAccess(f);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl">Registros de acesso</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            IP e data/hora de cada acesso, guardados por no mínimo 6 meses (Marco Civil da Internet, art. 15); a limpeza
            automática apaga só o que passou disso. Para ordem judicial, filtre e exporte: o arquivo entra na auditoria
            com o SHA-256 dele.
          </p>
        </div>
        {pode(user.adminRole, "acessos:exportar") && (
          <a href={withQuery("/admin/acessos/export", query(f))} className={buttonClass("ghost")} download>
            Exportar CSV
          </a>
        )}
      </div>

      <form
        method="get"
        action="/admin/acessos"
        className="mt-6 grid gap-4 rounded-3xl border border-line bg-white p-5 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1fr_1fr_auto] lg:items-end"
      >
        {f.userId && <input type="hidden" name="usuario" value={f.userId} />}
        <Input label="E-mail" name="email" type="email" defaultValue={f.email} placeholder="nome@exemplo.com" />
        <Input label="IP" name="ip" defaultValue={f.ip} placeholder="200.100.50.25" spellCheck={false} />
        <Input label="De" name="de" type="date" defaultValue={f.from} />
        <Input label="Até" name="ate" type="date" defaultValue={f.to} />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <button type="submit" className={buttonClass("primary")}>
            Filtrar
          </button>
          <Link href="/admin/acessos" className={buttonClass("ghost")}>
            Limpar
          </Link>
        </div>
      </form>
      <p className="mt-2 text-xs text-muted">
        E-mail e IP: busca exata. Período pelo dia de Brasília.
        {f.userId && " Filtrando por um usuário específico (Limpar tira o filtro)."}
      </p>

      <div className="mt-6">
        <Table
          caption="Registros de acesso"
          columns={["Data/hora (UTC)", "Data/hora (Brasília)", "E-mail", "IP", "Evento"]}
          empty="Nenhum acesso com estes filtros."
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap font-mono text-xs">{utc(r.createdAt)}</td>
              <td className="whitespace-nowrap tabular-nums">{brasilia(r.createdAt)}</td>
              <td className="break-all">{r.email ?? <span className="text-muted">sem usuário</span>}</td>
              <td className="break-all font-mono text-xs">{r.ip}</td>
              <td className={r.event === "login_failed" ? "font-semibold text-red-700" : undefined}>{EVENT_LABEL[r.event]}</td>
            </tr>
          ))}
        </Table>
        <Pager
          page={f.page}
          hasNext={hasNext}
          href={(p) => withQuery("/admin/acessos", { ...query(f), pagina: p > 1 ? String(p) : undefined })}
        />
      </div>
    </>
  );
}
