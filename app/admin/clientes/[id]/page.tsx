import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { ActionForm } from "@/app/components/ui/action-form";
import { Card } from "@/app/components/ui/card";
import { Input, Select } from "@/app/components/ui/field";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { feeText } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { type Perm, pode } from "@/lib/auth/perms";
import { formatCnpj, maskDocument, SEGMENT_LABELS, type Segment } from "@/lib/br/documents";
import { brl, dateTime } from "@/lib/br/money";
import { decrypt } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { merchants, users } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { getBalance } from "@/lib/money/ledger";
import { feeChangeNeedsApproval } from "@/lib/services/admin/approvals";
import { CodeInput } from "../../equipe/forms";
import { percent, reais } from "../../format";
import { listChargesAdmin, listPayoutsAdmin } from "../../queries";
import { merchantStatusAction, requestBalanceAdjustmentAction, updateFeesAction } from "../actions";
import { OpButton } from "../op-button";

export const metadata: Metadata = { title: "Cliente — Admin Vantri" };

const RECENT = 10;

export default async function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireAdmin({ perm: "clientes:ler" });
  // Só mostra o que o papel pode fazer; a action re-checa a mesma permissão no servidor.
  const can = (perm: Perm) => pode(user.adminRole, perm);
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

  const manualReview = m.needsManualReview && m.status === "pending";
  const feesNeedApproval = feeChangeNeedsApproval(m);
  // CNPJ completo só em revisão manual (pendente): o admin precisa dele para conferir na Receita. Fora disso, mascarado.
  const fullCnpj = manualReview && m.documentType === "cnpj";
  let document: string;
  try {
    const raw = decrypt(m.documentEnc);
    document = fullCnpj ? formatCnpj(raw) : maskDocument(raw);
  } catch (e) {
    logError("admin: documento do cliente ilegível", e, { merchant: id });
    document = "não foi possível ler";
  }

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
              {fullCnpj && <span className="block text-xs text-muted">Completo enquanto o cadastro está em revisão manual.</span>}
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
          {can("clientes:cadastro") ? (
            <StatusActions id={m.id} status={m.status} manualReview={manualReview} />
          ) : (
            <p className="mt-3 text-sm text-muted">Seu papel só consulta o status do cliente.</p>
          )}
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
          {can("dinheiro:mover") && <AdjustBalance merchantId={m.id} />}
        </Card>

        <Card>
          <h2 className="text-lg">Taxas</h2>
          {can("taxas:editar") ? (
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
              {feesNeedApproval && (
                <>
                  <p className="rounded-xl bg-accent/40 px-3 py-2 text-xs font-semibold text-ink sm:col-span-2">
                    Os termos prometem aviso com 30 dias de antecedência antes de mudar a tarifa de um cliente ativo:
                    avise o cliente antes de pedir. A mudança vira pedido de quatro olhos e só vale quando outro
                    administrador aprovar em Aprovações.
                  </p>
                  <div className="sm:col-span-2">
                    <Input label="Motivo" name="reason" id="taxa-motivo" required minLength={3} maxLength={500} />
                  </div>
                  <div className="sm:col-span-2">
                    <CodeInput id="taxa-codigo" />
                  </div>
                </>
              )}
              <div className="sm:col-span-2">
                {feesNeedApproval ? (
                  <SubmitButton pendingText="Enviando…">Pedir mudança de taxa</SubmitButton>
                ) : (
                  <SubmitButton pendingText="Salvando…">Salvar taxas</SubmitButton>
                )}
              </div>
            </ActionForm>
          ) : (
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
              <Row label="Pix recebido">{feeText(m.feeInBps, m.feeInFixedCents)}</Row>
              <Row label="Pix enviado">{feeText(m.feeOutBps, m.feeOutFixedCents)}</Row>
            </dl>
          )}
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
                A Receita não respondeu no cadastro: o CNPJ não foi conferido. Ao aprovar, consultamos de novo e, se a
                Receita responder, as regras valem na hora (CNPJ ativo, nenhum CNAE de apostas). Se continuar fora do ar,
                confira o CNPJ completo acima na Receita: ativo e nenhum CNAE (principal ou secundário) começando com 9200.
              </p>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-bg/60 p-4 text-sm">
                <input type="checkbox" name="manualCheck" value="sim" className="mt-0.5 size-5 shrink-0 accent-brand" />
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
      {status === "suspended" && (
        <>
          <p className="text-sm text-muted">
            Reativar é quatro olhos: vira pedido e o cliente só volta a ativo quando outro administrador aprovar em
            Aprovações.
          </p>
          <Input label="Motivo da reativação" name="reason" id="status-motivo" required minLength={3} maxLength={500} />
          <CodeInput id="status-codigo" />
          <OpButton op="reactivate">Pedir reativação</OpButton>
        </>
      )}
    </ActionForm>
  );
}

/** "Ajustar saldo": crédito ou débito no disponível, como pedido de quatro olhos (nada muda até outro admin aprovar). */
function AdjustBalance({ merchantId }: { merchantId: string }) {
  return (
    <details className="group mt-6 border-t border-line pt-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold [&::-webkit-details-marker]:hidden">
        Ajustar saldo
        <span aria-hidden className="text-xl leading-none text-muted transition-transform group-open:rotate-45">
          +
        </span>
      </summary>
      <ActionForm action={requestBalanceAdjustmentAction} className="mt-4 space-y-4">
        <input type="hidden" name="merchantId" value={merchantId} />
        <p className="text-xs leading-relaxed text-muted">
          Vira um pedido: o saldo só muda quando outro administrador aprovar em Aprovações. Débito que deixaria o
          disponível negativo é recusado na aprovação. Nada é apagado: o ajuste é um lançamento novo no extrato.
        </p>
        <Select label="Tipo" name="direction" id="ajuste-tipo">
          <option value="credito">Crédito (soma ao disponível)</option>
          <option value="debito">Débito (tira do disponível)</option>
        </Select>
        <Input label="Valor (R$)" name="amount" id="ajuste-valor" inputMode="decimal" required maxLength={16} />
        <Input
          label="Motivo"
          name="reason"
          id="ajuste-motivo"
          required
          minLength={3}
          maxLength={500}
          hint="Fica no pedido e na auditoria. Não escreva dados pessoais (documento, chave Pix)."
        />
        <CodeInput id="ajuste-codigo" />
        <SubmitButton pendingText="Enviando…">Pedir ajuste</SubmitButton>
      </ActionForm>
    </details>
  );
}
