import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { CopyButton } from "@/app/components/ui/copy-button";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { dateTime as dataHora } from "@/lib/br/money";
import { getDeliveryForMerchant } from "@/lib/webhooks/attempts";
import { painelSession } from "../../../lib";
import { resendDeliveryAction } from "../../actions";
import { endpointName, eventLabel } from "../../labels";

export const metadata: Metadata = { title: "Entrega de webhook — Vantri" };

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v} ms`);

/** Inspetor de uma entrega: o que foi enviado (sem segredo nem cabeçalhos), a resposta e cada tentativa. */
export default async function EntregaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { merchant } = await painelSession();
  const found = await getDeliveryForMerchant(merchant.id, (await params).id); // de outro lojista → null
  if (!found) notFound();
  const { delivery: d, endpoint, attempts } = found;
  const sp = await searchParams;
  const body = JSON.stringify(d.payload, null, 2);
  // Entrega de antes do histórico de tentativas: resta o resumo gravado na própria entrega.
  const last =
    attempts.at(-1) ??
    (d.attempts ? { statusCode: d.lastStatusCode, latencyMs: null, error: d.lastError, responseSnippet: null } : undefined);
  const queued = d.status === "pending" && d.attempts === 0;

  return (
    <div className="space-y-6">
      <Link href="/painel/integracoes/entregas" className="text-sm font-semibold text-brand hover:underline">
        ← Entregas
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Inspetor de entrega</p>
          <h1 className="mt-1 text-2xl sm:text-3xl">{eventLabel(d.eventType)}</h1>
          <p className="mt-1 break-all text-sm text-muted">
            <code>{d.eventType}</code> · {endpointName(endpoint)}
          </p>
        </div>
        <StatusBadge kind="delivery" status={d.status} />
      </header>

      {sp.ok === "reenviada" && (
        <Alert tone="ok">Entrega colocada na fila de novo. Ela sai em instantes; recarregue para ver a nova tentativa.</Alert>
      )}
      {d.status === "pending" && (
        <Alert tone="info">
          {queued ? "Na fila para o primeiro envio." : `Próxima tentativa agendada para ${dataHora(d.nextAttemptAt)}.`}
        </Alert>
      )}

      <Card>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Item label="Tentativas">{d.attempts}</Item>
          <Item label="Último HTTP">{d.lastStatusCode ?? "—"}</Item>
          <Item label="Latência (última tentativa)">{ms(last?.latencyMs)}</Item>
          <Item label="Criada em">{dataHora(d.createdAt)}</Item>
          {d.deliveredAt && <Item label="Entregue em">{dataHora(d.deliveredAt)}</Item>}
          <Item label="ID do evento">
            <code className="text-xs">{d.eventId}</code>
          </Item>
          <Item label="ID da entrega">
            <code className="text-xs">{d.id}</code>
          </Item>
        </dl>
        <div className="mt-6 flex flex-wrap gap-2">
          {!queued && (
            <form action={resendDeliveryAction}>
              <input type="hidden" name="id" value={d.id} />
              <SubmitButton pendingText="Enviando…">Reenviar</SubmitButton>
            </form>
          )}
          <a href={`/painel/integracoes/entregas/${d.id}/json`} download className={buttonClass("ghost")}>
            Baixar JSON
          </a>
        </div>
      </Card>

      <Section title="Requisição enviada">
        <p className="break-all text-sm">
          <code className="font-semibold">POST</code> <code>{endpoint.url}</code>
        </p>
        <p className="mt-2">
          <Badge tone="info">Assinado com HMAC (X-Vantri-Signature)</Badge>
        </p>
        <pre className="mt-4 max-h-96 overflow-auto rounded-xl border border-line bg-bg p-4 text-xs leading-relaxed">{body}</pre>
        <CopyButton text={body} label="Copiar corpo" className="mt-3" />
      </Section>

      <Section title="Resposta do seu endpoint">
        {last ? (
          <>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Item label="HTTP">{last.statusCode ?? "Sem resposta"}</Item>
              <Item label="Latência">{ms(last.latencyMs)}</Item>
              <Item label="Erro">{last.error ? <span className="text-red-700">{last.error}</span> : "—"}</Item>
            </dl>
            {last.responseSnippet && (
              <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-bg p-4 text-xs">
                {last.responseSnippet}
              </pre>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">Sem resposta ainda: a entrega não foi enviada.</p>
        )}
      </Section>

      <Section title="Tentativas">
        {attempts.length ? (
          <ol className="space-y-3">
            {attempts.map((a) => (
              <li key={a.id} className="rounded-xl border border-line px-4 py-3 text-sm">
                <p className="font-semibold">
                  Tentativa {a.n} · {a.statusCode ? `HTTP ${a.statusCode}` : "sem resposta"} · {ms(a.latencyMs)}
                </p>
                <p className="text-xs text-muted">{dataHora(a.createdAt)}</p>
                {a.error && <p className="mt-1 text-red-700">{a.error}</p>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">Nenhuma tentativa registrada.</p>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg">{title}</h2>
      <Card>{children}</Card>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="break-words font-medium text-ink">{children}</dd>
    </div>
  );
}
