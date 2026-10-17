import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import type { ReactNode } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import { type ChargeRow, getCharge, listCharges } from "@/lib/services/charges";
import { CopyField } from "../copy-field";
import { CHARGE_EXPIRY, feeText, painelSession, uuidOrUndefined, withQuery } from "../lib";
import { Pager } from "../pager";
import { simulatePaymentAction } from "./actions";
import { ChargeForm } from "./charge-form";

export const metadata: Metadata = { title: "Cobranças — Vantri" };

type Search = Promise<Record<string, string | string[] | undefined>>;

const FILTERS = [
  [undefined, "Todas"],
  ["pending", "Aguardando"],
  ["paid", "Pagas"],
  ["expired", "Expiradas"],
] as const;
type Status = ChargeRow["status"];

export default async function CobrancasPage({ searchParams }: { searchParams: Search }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const status = FILTERS.find(([s]) => s && s === sp.status)?.[0] as Status | undefined;
  const cursor = uuidOrUndefined(sp.cursor);
  const id = typeof sp.id === "string" ? sp.id : undefined;
  const simulator = process.env.PIX_PROVIDER === "simulator";

  const [selected, list] = await Promise.all([
    id ? getCharge(merchant.id, id) : null, // de outro lojista → null
    listCharges(merchant.id, { status, cursor, limit: 20 }),
  ]);
  const qs = (p: Record<string, string | undefined>) => withQuery("/painel/cobrancas", p);

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Receber</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Cobranças</h1>
      </header>

      {simulator && (
        <Alert tone="info">
          <strong>Ambiente de teste.</strong> As cobranças são do simulador: nenhum dinheiro de verdade entra. Use
          &ldquo;Simular pagamento&rdquo; para ver o fluxo completo.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card className="h-fit">
          <h2 className="text-lg">Nova cobrança</h2>
          <div className="mt-5">
            <ChargeForm expiry={CHARGE_EXPIRY} fee={feeText(merchant.feeInBps, merchant.feeInFixedCents)} />
          </div>
        </Card>

        {id && !selected && <Alert className="order-first h-fit lg:order-none">Cobrança não encontrada.</Alert>}
        {selected && <ChargeView c={selected} simulator={simulator} failed={sp.erro === "simulacao"} />}
      </div>

      <section aria-labelledby="lista" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="lista" className="text-lg">
            Histórico
          </h2>
          <nav aria-label="Filtrar por status" className="flex flex-wrap gap-1.5">
            {FILTERS.map(([s, label]) => (
              <Link
                key={label}
                href={qs({ status: s })}
                aria-current={s === status ? "page" : undefined}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${
                  s === status ? "bg-ink text-white ring-ink" : "bg-white text-muted ring-line hover:text-ink"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <Table columns={["Criada em", "Descrição", "Valor", "Status", ""]} empty="Nenhuma cobrança aqui." caption="Cobranças">
          {list.data.map((c) => (
            <tr key={c.id} className={c.id === selected?.id ? "bg-brand/5" : undefined}>
              <td className="whitespace-nowrap text-muted">{dataHora(c.createdAt)}</td>
              <td className="max-w-[16rem] truncate">{c.description || <span className="text-muted">Sem descrição</span>}</td>
              <td className="whitespace-nowrap font-semibold tabular-nums">{brl(c.amountCents)}</td>
              <td>
                <StatusBadge kind="charge" status={c.status} />
              </td>
              <td className="text-right">
                <Link href={qs({ status, cursor, id: c.id })} className="font-semibold text-brand hover:underline">
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </Table>
        <Pager first={cursor ? qs({ status }) : undefined} next={list.nextCursor ? qs({ status, cursor: list.nextCursor }) : undefined} />
      </section>
    </div>
  );
}

async function ChargeView({ c, simulator, failed }: { c: ChargeRow; simulator: boolean; failed: boolean }) {
  const pending = c.status === "pending";
  const qr = pending ? await QRCode.toDataURL(c.brcode, { margin: 1, width: 440 }) : null;
  return (
    <Card className="order-first lg:order-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Cobrança</p>
          <h2 className="text-2xl tabular-nums">
            {brl(c.amountCents)}
          </h2>
        </div>
        <StatusBadge kind="charge" status={c.status} />
      </div>
      {failed && <Alert className="mt-4">Não foi possível simular o pagamento agora. Tente de novo.</Alert>}

      {qr && (
        <div className="mt-6 grid gap-6 sm:grid-cols-[13.75rem_minmax(0,1fr)]">
          <Image
            src={qr}
            alt="QR code do Pix desta cobrança"
            width={220}
            height={220}
            unoptimized
            className="mx-auto rounded-2xl border border-line"
          />
          <div className="min-w-0 space-y-4">
            <CopyField id="brcode" label="Pix copia e cola" value={c.brcode} rows={5} />
            <p className="text-sm text-muted">Válida até {dataHora(c.expiresAt)}.</p>
            <div className="flex flex-wrap gap-2">
              <Link href={`/painel/cobrancas?id=${c.id}`} className={buttonClass("ghost")}>
                Atualizar status
              </Link>
              {simulator && (
                <form action={simulatePaymentAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <SubmitButton variant="accent" pendingText="Simulando…">
                    Simular pagamento
                  </SubmitButton>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      <dl className="mt-6 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Item label="Tarifa">{brl(c.feeCents)}</Item>
        <Item label="Você recebe">{brl(c.amountCents - c.feeCents)}</Item>
        <Item label="Descrição">{c.description || "—"}</Item>
        <Item label="Criada em">{dataHora(c.createdAt)}</Item>
        {c.paidAt && <Item label="Paga em">{dataHora(c.paidAt)}</Item>}
        {c.payerName && <Item label="Pagador">{c.payerName}</Item>}
        {c.payerDocumentMasked && <Item label="Documento do pagador">{c.payerDocumentMasked}</Item>}
        {c.endToEndId && <Item label="ID da transação (E2E)">{c.endToEndId}</Item>}
        <Item label="ID da cobrança">{c.id}</Item>
        <Item label="Referência">{c.externalRef}</Item>
      </dl>
    </Card>
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
