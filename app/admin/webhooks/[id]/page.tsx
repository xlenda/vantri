import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ActionForm } from "@/app/components/ui/action-form";
import { Card } from "@/app/components/ui/card";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { dateTime } from "@/lib/br/money";
import { disableEndpointAction, resendOneAction } from "../actions";
import { deliveryDetail, eventName } from "../monitor";

export const metadata: Metadata = { title: "Entrega de webhook — Admin Vantri" };

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin({ perm: "webhooks:operar" });
  const det = await deliveryDetail((await params).id);
  if (!det) notFound();
  const { delivery: x, attempts } = det;

  return (
    <>
      <Link href="/admin/webhooks" className="text-sm font-semibold text-brand hover:underline">
        ← Webhooks
      </Link>
      <h1 className="mt-2 text-2xl sm:text-3xl">{eventName(x.eventType)}</h1>
      <p className="mt-1 break-all font-mono text-xs text-muted">{x.eventId}</p>

      <Card className="mt-6">
        <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Item label="Status">
            <StatusBadge kind="delivery" status={x.status} />
          </Item>
          <Item label="Cliente">
            <Link href={`/admin/clientes/${det.merchantId}`} className="font-semibold text-brand hover:underline">
              {det.tradeName}
            </Link>
          </Item>
          <Item label="Endpoint">
            <span className="break-all font-mono text-xs">{det.url}</span>{" "}
            {!det.endpointActive && <Badge>Desativado</Badge>}
          </Item>
          <Item label="Criada em">{dateTime(x.createdAt)}</Item>
          <Item label="Entregue em">{x.deliveredAt ? dateTime(x.deliveredAt) : "—"}</Item>
          <Item label={x.status === "pending" ? "Próxima tentativa" : "Tentativas"}>
            {x.status === "pending" ? dateTime(x.nextAttemptAt) : x.attempts}
          </Item>
        </dl>

        {det.endpointActive ? (
          <div className="mt-6 flex flex-wrap items-start gap-3 border-t border-line pt-5">
            <ActionForm action={resendOneAction}>
              <input type="hidden" name="id" value={x.id} />
              <SubmitButton pendingText="Reenviando…">Reenviar</SubmitButton>
            </ActionForm>
            <ActionForm action={disableEndpointAction}>
              <input type="hidden" name="id" value={x.endpointId} />
              <SubmitButton variant="ghost" pendingText="Desativando…">
                Desativar endpoint
              </SubmitButton>
            </ActionForm>
          </div>
        ) : (
          <p className="mt-6 border-t border-line pt-5 text-sm text-muted">
            Endpoint desativado: não recebe eventos novos nem reenvio até o cliente reativá-lo no painel dele.
          </p>
        )}
      </Card>

      <h2 className="mt-10 text-lg">Tentativas</h2>
      <div className="mt-3">
        <Table
          caption="Tentativas de entrega"
          columns={["#", "Hora", "HTTP", "Latência", "Resultado"]}
          empty="Nenhuma tentativa ainda: a entrega está na fila."
        >
          {attempts.map((a) => (
            <tr key={a.n}>
              <td className="tabular-nums">{a.n}</td>
              <td className="whitespace-nowrap">{dateTime(a.createdAt)}</td>
              <td className="tabular-nums">{a.statusCode ?? "—"}</td>
              <td className="tabular-nums">{a.latencyMs === null ? "—" : `${a.latencyMs} ms`}</td>
              <td>{a.error === null ? <Badge tone="ok">Entregue</Badge> : <Badge tone="bad">{a.error}</Badge>}</td>
            </tr>
          ))}
        </Table>
      </div>

      <h2 className="mt-10 text-lg">Conteúdo enviado</h2>
      <p className="mt-1 text-sm text-muted">O corpo do POST, como o cliente recebe (só leitura).</p>
      <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded-2xl border border-line bg-white p-4 font-mono text-xs leading-relaxed">
        {JSON.stringify(x.payload, null, 2)}
      </pre>
    </>
  );
}
