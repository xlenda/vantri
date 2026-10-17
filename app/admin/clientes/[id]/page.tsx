import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { ActionForm } from "@/app/components/ui/action-form";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/field";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { requireUser } from "@/lib/auth/guards";
import { maskDocument, SEGMENT_LABELS, type Segment } from "@/lib/br/documents";
import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { merchants, users } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { getBalance } from "@/lib/money/ledger";
import { brl, dateTime, percent, reais } from "../../format";
import { listChargesAdmin, listPayoutsAdmin } from "../../queries";
import { merchantStatusAction, updateFeesAction } from "../actions";
import { OpButton } from "../op-button";

export const metadata: Metadata = { title: "Cliente — Admin Vantri" };

const RECENT = 10;

export default async function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser({ role: "admin" });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [m] = await db().select().from(merchants).where(eq(merchants.id, id));
  if (!m) notFound();

  const [logins, balance, recentCharges, recentPayouts] = await Promise.all([
    db().select({ email: users.email }).from(users).where(eq(users.merchantId, id)).orderBy(asc(users.createdAt)),
    getBalance(id),
    listChargesAdmin({ merchantId: id, page: 1 }, RECENT),
    listPayoutsAdmin({ merchantId: id, page: 1 }, RECENT),
  ]);

  let document: string;
  try {
    document = maskDocument(decrypt(m.documentEnc));
  } catch (e) {
    logError("admin: documento do cliente ilegível", e, { merchant: id });
    document = "não foi possível ler";
  }
  const manualReview = m.needsManualReview && m.status === "pending";

  return (
    <>
      <Link href="/admin/clientes" className="text-sm font-semibold text-muted hover:text-ink">
        ← Clientes
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 break-words text-2xl sm:text-3xl">{m.tradeName}</h1>
        <StatusBadge kind="merchant" status={m.status} />
        {manualReview && <Badge tone="warn">revisão manual</Badge>}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card>
          <h2 className="text-lg">Dados</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <Row label={m.documentType === "cpf" ? "Nome completo" : "Razão social"}>{m.legalName}</Row>
            <Row label={m.documentType.toUpperCase()}>
              <span className="font-mono">{document}</span>
            </Row>
            <Row label="Segmento">{SEGMENT_LABELS[m.segment as Segment] ?? m.segment}</Row>
            <Row label="Acesso">{logins.map((u) => u.email).join(", ") || "—"}</Row>
            <Row label="Cadastro">{dateTime(m.createdAt)}</Row>
            <Row label="Aprovação">{m.approvedAt ? dateTime(m.approvedAt) : "—"}</Row>
            <Row label="Conta no parceiro">
              <span className="font-mono text-xs">{m.providerAccountId ?? "—"}</span>
            </Row>
          </dl>
        </Card>

        <Card>
          <h2 className="text-lg">Status</h2>
          <StatusActions id={m.id} status={m.status} manualReview={manualReview} />
        </Card>

        <Card>
          <h2 className="text-lg">Saldo</h2>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            {(
              [
                ["Disponível", balance.available],
                ["Bloqueado", balance.blocked],
                ["Total", balance.total],
              ] as const
            ).map(([label, cents]) => (
              <div key={label}>
                <dt className="text-xs font-semibold text-muted">{label}</dt>
                <dd className="mt-1 text-base font-bold tabular-nums sm:text-lg">{brl(cents)}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <h2 className="text-lg">Taxas</h2>
          <ActionForm action={updateFeesAction} className="mt-4 grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="merchantId" value={m.id} />
            <FeePair
              legend="Pix recebido (por cobrança paga)"
              pct={["feeInPercent", percent(m.feeInBps)]}
              fixed={["feeInFixed", reais(m.feeInFixedCents)]}
            />
            <FeePair
              legend="Pix enviado (por saque)"
              pct={["feeOutPercent", percent(m.feeOutBps)]}
              fixed={["feeOutFixed", reais(m.feeOutFixedCents)]}
            />
            <p className="text-xs text-muted sm:col-span-2">
              Percentual de 0 a 100 com até 2 casas; fixo de R$ 0,00 a R$ 1.000,00. Vale para as próximas transações.
            </p>
            <div className="sm:col-span-2">
              <SubmitButton pendingText="Salvando…">Salvar taxas</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg">Últimas cobranças</h2>
          <Link href={`/admin/transacoes?tipo=cobrancas&cliente=${m.id}`} className="text-sm font-semibold text-brand">
            Ver todas
          </Link>
        </div>
        <div className="mt-3">
          <Table caption="Últimas cobranças" columns={["Criada em", "Valor", "Taxa", "Status"]} empty="Nenhuma cobrança.">
            {recentCharges.rows.map(({ charge: c }) => (
              <tr key={c.id}>
                <td className="whitespace-nowrap">{dateTime(c.createdAt)}</td>
                <td className="tabular-nums">{brl(c.amountCents)}</td>
                <td className="tabular-nums text-muted">{brl(c.feeCents)}</td>
                <td>
                  <StatusBadge kind="charge" status={c.status} />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg">Últimos saques</h2>
          <Link href={`/admin/transacoes?tipo=saques&cliente=${m.id}`} className="text-sm font-semibold text-brand">
            Ver todos
          </Link>
        </div>
        <div className="mt-3">
          <Table caption="Últimos saques" columns={["Pedido em", "Valor", "Taxa", "Status"]} empty="Nenhum saque.">
            {recentPayouts.rows.map(({ payout: p }) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap">{dateTime(p.createdAt)}</td>
                <td className="tabular-nums">{brl(p.amountCents)}</td>
                <td className="tabular-nums text-muted">{brl(p.feeCents)}</td>
                <td>
                  <StatusBadge kind="payout" status={p.status} />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </section>
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

function FeePair({ legend, pct, fixed }: { legend: string; pct: [string, string]; fixed: [string, string] }) {
  return (
    <fieldset className="grid grid-cols-2 gap-3 sm:col-span-2">
      <legend className="mb-2 text-sm font-semibold">{legend}</legend>
      <Input label="Percentual (%)" name={pct[0]} defaultValue={pct[1]} inputMode="decimal" required maxLength={8} />
      <Input label="Fixo (R$)" name={fixed[0]} defaultValue={fixed[1]} inputMode="decimal" required maxLength={12} />
    </fieldset>
  );
}

// Um formulário só por cartão (a ação vem do botão): ao mudar o status ele continua montado e mostra a resposta.
function StatusActions({
  id,
  status,
  manualReview,
}: {
  id: string;
  status: (typeof merchants.$inferSelect)["status"];
  manualReview: boolean;
}) {
  if (status === "rejected") return <p className="mt-3 text-sm text-muted">Cadastro recusado. Não há ação disponível.</p>;
  return (
    <ActionForm action={merchantStatusAction} className="mt-4 space-y-3">
      <input type="hidden" name="merchantId" value={id} />
      {status === "pending" && (
        <>
          {manualReview && (
            <>
              <p className="text-sm leading-relaxed text-muted">
                A Receita não respondeu no cadastro: o CNPJ não foi conferido. Antes de aprovar, confira se está ativo e
                se nenhum CNAE (principal ou secundário) começa com 9200 (apostas).
              </p>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-bg/60 p-4 text-sm">
                <input type="checkbox" name="manualCheck" value="sim" required className="mt-0.5 size-5 shrink-0 accent-brand" />
                <span className="font-semibold">Conferi o CNPJ e o CNAE manualmente</span>
              </label>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <OpButton op="approve">Aprovar e abrir conta</OpButton>
            <OpButton op="reject" variant="ghost" skipValidation>
              Recusar cadastro
            </OpButton>
          </div>
        </>
      )}
      {status === "active" && (
        <>
          <p className="text-sm text-muted">Suspenso, o cliente perde o acesso na hora e a API para de aceitar pedidos.</p>
          <OpButton op="suspend" variant="ghost">
            Suspender
          </OpButton>
        </>
      )}
      {status === "suspended" && <OpButton op="reactivate">Reativar</OpButton>}
    </ActionForm>
  );
}
