import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import type { Scope } from "@/lib/api/keys";
import { dateTime as dataHora } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { apiKeys } from "@/lib/db/schema";
import { MAX_ENDPOINTS } from "@/lib/services/events";
import {
  deliveryStats24h,
  type EndpointHealth,
  endpointHealth,
  type HealthBand,
  WEBHOOK_EVENT_TYPES,
} from "@/lib/services/webhooks-admin";
import { type EndpointPublic, listEndpoints } from "@/lib/webhooks/attempts";
import { EVENT_LABEL, painelSession, SCOPE_LABEL, withQuery } from "../lib";
import { deleteWebhookAction, revokeKeyAction, testWebhookAction, toggleWebhookAction } from "./actions";
import { KeyForm } from "./forms";
import { endpointName, eventLabel, SCOPE_GROUPS } from "./labels";
import { AllowlistForm, IpTestForm } from "./seguranca/ip-form";
import { RotateSecretForm, WebhookForm } from "./webhooks/form";

export const metadata: Metadata = { title: "Integrações — Vantri" };

const PAGE = "/painel/integracoes";
const ENTREGAS = `${PAGE}/entregas`;

// Aba na URL (?aba=): link direto para Webhooks e Segurança. Valor desconhecido cai em Chaves.
const ABAS = [
  ["chaves", "Chaves de API", "Chaves para o seu sistema chamar a API da Vantri, cada uma só com os escopos de que precisa."],
  ["webhooks", "Webhooks", "Avisos na hora para o seu sistema quando um Pix cai, um saque termina ou um MED abre."],
  ["seguranca", "Segurança e IPs", "Restrinja cada chave de API a IPs e faixas de confiança."],
] as const;
type Aba = (typeof ABAS)[number][0];

const NOTICE: Record<string, ["ok" | "error", string]> = {
  revogada: ["ok", "Chave revogada. Pedidos com ela passam a ser recusados."],
  removido: ["ok", "Webhook excluído. As entregas dele foram apagadas junto."],
  atualizado: ["ok", "Webhook atualizado."],
  ativado: ["ok", "Webhook ativado: ele volta a receber os eventos que assina."],
  desativado: ["ok", "Webhook desativado: ele não recebe eventos até ser ativado de novo."],
  revogar: ["error", "Não foi possível revogar a chave. Recarregue a página e tente de novo."],
  remover: ["error", "Não foi possível excluir o webhook. Recarregue a página e tente de novo."],
  situacao: ["error", "Não foi possível mudar a situação do webhook. Recarregue a página e tente de novo."],
  testar: ["error", "Não foi possível testar o webhook. Recarregue a página e tente de novo."],
  "teste-limite": ["error", "Muitos testes seguidos. Espere um minuto e tente de novo."],
};

const HEALTH: Record<HealthBand, [string, ComponentProps<typeof Badge>["tone"]]> = {
  healthy: ["Saudável", "ok"],
  unstable: ["Instável", "warn"],
  failing: ["Com falhas", "bad"],
  nodata: ["Sem dados", "muted"],
};
const NO_DATA: EndpointHealth = { rate: 0, sample: 0, band: "nodata" };
const SMALL = "!h-9 !px-3.5 text-xs";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function IntegracoesPage({ searchParams }: { searchParams: Search }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const aba: Aba = ABAS.find(([a]) => a === sp.aba)?.[0] ?? "chaves";
  const key = String(sp.erro ?? sp.ok ?? "");
  const notice = Object.hasOwn(NOTICE, key) ? NOTICE[key] : undefined; // ?ok=toString não vira aviso

  // Só os dados da aba aberta. Os componentes das abas são síncronos (renderizáveis em teste).
  let body: ReactNode;
  if (aba === "webhooks") {
    const [endpoints, health, stats] = await Promise.all([
      listEndpoints(merchant.id),
      endpointHealth(merchant.id),
      deliveryStats24h(merchant.id),
    ]);
    body = <WebhooksTab endpoints={endpoints} health={health} stats={stats} editId={typeof sp.editar === "string" ? sp.editar : undefined} />;
  } else {
    // Nunca seleciona key_hash: a chave só aparece uma vez, na criação.
    const keys = await db()
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        ipAllowlist: apiKeys.ipAllowlist,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.merchantId, merchant.id))
      .orderBy(desc(apiKeys.createdAt));
    body = aba === "chaves" ? <KeysTab keys={keys} /> : <SecurityTab keys={keys.filter((k) => !k.revokedAt)} />;
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Desenvolvedores</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Integrações</h1>
        <p className="mt-2 text-sm text-muted">
          {ABAS.find(([a]) => a === aba)![2]}{" "}
          <Link href="/docs" className="font-semibold text-brand hover:underline">
            Ver a documentação
          </Link>
        </p>
      </header>

      <nav aria-label="Seções de integrações" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1 border-b border-line">
          {ABAS.map(([a, label]) => (
            <li key={a}>
              <Link
                href={a === "chaves" ? PAGE : `${PAGE}?aba=${a}`}
                aria-current={a === aba ? "page" : undefined}
                className={`-mb-px block whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-semibold transition-colors ${
                  a === aba ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {notice && <Alert tone={notice[0]}>{notice[1]}</Alert>}
      {body}
    </div>
  );
}

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  ipAllowlist: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

function KeysTab({ keys }: { keys: KeyRow[] }) {
  const groups = SCOPE_GROUPS.map(([group, scopes]) => [group, scopes.map((s) => [s, SCOPE_LABEL[s]] as const)] as const);
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <Card className="h-fit">
        <h2 className="mb-4 text-lg">Nova chave</h2>
        <KeyForm scopeGroups={groups} />
      </Card>
      <Table columns={["Nome", "Prefixo", "Escopos", "IPs", "Último uso", ""]} empty="Nenhuma chave criada." caption="Chaves de API">
        {keys.map((k) => (
          <tr key={k.id} className={k.revokedAt ? "text-muted" : undefined}>
            <td className="font-medium">{k.name}</td>
            <td>
              <code className="whitespace-nowrap text-xs">{k.prefix}…</code>
            </td>
            <td className="text-xs">{k.scopes.map((s) => SCOPE_LABEL[s as Scope] ?? s).join(", ")}</td>
            <td className="text-xs">{k.ipAllowlist.length ? k.ipAllowlist.join(", ") : "Qualquer"}</td>
            <td className="whitespace-nowrap text-xs">{k.lastUsedAt ? dataHora(k.lastUsedAt) : "Nunca"}</td>
            <td className="text-right">
              {k.revokedAt ? (
                <Badge>Revogada</Badge>
              ) : (
                <Confirm label="Revogar" className="text-right">
                  <p>
                    A chave <strong>{k.name}</strong> deixa de funcionar na hora. Isso não cria outra chave.
                  </p>
                  <form action={revokeKeyAction}>
                    <input type="hidden" name="id" value={k.id} />
                    <SubmitButton className={SMALL} pendingText="Revogando…">
                      Revogar agora
                    </SubmitButton>
                  </form>
                </Confirm>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function WebhooksTab({
  endpoints,
  health,
  stats,
  editId,
}: {
  endpoints: EndpointPublic[];
  health: Map<string, EndpointHealth>;
  stats: Awaited<ReturnType<typeof deliveryStats24h>>;
  editId?: string;
}) {
  const editing = editId ? endpoints.find((e) => e.id === editId) : undefined; // só da lista do próprio lojista
  const events = WEBHOOK_EVENT_TYPES.map((e) => [e, EVENT_LABEL[e]] as const);
  const sample = stats.delivered + stats.failed;
  return (
    <div className="space-y-8">
      <section aria-labelledby="kpis" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="kpis" className="text-lg">
            Últimas 24 horas
          </h2>
          <Link href={ENTREGAS} className={buttonClass("ghost")}>
            Abrir o inspetor de entregas
          </Link>
        </div>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Entregues" value={stats.delivered} hint={sample ? `${Math.floor((stats.delivered / sample) * 100)}% de sucesso` : undefined} />
          <Kpi label="Falharam" value={stats.failed} />
          <Kpi label="Latência média" value={stats.avgLatencyMs === null ? "—" : `${stats.avgLatencyMs} ms`} />
          <Kpi label="Na fila" value={stats.pending} />
        </dl>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card id="webhook-form" className="h-fit scroll-mt-4">
          {editId && !editing && <Alert className="mb-4">Webhook não encontrado.</Alert>}
          {editing ? (
            <div className="space-y-6">
              <h2 className="text-lg">Editar webhook</h2>
              <WebhookForm key={editing.id} events={events} endpoint={editing} />
              <div className="space-y-3 border-t border-line pt-5">
                <RotateSecretForm id={editing.id} />
                <Confirm label="Excluir webhook">
                  <p>
                    O webhook <strong>{endpointName(editing)}</strong> e as entregas dele são apagados. Ele para de receber eventos na
                    hora.
                  </p>
                  <form action={deleteWebhookAction}>
                    <input type="hidden" name="id" value={editing.id} />
                    <SubmitButton className={SMALL} pendingText="Excluindo…">
                      Excluir de vez
                    </SubmitButton>
                  </form>
                </Confirm>
              </div>
            </div>
          ) : (
            <>
              <h2 className="mb-4 text-lg">Novo webhook</h2>
              <WebhookForm key="novo" events={events} />
              <p className="mt-4 text-xs text-muted">Até {MAX_ENDPOINTS} webhooks por conta.</p>
            </>
          )}
        </Card>

        <div className="space-y-2">
          <Table columns={["Saúde", "Webhook", "Eventos", "Situação", ""]} empty="Nenhum webhook criado." caption="Webhooks">
            {endpoints.map((w) => {
              const h = health.get(w.id) ?? NO_DATA;
              return (
                <tr key={w.id} className={w.id === editing?.id ? "bg-brand/5" : undefined}>
                  <td>
                    <Badge tone={HEALTH[h.band][1]}>{HEALTH[h.band][0]}</Badge>
                    {h.sample > 0 && (
                      <span className="mt-1 block whitespace-nowrap text-xs text-muted">
                        {Math.floor(h.rate * 100)}% em {h.sample} {h.sample === 1 ? "entrega" : "entregas"}
                      </span>
                    )}
                  </td>
                  <td className="min-w-[12rem]">
                    <span className="block font-semibold">{endpointName(w)}</span>
                    <code className="block break-all text-xs text-muted">{w.url}</code>
                    <Link href={withQuery(ENTREGAS, { endpoint: w.id })} className="text-xs font-semibold text-brand hover:underline">
                      Ver entregas
                    </Link>
                  </td>
                  <td className="text-xs">{w.events.map(eventLabel).join(", ")}</td>
                  <td>{w.active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Link href={`${withQuery(PAGE, { aba: "webhooks", editar: w.id })}#webhook-form`} className={buttonClass("ghost", SMALL)}>
                        Editar
                      </Link>
                      <form action={toggleWebhookAction}>
                        <input type="hidden" name="id" value={w.id} />
                        <input type="hidden" name="active" value={w.active ? "0" : "1"} />
                        <SubmitButton variant="ghost" className={SMALL} pendingText="Salvando…">
                          {w.active ? "Desativar" : "Ativar"}
                        </SubmitButton>
                      </form>
                      <form action={testWebhookAction}>
                        <input type="hidden" name="id" value={w.id} />
                        <SubmitButton variant="ghost" className={SMALL} pendingText="Testando…">
                          Testar
                        </SubmitButton>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
          <p className="text-xs text-muted">
            Saúde: entregas confirmadas entre as últimas 100 de cada webhook (as que estão na fila não contam). &ldquo;Testar&rdquo; manda um
            evento <code>webhook.test</code> assinado só para aquele webhook, mesmo desativado.
          </p>
        </div>
      </div>
    </div>
  );
}

function SecurityTab({ keys }: { keys: KeyRow[] }) {
  return (
    <div className="space-y-6">
      {keys.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            Nenhuma chave ativa.{" "}
            <Link href={PAGE} className="font-semibold text-brand hover:underline">
              Crie uma chave
            </Link>{" "}
            para restringir por IP.
          </p>
        </Card>
      ) : (
        keys.map((k) => {
          const n = k.ipAllowlist.length;
          return (
            <Card key={k.id} className="space-y-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="text-lg">{k.name}</h2>
                <code className="text-xs text-muted">{k.prefix}…</code>
              </div>
              {n ? (
                <Alert tone="ok">
                  <strong>Restrição por IP ativa.</strong> A API só aceita esta chave vinda {n === 1 ? "do IP ou faixa" : `de um dos ${n} IPs ou faixas`} da
                  lista.
                </Alert>
              ) : (
                <Alert tone="info">
                  <strong>Sem restrição por IP.</strong> Esta chave é aceita de qualquer origem. Adicione IPs ou faixas para restringir.
                </Alert>
              )}
              <div className="grid gap-6 lg:grid-cols-2">
                <AllowlistForm id={k.id} entries={k.ipAllowlist} />
                <IpTestForm id={k.id} />
              </div>
            </Card>
          );
        })
      )}
      <p className="text-sm text-muted">
        A restrição vale só para chamadas da API feitas com a chave. O painel nunca é bloqueado por ela: você não corre risco de perder o
        acesso.
      </p>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-bold tabular-nums text-ink">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}

/** Confirmação sem JavaScript: o botão abre o aviso com a ação de verdade (que o servidor re-checa de qualquer jeito). */
function Confirm({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <details className={className}>
      <summary className={buttonClass("ghost", `${SMALL} cursor-pointer list-none [&::-webkit-details-marker]:hidden`)}>{label}</summary>
      <div className="mt-2 min-w-56 space-y-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-left text-sm text-red-900">{children}</div>
    </details>
  );
}
