import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { withQuery } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, dateTime } from "@/lib/br/money";
import { first } from "@/lib/services/admin/audit";
import { type Hit, searchOperations } from "@/lib/services/admin/search";
import { pode } from "../perms-ui";
import { eventName } from "../webhooks/monitor";

export const metadata: Metadata = { title: "Localizar operação — Admin Vantri" };

const LIMIT = 20; // por tipo (o padrão de searchOperations)

type Of<K extends Hit["kind"]> = Extract<Hit, { kind: K }>;

export default async function BuscaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireAdmin({ perm: "transacoes:ler" });
  const q = (first((await searchParams).q) ?? "").trim();
  const hits = await searchOperations(q, LIMIT);
  const of = <K extends Hit["kind"]>(k: K) => hits.filter((h): h is Of<K> => h.kind === k);
  // Esconder link é só cosmético: cada tela de destino re-checa a própria permissão.
  const can = (perm: Parameters<typeof pode>[1]) => pode(user.adminRole, perm);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl">Localizar operação</h1>
        {/* <a>, não <Link>: o prefetch do Link chamaria a rota (e gravaria auditoria). */}
        {hits.length > 0 && can("transacoes:exportar") && (
          <a href={withQuery("/admin/busca/export", { q })} className={buttonClass("ghost")}>
            Exportar resumo
          </a>
        )}
      </div>

      <form
        method="get"
        action="/admin/busca"
        role="search"
        className="mt-6 grid gap-4 rounded-3xl border border-line bg-white p-5 sm:grid-cols-[1fr_auto] sm:items-end"
      >
        <Input
          label="Termo"
          name="q"
          type="search"
          defaultValue={q}
          hint="ID, txid, E2E, referência, ID no parceiro, ID do evento, nome do cliente ou e-mail."
        />
        <div className="flex gap-2">
          <button type="submit" className={buttonClass("primary")}>
            Consultar
          </button>
          <Link href="/admin/busca" className={buttonClass("ghost")}>
            Limpar
          </Link>
        </div>
      </form>

      {q.length >= 2 && (
        <section className="mt-8">
          <h2 className="text-lg">Histórico operacional</h2>
          {hits.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nada encontrado para este termo.</p>
          ) : (
            <div className="mt-3 space-y-8">
              <Group title="Clientes" rows={of("merchant")} columns={["Cliente", "E-mail", "Status", ""]}>
                {(m) => (
                  <tr key={m.id}>
                    <td>
                      <span className="font-semibold">{m.tradeName}</span>
                      <Id id={m.id} />
                    </td>
                    <td className="font-mono text-xs">{m.emailMasked ?? "—"}</td>
                    <td>
                      <StatusBadge kind="merchant" status={m.status} />
                    </td>
                    <td>
                      <Go href={can("clientes:ler") ? `/admin/clientes/${m.id}` : null}>Abrir operação</Go>
                    </td>
                  </tr>
                )}
              </Group>
              <Group title="Cobranças" rows={of("charge")} columns={["Criada em", "Cliente", "Descrição", "Valor", "Status", ""]}>
                {(c) => (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap">{dateTime(c.createdAt)}</td>
                    <td>{c.tradeName}</td>
                    <td>
                      {c.label}
                      <Id id={c.id} />
                    </td>
                    <td className="tabular-nums">{brl(c.amountCents)}</td>
                    <td>
                      <StatusBadge kind="charge" status={c.status} />
                    </td>
                    <td>
                      <Go href={withQuery("/admin/transacoes", { tipo: "cobrancas", cliente: c.merchantId })}>
                        Ver nas transações
                      </Go>
                    </td>
                  </tr>
                )}
              </Group>
              <Group title="Saques" rows={of("payout")} columns={["Pedido em", "Cliente", "Descrição", "Valor", "Status", ""]}>
                {(p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap">{dateTime(p.createdAt)}</td>
                    <td>{p.tradeName}</td>
                    <td>
                      {p.label}
                      <Id id={p.id} />
                    </td>
                    <td className="tabular-nums">{brl(p.amountCents)}</td>
                    <td>
                      <StatusBadge kind="payout" status={p.status} />
                    </td>
                    <td>
                      <Go href={can("saques:operar") ? `/admin/saques/${p.id}` : null}>Abrir saque</Go>
                    </td>
                  </tr>
                )}
              </Group>
              <Group title="Webhooks" rows={of("webhook")} columns={["Criada em", "Cliente", "Evento", "Status", ""]}>
                {(w) => (
                  <tr key={w.id}>
                    <td className="whitespace-nowrap">{dateTime(w.createdAt)}</td>
                    <td>{w.tradeName}</td>
                    <td>
                      {eventName(w.eventType)}
                      <Id id={w.id} />
                    </td>
                    <td>
                      <StatusBadge kind="delivery" status={w.status} />
                    </td>
                    <td>
                      <Go href={can("webhooks:operar") ? `/admin/webhooks/${w.id}` : null}>Abrir entrega</Go>
                    </td>
                  </tr>
                )}
              </Group>
            </div>
          )}
        </section>
      )}
      {q.length === 1 && <p className="mt-6 text-sm text-muted">Digite ao menos 2 caracteres.</p>}
    </>
  );
}

/** Um tipo de resultado; some quando não houve nenhum. No teto, avisa para refinar (nunca corta calado). */
function Group<T extends Hit>({
  title,
  rows,
  columns,
  children,
}: {
  title: string;
  rows: T[];
  columns: string[];
  children: (row: T) => ReactNode;
}) {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-muted">
        {title} ({rows.length})
      </h3>
      <Table caption={title} columns={columns}>
        {rows.map(children)}
      </Table>
      {rows.length >= LIMIT && (
        <p className="mt-2 text-xs text-muted">Mostrando os {LIMIT} mais recentes deste tipo. Refine o termo para achar outros.</p>
      )}
    </div>
  );
}

const Id = ({ id }: { id: string }) => <span className="mt-0.5 block break-all font-mono text-xs text-muted">#{id}</span>;

const Go = ({ href, children }: { href: string | null; children: ReactNode }) =>
  href ? (
    <Link href={href} className="whitespace-nowrap text-xs font-semibold text-brand hover:underline">
      {children}
    </Link>
  ) : null;
