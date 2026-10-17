import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/components/ui/action-form";
import { buttonClass } from "@/app/components/ui/button";
import { Input, Select } from "@/app/components/ui/field";
import { Pager } from "@/app/components/ui/pager";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { withQuery } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { dateTime } from "@/lib/br/money";
import { merchantOptions } from "../queries";
import { disableEndpointAction, resendFailedBatchAction } from "./actions";
import {
  DELIVERY_EVENTS,
  type DeliveryFilters,
  endpointSuccessRates,
  eventName,
  listDeliveries,
  overallSuccessRates,
  parseDeliveryFilters,
} from "./monitor";

export const metadata: Metadata = { title: "Webhooks — Admin Vantri" };

const TABS = [
  [undefined, "Todas"],
  ["pending", "Na fila"],
  ["delivered", "Entregues"],
  ["failed", "Falhou de vez"],
] as const;

/** URL da lista mantendo os filtros. */
function query(f: Omit<DeliveryFilters, "page">, page = 1) {
  return withQuery("/admin/webhooks", {
    cliente: f.merchantId,
    endpoint: f.endpointId,
    evento: f.eventType,
    status: f.status,
    de: f.from,
    ate: f.to,
    pagina: page > 1 ? String(page) : undefined,
  });
}

const pct = (r: number | null) =>
  r === null ? "sem dados" : `${(r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
// Mesmas faixas da saúde do endpoint no painel: ≥95% saudável, ≥80% instável, abaixo disso com falhas.
const tone = (r: number | null) => (r === null ? "muted" : r >= 0.95 ? "ok" : r >= 0.8 ? "warn" : "bad");

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin({ perm: "webhooks:operar" });
  const f = parseDeliveryFilters(await searchParams);
  const [options, { rows, hasNext }, rates, overall] = await Promise.all([
    merchantOptions(),
    listDeliveries(f),
    endpointSuccessRates(f.merchantId),
    overallSuccessRates(),
  ]);
  const filteredUrl = f.endpointId && (rates.find((r) => r.endpointId === f.endpointId)?.url ?? "selecionado");
  // O lote usa os mesmos filtros da tela (menos status e página: só o que falhou de vez volta).
  const scope = { cliente: f.merchantId, endpoint: f.endpointId, evento: f.eventType, de: f.from, ate: f.to };

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Webhooks</h1>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
        Entregas de todos os clientes. Cada entrega tem 7 tentativas ao longo de cerca de 33 horas; esgotadas, ela fica em
        “Falhou de vez”, de onde dá para reenviar.
      </p>

      <dl className="mt-6 grid gap-4 sm:grid-cols-2">
        {(
          [
            ["Sucesso das tentativas — 24 h", overall.rate24h, overall.attempts24h],
            ["Sucesso das tentativas — 7 dias", overall.rate7d, overall.attempts7d],
          ] as const
        ).map(([label, r, n]) => (
          <div key={label} className="rounded-3xl border border-line bg-white p-5">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums">{pct(r)}</dd>
            <dd className="text-xs text-muted">{n} tentativa(s), todos os clientes</dd>
          </div>
        ))}
      </dl>

      <nav aria-label="Filtrar por status" className="mt-8 flex flex-wrap gap-2">
        {TABS.map(([status, label]) => (
          <Link
            key={label}
            href={query({ ...f, status })}
            aria-current={f.status === status ? "page" : undefined}
            className="rounded-full border border-line bg-white px-3.5 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
          >
            {label}
          </Link>
        ))}
      </nav>

      <form
        method="get"
        action="/admin/webhooks"
        className="mt-4 grid gap-4 rounded-3xl border border-line bg-white p-5 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1fr_1fr_auto] lg:items-end"
      >
        {f.status && <input type="hidden" name="status" value={f.status} />}
        {f.endpointId && <input type="hidden" name="endpoint" value={f.endpointId} />}
        <Select label="Cliente" name="cliente" defaultValue={f.merchantId ?? ""}>
          <option value="">Todos</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.tradeName}
            </option>
          ))}
        </Select>
        <Select label="Evento" name="evento" defaultValue={f.eventType ?? ""}>
          <option value="">Todos</option>
          {DELIVERY_EVENTS.map((e) => (
            <option key={e} value={e}>
              {eventName(e)}
            </option>
          ))}
        </Select>
        <Input label="De" name="de" type="date" defaultValue={f.from} />
        <Input label="Até" name="ate" type="date" defaultValue={f.to} />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <button type="submit" className={buttonClass("primary")}>
            Filtrar
          </button>
          <Link href="/admin/webhooks" className={buttonClass("ghost")}>
            Limpar
          </Link>
        </div>
      </form>
      <p className="mt-2 text-xs text-muted">
        Datas no horário de Brasília, pelo dia em que o evento foi gerado.
        {filteredUrl && (
          <>
            {" "}
            Só o endpoint <span className="break-all font-mono">{filteredUrl}</span> —{" "}
            <Link href={query({ ...f, endpointId: undefined })} className="font-semibold text-brand hover:underline">
              mostrar todos
            </Link>
            .
          </>
        )}
      </p>

      {f.status === "failed" && (
        <ActionForm action={resendFailedBatchAction} className="mt-4 rounded-3xl border border-line bg-white p-5">
          {Object.entries(scope).map(([name, value]) =>
            value ? <input key={name} type="hidden" name={name} value={value} /> : null,
          )}
          <p className="text-sm leading-relaxed text-muted">
            Volta para a fila toda entrega que falhou de vez com estes filtros (todas as páginas; só de endpoints ativos). O
            envio começa na hora.
          </p>
          <SubmitButton className="mt-3" pendingText="Reenviando…">
            Reenviar todas as falhas deste filtro
          </SubmitButton>
        </ActionForm>
      )}

      <div className="mt-6">
        <Table
          caption="Entregas de webhook"
          columns={["Criada em", "Cliente", "Evento", "Endpoint", "Status", "HTTP", "Tentativas", ""]}
          empty="Nenhuma entrega com estes filtros."
        >
          {rows.map(({ delivery: x, tradeName, url }) => (
            <tr key={x.id}>
              <td className="whitespace-nowrap">{dateTime(x.createdAt)}</td>
              <td className="font-semibold">{tradeName}</td>
              <td className="whitespace-nowrap">{eventName(x.eventType)}</td>
              <td className="max-w-[14rem] truncate font-mono text-xs" title={url}>
                {url}
              </td>
              <td>
                <StatusBadge kind="delivery" status={x.status} />
                {x.status !== "delivered" && x.lastError && (
                  <span className="mt-1 block whitespace-nowrap text-xs text-muted">{x.lastError}</span>
                )}
              </td>
              <td className="tabular-nums">{x.lastStatusCode ?? "—"}</td>
              <td className="tabular-nums">{x.attempts}</td>
              <td className="text-right">
                <Link href={`/admin/webhooks/${x.id}`} className="whitespace-nowrap text-xs font-semibold text-brand hover:underline">
                  Detalhes
                </Link>
              </td>
            </tr>
          ))}
        </Table>
        <Pager page={f.page} hasNext={hasNext} href={(p) => query(f, p)} />
      </div>

      <section className="mt-10">
        <h2 className="text-lg">Taxa de sucesso por endpoint</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
          Tentativas de entrega dos últimos 7 dias, o pior primeiro. Saudável a partir de 95%, instável a partir de 80%.
          Desativar faz o endpoint parar de receber eventos novos; o cliente reativa pelo painel dele.
        </p>
        <div className="mt-3">
          <Table
            caption="Taxa de sucesso por endpoint"
            columns={["Cliente", "Endpoint", "24 h", "7 dias", "Situação", ""]}
            empty="Nenhuma tentativa de entrega nos últimos 7 dias."
          >
            {rates.map((r) => (
              <tr key={r.endpointId}>
                <td className="font-semibold">{r.tradeName}</td>
                <td className="max-w-[16rem] truncate font-mono text-xs" title={r.url}>
                  <Link href={query({ merchantId: f.merchantId, endpointId: r.endpointId })} className="text-brand hover:underline">
                    {r.url}
                  </Link>
                </td>
                <td>
                  <Badge tone={tone(r.rate24h)}>{pct(r.rate24h)}</Badge>
                </td>
                <td className="whitespace-nowrap">
                  <Badge tone={tone(r.rate7d)}>{pct(r.rate7d)}</Badge>{" "}
                  <span className="text-xs text-muted">{r.attempts7d}</span>
                </td>
                <td>{r.active ? <Badge tone="ok">Ativo</Badge> : <Badge>Desativado</Badge>}</td>
                <td className="text-right">
                  {/* Continua montado depois de desativar para a resposta da ação aparecer. */}
                  <ActionForm action={disableEndpointAction}>
                    {r.active && (
                      <>
                        <input type="hidden" name="id" value={r.endpointId} />
                        <SubmitButton variant="ghost" className="!h-9 !px-3.5 text-xs" pendingText="Desativando…">
                          Desativar
                        </SubmitButton>
                      </>
                    )}
                  </ActionForm>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </section>
    </>
  );
}
