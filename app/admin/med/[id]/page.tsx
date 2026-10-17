import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";
import { ActionForm } from "@/app/components/ui/action-form";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Field, inputClass } from "@/app/components/ui/field";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { requireAdmin } from "@/lib/auth/guards";
import { brl, dateTime } from "@/lib/br/money";
import type { medEvents } from "@/lib/db/schema";
import { medCaseDetail } from "@/lib/services/admin/med-queue";
import { pode } from "../../perms-ui";
import { addMedNoteAction } from "../actions";
import { Deadline, ratePct } from "../ui";

export const metadata: Metadata = { title: "Caso de MED — Admin Vantri" };

type MedEvent = typeof medEvents.$inferSelect;
type Tone = NonNullable<ComponentProps<typeof Badge>["tone"]>;

// Todo tipo de evento tem rótulo próprio (o `satisfies` cobra quando o enum crescer).
const EVENT_LABEL = {
  opened: "MED aberto",
  funds_blocked: "Valor bloqueado no saldo",
  defense_submitted: "Defesa enviada pelo lojista",
  defense_sent: "Defesa enviada ao parceiro",
  analysis: "Em análise no parceiro",
  closed_merchant_won: "Encerrado a favor do lojista (valor liberado)",
  closed_payer_refunded: "Encerrado com devolução ao pagador (valor debitado)",
  closed: "Encerrado",
  note: "Anotação interna",
} satisfies Record<MedEvent["type"], string>;

const SOURCE: Record<NonNullable<MedEvent["source"]>, [string, Tone]> = {
  provider: ["Parceiro", "info"],
  merchant: ["Lojista", "muted"],
  admin: ["Admin", "warn"],
  system: ["Sistema", "muted"],
};

const noteText = (meta: unknown) => {
  const note = (meta as { note?: unknown } | null)?.note;
  return typeof note === "string" ? note : null;
};

export default async function MedCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireAdmin({ perm: "med:ler" });
  const d = await medCaseDetail((await params).id);
  if (!d) notFound();
  const { case: c, charge } = d;
  // Só mostra/esconde o que opera; a ação re-checa med:operar no servidor.
  const canOperate = pode(user.adminRole, "med:operar");
  const closed = c.status === "merchant_won" || c.status === "payer_refunded";

  return (
    <>
      <Link href="/admin/med" className="text-sm font-semibold text-muted hover:text-ink">
        ← MED
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl tabular-nums sm:text-3xl">MED de {brl(c.amountCents)}</h1>
        <StatusBadge kind="med" status={c.status} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card>
          <h2 className="text-lg">Caso</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <Row label="Lojista">
              <Link href={`/admin/clientes/${c.merchantId}`} className="font-semibold text-brand hover:underline">
                {d.tradeName}
              </Link>
              <span className="block text-xs text-muted">Taxa de MED (30 dias): {ratePct(d.merchantMedRate)}</span>
            </Row>
            <Row label={closed ? "Valor" : "Valor bloqueado"}>
              <span className="font-semibold tabular-nums">{brl(c.amountCents)}</span>
              <span className="block text-xs text-muted">
                {c.status === "merchant_won"
                  ? "Liberado no saldo do lojista."
                  : c.status === "payer_refunded"
                    ? "Debitado e devolvido ao pagador."
                    : "Bloqueado no saldo do lojista até o desfecho."}
              </span>
            </Row>
            <Row label="Motivo">{c.reason}</Row>
            <Row label="Aberto em">{dateTime(c.createdAt)}</Row>
            <Row label="Prazo da defesa">
              <Deadline c={c} />
            </Row>
            {c.closedAt && <Row label="Encerrado em">{dateTime(c.closedAt)}</Row>}
            <Row label="ID no parceiro">
              <span className="break-all font-mono text-xs">{c.providerCaseId}</span>
            </Row>
          </dl>
        </Card>

        <Card>
          <h2 className="text-lg">Cobrança de origem</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <Row label="Valor">
              <span className="tabular-nums">{brl(charge.amountCents)}</span>
            </Row>
            <Row label="Status">
              <StatusBadge kind="charge" status={charge.status} />
            </Row>
            <Row label="Paga em">{charge.paidAt ? dateTime(charge.paidAt) : "—"}</Row>
            <Row label="E2E">
              <span className="break-all font-mono text-xs">{charge.endToEndId ?? "—"}</span>
            </Row>
            <Row label="ID da cobrança">
              <span className="break-all font-mono text-xs">{charge.id}</span>
            </Row>
          </dl>
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="text-lg">Defesa do lojista</h2>
          {c.defenseText ? (
            <p className="mt-3 whitespace-pre-wrap break-words rounded-2xl bg-bg p-4 text-sm leading-relaxed">{c.defenseText}</p>
          ) : (
            <p className="mt-3 text-sm text-muted">
              {closed ? "O lojista não enviou defesa." : "O lojista ainda não enviou defesa."}
            </p>
          )}
          {d.files.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {d.files.map((f) => (
                <li key={f.id}>
                  <a href={`/admin/med/arquivo/${f.id}`} className="break-all font-semibold text-brand hover:underline">
                    Baixar {f.filename}
                  </a>{" "}
                  <span className="text-xs text-muted">({Math.max(1, Math.round(f.sizeBytes / 1024))} KB)</span>
                </li>
              ))}
            </ul>
          )}
          {/* Honestidade: sem integração com o parceiro não há envio de verdade; o botão não finge funcionar. */}
          {canOperate && c.status === "defended" && (
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-6">
              <Button disabled>Enviar defesa ao parceiro</Button>
              <Badge>requer parceiro</Badge>
              <p className="w-full text-xs text-muted">
                O envio da defesa depende da integração com a instituição parceira, que ainda não está disponível.
              </p>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="text-lg">Linha do tempo</h2>
          {d.events.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nenhum evento registrado.</p>
          ) : (
            <ol className="mt-4 space-y-5 border-l-2 border-line pl-5">
              {d.events.map((e, i) => {
                const [who, tone] = e.source ? SOURCE[e.source] : (["Origem não registrada", "muted"] as const);
                const note = e.type === "note" ? noteText(e.meta) : null;
                return (
                  <li key={i} className="relative">
                    <span aria-hidden className="absolute -left-[27px] top-1 size-3 rounded-full border-2 border-white bg-brand" />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{EVENT_LABEL[e.type]}</span>
                      <Badge tone={tone}>{who}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{dateTime(e.createdAt)}</p>
                    {note && <p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-bg p-3 text-sm">{note}</p>}
                  </li>
                );
              })}
            </ol>
          )}

          {canOperate && (
            <ActionForm action={addMedNoteAction} className="mt-6 space-y-3 border-t border-line pt-6">
              <input type="hidden" name="caseId" value={c.id} />
              <Field label="Anotação interna" htmlFor="note" hint="Só a equipe vê. Entra na linha do tempo do caso.">
                <textarea
                  id="note"
                  name="note"
                  required
                  maxLength={2000}
                  rows={3}
                  aria-describedby="note-dica"
                  className={`${inputClass} h-auto py-2.5`}
                />
              </Field>
              <SubmitButton pendingText="Salvando…">Salvar anotação</SubmitButton>
            </ActionForm>
          )}
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
