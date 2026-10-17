import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { ActionForm } from "@/app/components/ui/action-form";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input, Select } from "@/app/components/ui/field";
import { Badge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { feeText } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, dateTime, parseReais } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";
import { feeHistory, listFeePlans, simulateFee } from "@/lib/services/admin/fee-plans";
import { reais } from "../format";
import { merchantOptions } from "../queries";
import { archiveFeePlanAction, assignFeePlanAction, createFeePlanAction } from "./actions";

export const metadata: Metadata = { title: "Tarifas — Admin Vantri" };

const EXAMPLE_SALE = 19_700; // R$ 197,00: a venda de exemplo do simulador

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const fees = (p: { feeInBps: number; feeInFixedCents: number; feeOutBps: number; feeOutFixedCents: number }) =>
  `recebido ${feeText(p.feeInBps, p.feeInFixedCents)} · enviado ${feeText(p.feeOutBps, p.feeOutFixedCents)}`;
// Taxa atual do cliente do histórico (antes da 1ª mudança registrada, é a do cadastro).
const CURRENT_FEES = {
  tradeName: merchants.tradeName,
  feeInBps: merchants.feeInBps,
  feeInFixedCents: merchants.feeInFixedCents,
  feeOutBps: merchants.feeOutBps,
  feeOutFixedCents: merchants.feeOutFixedCents,
};

export default async function TarifasPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAdmin({ perm: "tarifas:gerir" });
  const sp = await searchParams;
  const sale = parseReais(first(sp.valor) ?? "") || EXAMPLE_SALE; // inválido ou zero: volta ao exemplo
  const merchantId = z.uuid().safeParse(first(sp.cliente)).data;
  const [plans, clients, [current], history] = await Promise.all([
    listFeePlans(),
    merchantOptions(),
    merchantId ? db().select(CURRENT_FEES).from(merchants).where(eq(merchants.id, merchantId)) : [],
    merchantId ? feeHistory(merchantId) : [],
  ]);
  const active = plans.filter((p) => !p.archivedAt);
  const archived = plans.filter((p) => p.archivedAt);
  const clientOptions = clients.map((c) => (
    <option key={c.id} value={c.id}>
      {c.tradeName}
    </option>
  ));

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Tarifas</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Planos nomeados para aplicar a vários clientes. A taxa personalizada continua na página de cada cliente. Toda
        mudança, por plano ou não, entra no histórico com a data de vigência.
      </p>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg">Planos</h2>
          <form method="get" action="/admin/tarifas" className="flex items-end gap-2">
            {merchantId && <input type="hidden" name="cliente" value={merchantId} />}
            <div className="w-40">
              <Input label="Simular venda de (R$)" name="valor" defaultValue={reais(sale)} inputMode="decimal" maxLength={16} />
            </div>
            <button type="submit" className={buttonClass("ghost")}>
              Simular
            </button>
          </form>
        </div>
        <div className="mt-3">
          <Table
            caption="Planos de tarifa"
            columns={["Plano", "Pix recebido", "Pix enviado", `Lojista recebe de ${brl(sale)}`, ""]}
            empty="Nenhum plano ainda. Crie o primeiro abaixo."
          >
            {active.map((p) => {
              const net = simulateFee(sale, p);
              return (
                <tr key={p.id}>
                  <td className="font-semibold">{p.name}</td>
                  <td>{feeText(p.feeInBps, p.feeInFixedCents)}</td>
                  <td>{feeText(p.feeOutBps, p.feeOutFixedCents)}</td>
                  <td className="tabular-nums">{net > 0 ? brl(net) : <span className="text-muted">não cobre a tarifa</span>}</td>
                  <td>
                    <ActionForm action={archiveFeePlanAction}>
                      <input type="hidden" name="planId" value={p.id} />
                      <SubmitButton variant="ghost" pendingText="Arquivando…">
                        Arquivar
                      </SubmitButton>
                    </ActionForm>
                  </td>
                </tr>
              );
            })}
          </Table>
        </div>
        {archived.length > 0 && (
          <details className="mt-3 rounded-2xl border border-line bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Arquivados ({archived.length})</summary>
            <ul className="divide-y divide-line border-t border-line text-sm">
              {archived.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-muted">
                    {fees(p)} · arquivado em {p.archivedAt && dateTime(p.archivedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card>
          <h2 className="text-lg">Novo plano</h2>
          <ActionForm action={createFeePlanAction} className="mt-4 grid gap-4">
            <Input label="Nome do plano" name="name" required minLength={2} maxLength={60} placeholder="Ex.: Padrão" />
            <FeePair legend="Pix recebido (por cobrança paga)" pct="feeInPercent" fixed="feeInFixed" values={["1,49", "0,00"]} />
            <FeePair legend="Pix enviado (por saque)" pct="feeOutPercent" fixed="feeOutFixed" values={["0,00", "1,00"]} />
            <p className="text-xs text-muted">
              Percentual de 0 a 100 com até 2 casas; fixo de R$ 0,00 a R$ 1.000,00. O plano não muda depois de criado:
              para outra taxa, crie outro e arquive este.
            </p>
            <div>
              <SubmitButton pendingText="Criando…">Criar plano</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <Card>
          <h2 className="text-lg">Aplicar plano a um cliente</h2>
          {active.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Crie um plano primeiro.</p>
          ) : (
            <ActionForm action={assignFeePlanAction} className="mt-4 grid gap-4">
              <Select label="Cliente" name="merchantId" required defaultValue={merchantId ?? ""}>
                <option value="" disabled>
                  Escolha o cliente
                </option>
                {clientOptions}
              </Select>
              <Select label="Plano" name="planId" required defaultValue="">
                <option value="" disabled>
                  Escolha o plano
                </option>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {fees(p)}
                  </option>
                ))}
              </Select>
              <p className="rounded-xl bg-accent/40 px-3 py-2 text-xs font-semibold text-ink">
                Os termos prometem aviso com 30 dias de antecedência antes de mudar a tarifa de um cliente ativo: avise o
                cliente antes. Cliente que está ou já esteve ativo vira pedido de quatro olhos (motivo e código abaixo) e
                só muda quando outro administrador aprovar em Aprovações.
              </p>
              <Input label="Motivo (cliente ativo)" name="reason" id="plano-motivo" maxLength={500} />
              <Input
                label="Seu código do app autenticador (cliente ativo)"
                name="code"
                id="plano-codigo"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                className="font-semibold tracking-[0.3em]"
              />
              <p className="text-xs text-muted">
                As 4 taxas do plano substituem as do cliente e valem para as próximas transações.
              </p>
              <div>
                <SubmitButton pendingText="Aplicando…">Aplicar plano</SubmitButton>
              </div>
            </ActionForm>
          )}
        </Card>
      </div>

      <section className="mt-10">
        <h2 className="text-lg">Histórico por cliente</h2>
        <form
          method="get"
          action="/admin/tarifas"
          className="mt-3 grid gap-3 rounded-3xl border border-line bg-white p-5 sm:grid-cols-[1fr_auto] sm:items-end"
        >
          {first(sp.valor) && <input type="hidden" name="valor" value={reais(sale)} />}
          <Select label="Cliente" name="cliente" defaultValue={merchantId ?? ""}>
            <option value="">Escolha o cliente</option>
            {clientOptions}
          </Select>
          <button type="submit" className={buttonClass("primary")}>
            Ver histórico
          </button>
        </form>
        {merchantId &&
          (current ? (
            <History merchantId={merchantId} m={current} rows={history} />
          ) : (
            <p className="mt-4 text-sm text-muted">Cliente não encontrado.</p>
          ))}
      </section>
    </>
  );
}

function History({
  merchantId,
  m,
  rows,
}: {
  merchantId: string;
  m: Parameters<typeof fees>[0] & { tradeName: string };
  rows: Awaited<ReturnType<typeof feeHistory>>;
}) {
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm">
          <Link href={`/admin/clientes/${merchantId}`} className="font-semibold text-brand hover:underline">
            {m.tradeName}
          </Link>{" "}
          — taxa atual: {fees(m)}
        </p>
        {/* <a>, não <Link>: é um download (route handler), não uma página. */}
        <a href={`/admin/tarifas/export?cliente=${merchantId}`} className={buttonClass("ghost")}>
          Exportar CSV
        </a>
      </div>
      <div className="mt-3">
        <Table
          caption="Histórico de taxas"
          columns={["Vigente desde", "Pix recebido", "Pix enviado", "Plano", "Alterado por"]}
          empty="Nenhuma mudança registrada: a taxa atual é a do cadastro."
        >
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">
                {dateTime(r.effectiveFrom)} {i === 0 && <Badge tone="ok">vigente</Badge>}
              </td>
              <td>{feeText(r.feeInBps, r.feeInFixedCents)}</td>
              <td>{feeText(r.feeOutBps, r.feeOutFixedCents)}</td>
              <td>{r.planName ?? <span className="text-muted">Personalizada</span>}</td>
              <td className="text-muted">{r.actorEmail ?? "—"}</td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

function FeePair({ legend, pct, fixed, values }: { legend: string; pct: string; fixed: string; values: [string, string] }) {
  return (
    <fieldset className="grid grid-cols-2 gap-3">
      <legend className="mb-2 text-sm font-semibold">{legend}</legend>
      <Input label="Percentual (%)" name={pct} defaultValue={values[0]} inputMode="decimal" required maxLength={8} />
      <Input label="Fixo (R$)" name={fixed} defaultValue={values[1]} inputMode="decimal" required maxLength={12} />
    </fieldset>
  );
}
