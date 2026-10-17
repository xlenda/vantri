import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/app/components/ui/alert";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Card } from "@/app/components/ui/card";
import { Table } from "@/app/components/ui/table";
import { SCOPES } from "@/lib/api/keys";
import { dateTime as dataHora } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { apiKeys, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { MAX_ENDPOINTS, WEBHOOK_EVENT_TYPES } from "@/lib/services/events";
import { EVENT_LABEL, painelSession, SCOPE_LABEL } from "../lib";
import { deleteWebhookAction, resendDeliveryAction, revokeKeyAction } from "./actions";
import { KeyForm, WebhookForm } from "./forms";

export const metadata: Metadata = { title: "Integrações — Vantri" };

const NOTICE: Record<string, ["ok" | "error", string]> = {
  revogada: ["ok", "Chave revogada. Pedidos com ela passam a ser recusados."],
  reenviada: ["ok", "Entrega colocada na fila de novo."],
  removido: ["ok", "Webhook removido. As entregas dele foram apagadas junto."],
  revogar: ["error", "Não foi possível revogar a chave. Recarregue a página e tente de novo."],
  reenviar: ["error", "Não foi possível reenviar a entrega. Recarregue a página e tente de novo."],
  remover: ["error", "Não foi possível remover o webhook. Recarregue a página e tente de novo."],
};

export default async function IntegracoesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const key = String(sp.erro ?? sp.ok ?? "");
  const notice = Object.hasOwn(NOTICE, key) ? NOTICE[key] : undefined; // ?ok=toString não vira aviso
  // Nunca seleciona key_hash nem secret_enc: o segredo só aparece uma vez, na criação.
  const [keys, endpoints, deliveries] = await Promise.all([
    db()
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        ipAllowlist: apiKeys.ipAllowlist,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.merchantId, merchant.id))
      .orderBy(desc(apiKeys.createdAt)),
    db()
      .select({ id: webhookEndpoints.id, url: webhookEndpoints.url, events: webhookEndpoints.events, active: webhookEndpoints.active })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.merchantId, merchant.id))
      .orderBy(desc(webhookEndpoints.createdAt)),
    db()
      .select({
        id: webhookDeliveries.id,
        eventType: webhookDeliveries.eventType,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastStatusCode: webhookDeliveries.lastStatusCode,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        createdAt: webhookDeliveries.createdAt,
        url: webhookEndpoints.url,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookDeliveries.endpointId, webhookEndpoints.id))
      .where(eq(webhookEndpoints.merchantId, merchant.id))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(50), // ponytail: só as 50 últimas; paginar se o lojista precisar de histórico mais antigo
  ]);
  const scopeOptions = SCOPES.map((s) => [s, SCOPE_LABEL[s]] as const);
  const eventOptions = WEBHOOK_EVENT_TYPES.map((e) => [e, EVENT_LABEL[e]] as const);

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">Desenvolvedores</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Integrações</h1>
        <p className="mt-2 text-sm text-muted">
          Chaves para a API e webhooks para o seu sistema saber na hora quando um Pix cai.{" "}
          <Link href="/docs" className="font-semibold text-brand hover:underline">
            Ver a documentação
          </Link>
        </p>
      </header>

      {notice && <Alert tone={notice[0]}>{notice[1]}</Alert>}

      <section aria-labelledby="chaves" className="space-y-4">
        <h2 id="chaves" className="text-lg">
          Chaves de API
        </h2>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <Card className="h-fit">
            <h3 className="mb-4 text-base">Nova chave</h3>
            <KeyForm scopes={scopeOptions} />
          </Card>
          <Table columns={["Nome", "Prefixo", "Escopos", "IPs", "Último uso", ""]} empty="Nenhuma chave criada." caption="Chaves de API">
            {keys.map((k) => (
              <tr key={k.id} className={k.revokedAt ? "text-muted" : undefined}>
                <td className="font-medium">{k.name}</td>
                <td>
                  <code className="whitespace-nowrap text-xs">{k.prefix}…</code>
                </td>
                <td className="text-xs">{k.scopes.join(", ")}</td>
                <td className="text-xs">{k.ipAllowlist.length ? k.ipAllowlist.join(", ") : "Qualquer"}</td>
                <td className="whitespace-nowrap text-xs">{k.lastUsedAt ? dataHora(k.lastUsedAt) : "Nunca"}</td>
                <td className="text-right">
                  {k.revokedAt ? (
                    <Badge>Revogada</Badge>
                  ) : (
                    <form action={revokeKeyAction}>
                      <input type="hidden" name="id" value={k.id} />
                      <SubmitButton variant="ghost" className="!h-9 !px-3.5 text-xs" pendingText="Revogando…">
                        Revogar
                      </SubmitButton>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </section>

      <section aria-labelledby="webhooks" className="space-y-4">
        <h2 id="webhooks" className="text-lg">
          Webhooks
        </h2>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <Card className="h-fit">
            <h3 className="mb-4 text-base">Novo webhook</h3>
            <WebhookForm events={eventOptions} />
            <p className="mt-4 text-xs text-muted">
              Até {MAX_ENDPOINTS} webhooks por conta. Para trocar o segredo, crie um novo e remova o antigo.
            </p>
          </Card>
          <Table columns={["URL", "Eventos", "Situação", ""]} empty="Nenhum webhook criado." caption="Webhooks">
            {endpoints.map((w) => (
              <tr key={w.id}>
                <td className="break-all font-medium">{w.url}</td>
                <td className="text-xs">{w.events.join(", ")}</td>
                <td>{w.active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>}</td>
                <td className="text-right">
                  <form action={deleteWebhookAction}>
                    <input type="hidden" name="id" value={w.id} />
                    <SubmitButton variant="ghost" className="!h-9 !px-3.5 text-xs" pendingText="Removendo…">
                      Remover
                    </SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
          </Table>
        </div>

        <h3 className="pt-2 text-base">Entregas recentes</h3>
        <Table
          columns={["Criada em", "Evento", "URL", "Status", "HTTP", "Tentativas", ""]}
          empty="Nenhuma entrega ainda. Elas aparecem quando acontece um evento assinado."
          caption="Entregas de webhook"
        >
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td className="whitespace-nowrap text-muted">{dataHora(d.createdAt)}</td>
              <td>
                <code className="whitespace-nowrap text-xs">{d.eventType}</code>
              </td>
              <td className="max-w-[14rem] truncate text-xs" title={d.url}>
                {d.url}
              </td>
              <td>
                <StatusBadge kind="delivery" status={d.status} />
                {d.status === "pending" && d.attempts > 0 && (
                  <span className="mt-1 block whitespace-nowrap text-xs text-muted">Nova tentativa {dataHora(d.nextAttemptAt)}</span>
                )}
              </td>
              <td className="tabular-nums">{d.lastStatusCode ?? "—"}</td>
              <td className="tabular-nums">{d.attempts}</td>
              <td className="text-right">
                {!(d.status === "pending" && d.attempts === 0) && (
                  <form action={resendDeliveryAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <SubmitButton variant="ghost" className="!h-9 !px-3.5 text-xs" pendingText="Enviando…">
                      Reenviar
                    </SubmitButton>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}
