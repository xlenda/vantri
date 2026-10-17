"use client";

import Link from "next/link";
import { type ReactNode, useActionState, useEffect, useRef, useState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Button, buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input, Select } from "@/app/components/ui/field";
import { Badge, StatusBadge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { brl } from "@/lib/br/money";
import type { payoutBatches } from "@/lib/db/schema";
import type { PayoutRow } from "@/lib/services/payouts";
import { createBatchPayoutAction, createPayoutAction, previewPayoutAction, resumeBatchAction } from "../actions";

/** Lote lido do banco pela página (só do próprio lojista): parcelas planejadas sobrepostas pelos saques gravados. */
export type LoteView = {
  id: string;
  status: (typeof payoutBatches.$inferSelect)["status"];
  totalCents: number;
  failedAtIndex: number | null;
  replayed: boolean;
  parcels: { amountCents: number; status: PayoutRow["status"] | "pending" }[];
};

const STEPS = ["Dados", "Revisão", "Verificação", "Confirmação"] as const;

/** Valor em dinheiro: some com o "ocultar saldos" do painel. */
const Money = ({ cents }: { cents: number }) => <span className="valor-sensivel tabular-nums">{brl(cents)}</span>;

/**
 * Assistente Dados → Revisão → Verificação → Confirmação. Uma chave de idempotência por render da página, a mesma em
 * todo reenvio (erro de rede, código errado, voltar e avançar). O saque avulso termina no aviso da lista de saques;
 * o lote termina aqui (?lote=…), lido do banco, com a retomada das parcelas pendentes.
 */
export function Wizard({
  idempotencyKey,
  keyTypes,
  fee,
  ceilingCents,
  simulator,
  lote,
}: {
  idempotencyKey: string;
  keyTypes: ReadonlyArray<readonly [string, string]>;
  fee: string;
  ceilingCents: number;
  simulator: boolean;
  lote?: LoteView;
}) {
  const [step, setStep] = useState(lote ? 4 : 1);
  const [resuming, setResuming] = useState(false);
  const [state, previewAction] = useActionState(previewPayoutAction, undefined);
  // Prévia nova e válida → Revisão. Ajuste no render (não em efeito): a Revisão nunca pinta a prévia anterior.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state && "preview" in state) setStep(2);
  }
  const p = state && "preview" in state ? state.preview : undefined;
  const v = state?.values;

  // Troca de passo leva o foco ao título do passo: o leitor de tela anuncia e o teclado segue dali.
  const title = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current !== step) title.current?.focus();
    shownStep.current = step;
  }, [step]);

  const keyLabel = (t: string) => keyTypes.find(([k]) => k === t)?.[1] ?? t;

  return (
    <div className="space-y-6">
      <Stepper step={step} />
      <Card>
        <h2 ref={title} tabIndex={-1} className="text-lg outline-none">
          {STEPS[step - 1]}
        </h2>
        <div className="mt-5">
          {step === 1 && (
            <form key={state?.attempt} action={previewAction} className="space-y-4">
              {state && "error" in state && <Alert>{state.error}</Alert>}
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
              <Input
                label="Valor (R$)"
                name="amount"
                inputMode="decimal"
                placeholder="0,00"
                autoComplete="off"
                required
                maxLength={20}
                hint={
                  <>
                    Tarifa: {fee} por transferência, descontada do saldo. Acima de <Money cents={ceilingCents} /> o saque
                    sai em parcelas (limite de demonstração: o real depende do parceiro de Pix).
                  </>
                }
                defaultValue={v?.amount}
              />
              <Select label="Tipo da chave Pix" name="pixKeyType" required defaultValue={v?.pixKeyType ?? ""}>
                <option value="" disabled>
                  Selecione
                </option>
                {keyTypes.map(([t, label]) => (
                  <option key={t} value={t}>
                    {label}
                  </option>
                ))}
              </Select>
              <Input
                label="Chave Pix de destino"
                name="pixKey"
                required
                maxLength={100}
                autoComplete="off"
                hint="Celular com DDD, ex.: (11) 98765-4321."
                defaultValue={v?.pixKey}
              />
              <Input label="Descrição (opcional)" name="description" maxLength={140} defaultValue={v?.description} />
              <SubmitButton className="w-full" pendingText="Conferindo…">
                Continuar
              </SubmitButton>
            </form>
          )}

          {step === 2 && p && (
            <div className="space-y-5">
              <div>
                <p className="text-sm text-muted">Você vai transferir</p>
                <p className="mt-1 text-3xl font-bold tracking-tight">
                  <Money cents={p.amountCents} />
                </p>
              </div>
              {p.parcels && (
                <Alert tone="info">
                  <strong>Saque parcelado — {p.parcels.length} parcelas para o mesmo favorecido.</strong> O valor passa do
                  limite de <Money cents={p.ceilingCents} /> por transferência (limite de demonstração: o real depende do
                  parceiro de Pix).
                </Alert>
              )}
              <section aria-labelledby="quem-recebe" className="rounded-2xl border border-line p-4">
                <h3 id="quem-recebe" className="text-sm font-semibold">
                  Quem vai receber
                </h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <Row label="Tipo da chave">{keyLabel(p.pixKeyType)}</Row>
                  <Row label="Chave Pix">
                    <span className="break-all">{p.pixKey}</span>
                  </Row>
                  <Row label="Descrição">{p.description || "Sem descrição"}</Row>
                  <Row label="Favorecido">
                    <span className="font-normal text-muted">Nome e banco: requer parceiro de Pix (consulta DICT)</span>
                  </Row>
                </dl>
              </section>
              {p.parcels && (
                <section aria-labelledby="parcelas">
                  <h3 id="parcelas" className="text-sm font-semibold">
                    Parcelas ({p.parcels.length})
                  </h3>
                  <ol className="mt-2 divide-y divide-line rounded-2xl border border-line text-sm">
                    {p.parcels.map((c, i) => (
                      <li key={i} className="flex flex-wrap justify-between gap-x-3 gap-y-1 px-4 py-2.5">
                        <span>Parcela {i + 1}</span>
                        <span>
                          <Money cents={c.amountCents} />
                          <span className="text-muted">
                            {" "}
                            + tarifa <Money cents={c.feeCents} />
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <dl className="space-y-2 text-sm">
                <Row label="Valor">
                  <Money cents={p.amountCents} />
                </Row>
                <Row label={p.parcels ? "Tarifas" : "Tarifa"}>
                  <Money cents={p.feeCents} />
                </Row>
                <Row label="Total a debitar">
                  <Money cents={p.totalCents} />
                </Row>
                <Row label="Disponível agora">
                  <Money cents={p.availableCents} />
                </Row>
                {p.afterCents >= 0 && (
                  <Row label="Saldo depois">
                    <Money cents={p.afterCents} />
                  </Row>
                )}
              </dl>
              {p.afterCents < 0 ? (
                <Alert>O valor e a tarifa passam do saldo disponível. Volte e ajuste o valor para continuar.</Alert>
              ) : (
                <Alert tone="info">
                  Confira os dados do favorecido. Transferências Pix não podem ser desfeitas depois de confirmadas.
                </Alert>
              )}
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  Voltar
                </Button>
                <Button onClick={() => setStep(3)} disabled={p.afterCents < 0}>
                  Continuar
                </Button>
              </div>
            </div>
          )}

          {step === 3 && resuming && lote && (
            <Verify
              mode="retomar"
              hidden={{ id: lote.id }}
              onBack={() => {
                setResuming(false);
                setStep(4);
              }}
            >
              Digite o código do app autenticador para retomar as parcelas pendentes do lote de{" "}
              <Money cents={lote.totalCents} />. O código do envio anterior já foi usado.
            </Verify>
          )}
          {step === 3 && !resuming && p && v && (
            <Verify
              mode={p.parcels ? "lote" : "saque"}
              hidden={{ idempotencyKey, ...v }}
              pendingText={p.parcels ? `Enviando ${p.parcels.length} parcelas…` : "Enviando…"}
              onBack={() => setStep(2)}
            >
              {p.parcels ? (
                <>
                  Digite o código do app autenticador para liberar o lote de <strong>{p.parcels.length}</strong> parcelas,
                  total de <Money cents={p.amountCents} />.
                </>
              ) : (
                <>
                  Digite o código do app autenticador para liberar a transferência de <Money cents={p.amountCents} />.
                </>
              )}
            </Verify>
          )}

          {step === 4 && lote && (
            <LoteDone
              lote={lote}
              simulator={simulator}
              onResume={() => {
                setResuming(true);
                setStep(3);
              }}
            />
          )}
        </div>
      </Card>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Passos da transferência">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i + 1 === step ? "step" : undefined} className="min-w-0">
          <span
            aria-hidden
            className={`block h-1.5 rounded-full ${i + 1 < step ? "bg-ok" : i + 1 === step ? "bg-brand" : "bg-line"}`}
          />
          <span className={`mt-2 block truncate text-xs font-semibold ${i + 1 === step ? "text-ink" : "text-muted"}`}>
            {label}
            {i + 1 < step && <span className="sr-only"> (feito)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}

/**
 * Passo Verificação: um código 2FA por envio, conferido no servidor depois dos campos. Montado de novo a cada
 * entrada no passo (estado próprio), então não mostra o erro de uma tentativa anterior; após erro o código é limpo.
 */
function Verify({
  mode,
  hidden,
  pendingText = "Enviando…",
  onBack,
  children,
}: {
  mode: "saque" | "lote" | "retomar";
  hidden: Record<string, string>;
  pendingText?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const [saque, saqueAction] = useActionState(createPayoutAction, undefined);
  const [lote, loteAction] = useActionState(createBatchPayoutAction, undefined);
  const [retomar, retomarAction] = useActionState(resumeBatchAction, undefined);
  const [state, action] =
    mode === "saque" ? [saque, saqueAction] : mode === "lote" ? [lote, loteAction] : [retomar, retomarAction];
  return (
    <form action={action} className="space-y-4">
      {state && <Alert>{state.error}</Alert>}
      <p className="text-sm leading-relaxed">{children}</p>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Input
        label="Código do app autenticador"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        hint="Obrigatório em todo saque: os 6 dígitos que aparecem agora no app."
        className="font-semibold tracking-[0.3em]"
      />
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
        <SubmitButton pendingText={pendingText}>Confirmar e enviar</SubmitButton>
      </div>
    </form>
  );
}

const LOTE_TITLE: Record<LoteView["status"], string> = {
  completed: "Lote enviado",
  partial: "Lote enviado parcialmente",
  processing: "Lote em andamento",
  failed: "Lote não enviado",
};

/**
 * Confirmação do lote, parcela a parcela. Parcial: a retomada só avança parcela que não chegou a ser criada ou que o
 * banco concluiu depois; parcela que falhou de vez fica parada (a chave dela já foi usada, não paga duas vezes) e
 * parcela em processamento espera a confirmação — nos dois casos não há botão de retomar, e a tela diz o porquê.
 */
function LoteDone({ lote, simulator, onResume }: { lote: LoteView; simulator: boolean; onResume: () => void }) {
  const at = lote.failedAtIndex ?? 0;
  const stuck = lote.status === "partial" ? lote.parcels[at] : undefined;
  const canResume = stuck?.status === "pending" || stuck?.status === "completed";
  const refresh = (
    <Link href={`/painel/saques/novo?lote=${lote.id}`} className={buttonClass("ghost")}>
      Atualizar
    </Link>
  );
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xl font-semibold">{LOTE_TITLE[lote.status]}</p>
        <p className="mt-1 text-sm text-muted">
          Total de <Money cents={lote.totalCents} /> em {lote.parcels.length} parcelas para o mesmo favorecido.
          {simulator && " Pix simulado: nenhum dinheiro de verdade foi enviado."}
        </p>
      </div>
      {lote.replayed && <Alert tone="info">Este lote já tinha sido enviado (mesma solicitação).</Alert>}
      <ol aria-label="Parcelas" className="divide-y divide-line rounded-2xl border border-line text-sm">
        {lote.parcels.map((c, i) => (
          <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span>
              Parcela {i + 1} · <Money cents={c.amountCents} />
            </span>
            {c.status === "pending" ? <Badge>Não enviada</Badge> : <StatusBadge kind="payout" status={c.status} />}
          </li>
        ))}
      </ol>
      {lote.status === "processing" && (
        <Alert tone="info">As parcelas saem uma a uma. Atualize a página para ver o andamento.</Alert>
      )}
      {stuck?.status === "failed" && (
        <Alert>
          A parcela {at + 1} falhou com a chave Pix informada e não pode ser tentada de novo automaticamente; abra um
          novo saque para o valor restante. O valor e a tarifa dessa parcela voltaram para o seu saldo.
        </Alert>
      )}
      {stuck?.status === "processing" && (
        <Alert tone="info">
          A parcela {at + 1} ainda está em processamento no banco. Quando ela for concluída, atualize a página para
          retomar as parcelas pendentes.
        </Alert>
      )}
      {canResume && (
        <Alert tone="info">
          O lote parou na parcela {at + 1}. Parcela concluída não é paga de novo e parcela não enviada não debitou nada:
          resolva o problema (por exemplo, saldo) e retome as parcelas pendentes.
        </Alert>
      )}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
        <Link href="/painel/saques" className={buttonClass("ghost")}>
          Ver saques
        </Link>
        {(lote.status === "processing" || stuck?.status === "processing") && refresh}
        <Link href="/painel/saques/novo" className={buttonClass(canResume ? "ghost" : "primary")}>
          Nova transferência
        </Link>
        {canResume && <Button onClick={onResume}>Retomar parcelas pendentes</Button>}
      </div>
    </div>
  );
}
