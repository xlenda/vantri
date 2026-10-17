import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Input, Select } from "@/app/components/ui/field";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { dateTime as dataHora } from "@/lib/br/money";
import { WebhookError } from "@/lib/services/webhooks-admin";
import { listDeliveries, listEndpoints } from "@/lib/webhooks/attempts";
import { painelSession, uuidOrUndefined, withQuery } from "../../lib";
import { Pager } from "../../pager";
import { endpointName, eventLabel } from "../labels";

export const metadata: Metadata = { title: "Entregas de webhook — Vantri" };

const PATH = "/painel/integracoes/entregas";
const STATUS = [
  ["", "Todas"],
  ["delivered", "Entregues"],
  ["failed", "Falharam"],
  ["pending", "Na fila"],
] as const;
const LIMITS = ["25", "50", "100"] as const;

const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
const httpTone = (code: number | null) => (code === null ? "" : code >= 200 && code < 300 ? "text-ok" : code >= 400 ? "text-red-700" : "");

export default async function EntregasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  // Filtros da URL: o que não tem formato válido some aqui; datas e busca o serviço confere (mensagem em PT).
  const f = {
    endpoint: uuidOrUndefined(sp.endpoint),
    status: STATUS.find(([s]) => s && s === sp.status)?.[0] || undefined,
    from: str(sp.from),
    to: str(sp.to),
    q: str(sp.q)?.trim() || undefined,
    limit: LIMITS.find((l) => l === sp.limit),
  };
  const cursor = uuidOrUndefined(sp.cursor);

  const endpoints = await listEndpoints(merchant.id);
  let page: Awaited<ReturnType<typeof listDeliveries>> = { data: [], nextCursor: null };
  let problem: string | null = null;
  try {
    page = await listDeliveries(merchant.id, {
      endpointId: f.endpoint,
      status: f.status,
      from: f.from,
      to: f.to,
      term: f.q,
      limit: Number(f.limit ?? 25),
      cursor,
    });
  } catch (e) {
    if (!(e instanceof WebhookError)) throw e;
    problem = e.message;
  }

  const notice: ["ok" | "error", string] | undefined =
    sp.teste === "entregue"
      ? ["ok", "Teste entregue: o seu endpoint respondeu com sucesso. O resultado é a primeira linha da lista."]
      : sp.teste === "falhou"
        ? ["error", "O teste não foi entregue. Abra a primeira linha da lista para ver o motivo e a resposta do seu endpoint."]
        : sp.erro === "reenviar"
          ? ["error", "Não foi possível reenviar a entrega. Recarregue a página e tente de novo."]
          : undefined;
  const filtered = !!(f.endpoint || f.status || f.from || f.to || f.q);

  return (
    <div className="space-y-8">
      <header>
        <Link href="/painel/integracoes?aba=webhooks" className="text-sm font-semibold text-brand hover:underline">
          ← Webhooks
        </Link>
        <p className="eyebrow mt-4">Desenvolvedores</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Entregas de webhook</h1>
        <p className="mt-2 text-sm text-muted">Cada aviso enviado ao seu sistema, com a resposta e as tentativas. Abra uma entrega para ver os detalhes.</p>
      </header>

      {notice && <Alert tone={notice[0]}>{notice[1]}</Alert>}

      <form method="get" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Select label="Webhook" name="endpoint" defaultValue={f.endpoint ?? ""}>
          <option value="">Todos os webhooks</option>
          {endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {endpointName(e)}
            </option>
          ))}
        </Select>
        <Select label="Situação" name="status" defaultValue={f.status ?? ""}>
          {STATUS.map(([s, label]) => (
            <option key={label} value={s}>
              {label}
            </option>
          ))}
        </Select>
        <Select label="Por página" name="limit" defaultValue={f.limit ?? "25"}>
          {LIMITS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
        <Input type="date" label="De" name="from" defaultValue={f.from} />
        <Input type="date" label="Até" name="to" defaultValue={f.to} />
        <Input
          label="Identificador"
          name="q"
          maxLength={200}
          defaultValue={f.q}
          placeholder="evt_…, ID, txid, referência ou E2E"
          hint="Com 8 caracteres ou mais, procura em todo o histórico (ignora o período)."
        />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
          <button type="submit" className={buttonClass("primary")}>
            Filtrar
          </button>
          {filtered && (
            <Link href={PATH} className={buttonClass("ghost")}>
              Limpar filtros
            </Link>
          )}
        </div>
      </form>

      {problem && <Alert>{problem}</Alert>}

      <section className="space-y-3">
        <Table
          columns={["Data", "Situação", "Evento", "Webhook", "HTTP", "Tentativas", "Latência", ""]}
          empty={filtered ? "Nenhuma entrega com esses filtros." : "Nenhuma entrega ainda. Elas aparecem quando acontece um evento que um webhook assina, ou quando você usa “Testar”."}
          caption="Entregas de webhook"
        >
          {page.data.map((d) => (
            <tr key={d.id}>
              <td className="whitespace-nowrap text-muted">{dataHora(d.createdAt)}</td>
              <td>
                <StatusBadge kind="delivery" status={d.status} />
                {d.status === "pending" && d.attempts > 0 && (
                  <span className="mt-1 block whitespace-nowrap text-xs text-muted">Nova tentativa {dataHora(d.nextAttemptAt)}</span>
                )}
              </td>
              <td>
                <span className="block whitespace-nowrap font-medium">{eventLabel(d.eventType)}</span>
                <code className="whitespace-nowrap text-xs text-muted">{d.eventType}</code>
              </td>
              <td className="max-w-[14rem] truncate text-xs" title={d.url}>
                {endpointName({ url: d.url, description: d.endpointDescription })}
              </td>
              <td className={`tabular-nums ${httpTone(d.lastStatusCode)}`}>{d.lastStatusCode ?? "—"}</td>
              <td className="tabular-nums">{d.attempts}</td>
              <td className="whitespace-nowrap tabular-nums">{d.latencyMs === null ? "—" : `${d.latencyMs} ms`}</td>
              <td className="text-right">
                <Link href={`${PATH}/${d.id}`} className="font-semibold text-brand hover:underline">
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </Table>
        <Pager
          first={cursor ? withQuery(PATH, f) : undefined}
          next={page.nextCursor ? withQuery(PATH, { ...f, cursor: page.nextCursor }) : undefined}
        />
      </section>
    </div>
  );
}
