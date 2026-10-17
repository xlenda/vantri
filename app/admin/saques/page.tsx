import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/app/components/ui/button";
import { Input, Select } from "@/app/components/ui/field";
import { Pager } from "@/app/components/ui/pager";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { failureReason, maskPixKey, withQuery } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, dateTime } from "@/lib/br/money";
import {
  ageText,
  listPayoutsOps,
  type PayoutOpFilters,
  parsePayoutOpFilters,
} from "@/lib/services/admin/payouts-ops";
import { pode } from "../perms-ui";
import { merchantOptions, STUCK_PAYOUT_MIN } from "../queries";
import { KEY_TYPES, STATUS_LABEL } from "../transacoes/lib";

export const metadata: Metadata = { title: "Saques — Admin Vantri" };

function query(f: PayoutOpFilters, page = f.page, path = "/admin/saques") {
  return withQuery(path, {
    cliente: f.merchantId,
    status: f.status,
    presos: f.stuck ? "1" : undefined,
    de: f.from,
    ate: f.to,
    pagina: page > 1 ? String(page) : undefined,
  });
}

export default async function SaquesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Ler é de quem lê transações; operar (consultar, reenviar, estornar) é re-checado em cada ação no servidor.
  const { user } = await requireAdmin({ perm: "transacoes:ler" });
  const f = parsePayoutOpFilters(await searchParams);
  const [options, { rows, hasNext }] = await Promise.all([merchantOptions(), listPayoutsOps(f)]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl">Saques</h1>
        {/* <a>, não <Link>: o prefetch do Link chamaria a rota. A rota re-checa a permissão. */}
        {pode(user.adminRole, "transacoes:exportar") && (
          <a href={query(f, 1, "/admin/saques/export")} className={buttonClass("ghost")}>
            Exportar CSV
          </a>
        )}
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Todos os saques de todos os clientes. Abra um saque para ver a linha do tempo, consultar no parceiro, reenviar ou
        pedir o estorno manual (quatro olhos).
      </p>

      <nav aria-label="Filtro rápido" className="mt-6 inline-flex rounded-full border border-line bg-white p-1">
        {(
          [
            [false, "Todos"],
            [true, `Presos há mais de ${STUCK_PAYOUT_MIN} min`],
          ] as const
        ).map(([stuck, label]) => (
          <Link
            key={label}
            href={query({ ...f, stuck: stuck || undefined, page: 1 })}
            aria-current={!!f.stuck === stuck ? "page" : undefined}
            className="rounded-full px-4 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
          >
            {label}
          </Link>
        ))}
      </nav>

      <form
        method="get"
        action="/admin/saques"
        className="mt-4 grid gap-4 rounded-3xl border border-line bg-white p-5 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1fr_1fr_auto] lg:items-end"
      >
        {f.stuck && <input type="hidden" name="presos" value="1" />}
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
          {Object.entries(STATUS_LABEL.saques).map(([value, label]) => (
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
          <Link href="/admin/saques" className={buttonClass("ghost")}>
            Limpar
          </Link>
        </div>
      </form>
      <p className="mt-2 text-xs text-muted">Datas no horário de Brasília, pelo dia do pedido.</p>

      <div className="mt-6">
        <Table
          caption="Saques"
          columns={["Pedido", "Cliente", "Valor", "Tarifa", "Chave Pix", "Status", "No parceiro", ""]}
          empty={f.stuck ? "Nenhum saque preso. Tudo andando." : "Nenhum saque com estes filtros."}
        >
          {rows.map(({ payout: p, tradeName, ageMin }) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap">
                {dateTime(p.createdAt)}
                {p.status === "processing" && (
                  <span className={`block text-xs ${ageMin > STUCK_PAYOUT_MIN ? "font-semibold text-red-700" : "text-muted"}`}>
                    há {ageText(ageMin)} em processamento
                  </span>
                )}
              </td>
              <td>
                <Link href={`/admin/clientes/${p.merchantId}`} className="font-semibold text-brand hover:underline">
                  {tradeName}
                </Link>
              </td>
              <td className="tabular-nums">{brl(p.amountCents)}</td>
              <td className="tabular-nums text-muted">{brl(p.feeCents)}</td>
              <td>
                <span className="block text-xs text-muted">{KEY_TYPES[p.pixKeyType]}</span>
                <span className="break-all font-mono text-xs">{maskPixKey(p.pixKeyType, p.pixKey)}</span>
              </td>
              <td>
                <StatusBadge kind="payout" status={p.status} />
                {p.failureCode && (
                  <span className="mt-1 block text-xs text-muted">
                    <span className="font-mono">{p.failureCode}</span> · {failureReason(p.failureCode)}
                  </span>
                )}
              </td>
              <td className="text-xs">
                <span className="block text-muted">ID</span>
                <span className="break-all font-mono">{p.providerPayoutId ?? "— (não chegou ao parceiro)"}</span>
                <span className="mt-1 block text-muted">E2E</span>
                <span className="break-all font-mono">{p.endToEndId ?? "—"}</span>
              </td>
              <td>
                <Link href={`/admin/saques/${p.id}`} className="whitespace-nowrap text-xs font-semibold text-brand hover:underline">
                  Abrir
                </Link>
              </td>
            </tr>
          ))}
        </Table>
        <Pager page={f.page} hasNext={hasNext} href={(p) => query(f, p)} />
      </div>
    </>
  );
}
