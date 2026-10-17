import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ActionForm } from "@/app/components/ui/action-form";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/field";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { failureReason, maskPixKey } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, dateTime } from "@/lib/br/money";
import { actionLabel } from "@/lib/services/admin/audit";
import { ageText, type PayoutEvent, payoutDetail } from "@/lib/services/admin/payouts-ops";
import { toPayoutJson } from "@/lib/services/payouts";
import { CodeInput } from "../../equipe/forms";
import { pode } from "../../perms-ui";
import { STUCK_PAYOUT_MIN } from "../../queries";
import { KEY_TYPES, STATUS_LABEL } from "../../transacoes/lib";
import { repollPayoutAction, requestPayoutReversalAction } from "../actions";

export const metadata: Metadata = { title: "Saque — Admin Vantri" };

type Item = { at: Date; label: string; who: string; detail?: string };

/** O que a linha do audit_log acrescenta: o resultado da consulta, o motivo do pedido, o valor devolvido. */
function detail(e: PayoutEvent): string | undefined {
  const m = (e.meta ?? {}) as Record<string, unknown>;
  if ((e.action === "payout.repoll" || e.action === "payout.resend") && typeof m.status === "string") {
    return `Resultado: ${STATUS_LABEL.saques[m.status as keyof typeof STATUS_LABEL.saques] ?? m.status}`;
  }
  if (typeof m.reason === "string") return `Motivo: ${m.reason}`;
  if (e.action === "payout.force_fail" && typeof m.amountCents === "number") {
    return `Devolvidos ao saldo do cliente: ${brl(m.amountCents)} (valor + tarifa)`;
  }
  return undefined;
}

export default async function SaquePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireAdmin({ perm: "transacoes:ler" });
  const d = await payoutDetail((await params).id);
  if (!d) notFound();
  const { payout: p } = d;
  // Só mostra/esconde; cada ação re-checa a permissão no servidor.
  const canOperate = pode(user.adminRole, "saques:operar");
  const canReverse = pode(user.adminRole, "dinheiro:mover");
  const processing = p.status === "processing";
  const age = Math.max(0, Math.floor((Date.now() - p.createdAt.getTime()) / 60_000));

  // Pedido e conclusão vêm do próprio saque; o resto, do audit_log. sort é estável: empate mantém a ordem.
  const items: Item[] = [
    { at: p.createdAt, label: "Saque pedido", who: "Cliente" },
    ...d.events.map((e) => ({
      at: e.createdAt,
      label: actionLabel(e.action),
      who: e.actorEmail ?? "Sistema (cron)",
      detail: detail(e),
    })),
    ...(p.completedAt ? [{ at: p.completedAt, label: "Concluído no parceiro", who: "Parceiro" }] : []),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  // O que a API e o webhook entregam ao cliente, com a chave mascarada. O retorno cru do parceiro não é guardado.
  const payload = { ...toPayoutJson(p), pix_key: maskPixKey(p.pixKeyType, p.pixKey) };

  return (
    <>
      <Link href="/admin/saques" className="text-sm font-semibold text-muted hover:text-ink">
        ← Saques
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl tabular-nums sm:text-3xl">Saque de {brl(p.amountCents)}</h1>
        <StatusBadge kind="payout" status={p.status} />
        {processing && age > STUCK_PAYOUT_MIN && <Badge tone="bad">preso há {ageText(age)}</Badge>}
      </div>

      {/* grid-cols-1 (minmax(0,1fr)): sem ele, no celular o <pre> do payload alargava a coluna além da tela. */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Card>
          <h2 className="text-lg">Saque</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <Row label="Cliente">
              <Link href={`/admin/clientes/${p.merchantId}`} className="font-semibold text-brand hover:underline">
                {d.tradeName}
              </Link>
            </Row>
            <Row label="Valor">
              <span className="tabular-nums">{brl(p.amountCents)}</span>
              <span className="block text-xs text-muted">Tarifa {brl(p.feeCents)}</span>
            </Row>
            <Row label={`Chave Pix (${KEY_TYPES[p.pixKeyType]})`}>
              <span className="break-all font-mono text-xs">{maskPixKey(p.pixKeyType, p.pixKey)}</span>
            </Row>
            <Row label="Pedido em">
              {dateTime(p.createdAt)}
              {processing && <span className="block text-xs text-muted">há {ageText(age)} em processamento</span>}
            </Row>
            {p.completedAt && <Row label="Concluído em">{dateTime(p.completedAt)}</Row>}
            {p.status === "failed" && (
              <Row label="Falha">
                {failureReason(p.failureCode)}
                {p.failureCode && <span className="block font-mono text-xs text-muted">{p.failureCode}</span>}
              </Row>
            )}
            <Row label="ID do saque">
              <span className="break-all font-mono text-xs">{p.id}</span>
            </Row>
          </dl>
        </Card>

        <Card>
          <h2 className="text-lg">No parceiro</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <Row label="ID no parceiro">
              {p.providerPayoutId ? (
                <span className="break-all font-mono text-xs">{p.providerPayoutId}</span>
              ) : (
                <span className="text-muted">
                  Ainda sem id: o envio original não chegou ao parceiro. O cron reenvia com a mesma chave de idempotência.
                </span>
              )}
            </Row>
            <Row label="E2E">
              <span className="break-all font-mono text-xs">{p.endToEndId ?? "—"}</span>
            </Row>
          </dl>

          {processing && (canOperate || canReverse) && (
            <div className="mt-6 space-y-6 border-t border-line pt-6">
              {canOperate && (
                <ActionForm action={repollPayoutAction} className="space-y-3">
                  <input type="hidden" name="payoutId" value={p.id} />
                  <CodeInput id="codigo-consulta" />
                  <SubmitButton pendingText="Consultando…">
                    {p.providerPayoutId ? "Consultar no parceiro agora" : "Reenviar ao parceiro"}
                  </SubmitButton>
                </ActionForm>
              )}
              {canReverse && (
                <ActionForm action={requestPayoutReversalAction} className="space-y-3 border-t border-line pt-6">
                  <input type="hidden" name="payoutId" value={p.id} />
                  <Input
                    label="Motivo"
                    name="reason"
                    id="motivo-estorno"
                    required
                    minLength={3}
                    maxLength={500}
                    hint="Vira pedido de quatro olhos: nada muda até outro administrador aprovar. Não escreva dados pessoais."
                  />
                  <CodeInput id="codigo-estorno" />
                  <SubmitButton variant="ghost" pendingText="Enviando…">
                    Marcar como falho e estornar
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="text-lg">Linha do tempo</h2>
          <ol className="mt-4 space-y-5 border-l-2 border-line pl-5">
            {items.map((it, i) => (
              <li key={i} className="relative">
                <span aria-hidden className="absolute -left-[27px] top-1 size-3 rounded-full border-2 border-white bg-brand" />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{it.label}</span>
                  <Badge>{it.who}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">{dateTime(it.at)}</p>
                {it.detail && <p className="mt-1 break-words text-sm">{it.detail}</p>}
              </li>
            ))}
          </ol>
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="text-lg">Payload</h2>
          <p className="mt-2 text-sm text-muted">
            O que a API e o webhook entregam ao cliente, com a chave Pix mascarada. O retorno do parceiro não é guardado.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-2xl bg-bg p-4 text-xs">{JSON.stringify(payload, null, 2)}</pre>
        </Card>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
