"use client";

import type { CSSProperties, ReactNode } from "react";
import { EXAMPLE, FEE_IN, PSP_NAME } from "../site";
import { Gauge } from "./Gauge";
import { LineChart } from "./LineChart";
import { Reveal, usePlay } from "./Reveal";

const delay = (ms: number): CSSProperties => ({ transitionDelay: `${ms}ms` });
// Classes que valem só enquanto o card espera entrar na tela (data-phase="waiting").
const HIDDEN = "group-data-[phase=waiting]:opacity-0 group-data-[phase=waiting]:scale-75";

function Retries() {
  const [ref, phase] = usePlay<HTMLDivElement>();
  const log = [
    ["#1", "500", "agora"],
    ["#2", "timeout", "+1 min"],
    ["#3", "200 OK", "+5 min"],
  ];
  return (
    <div ref={ref} data-phase={phase} className="group w-full max-w-[300px]">
      <div className="relative">
        <div className="absolute inset-x-4 top-1/2 h-0.5 -translate-y-1/2 bg-line" />
        <div
          className="absolute left-4 top-1/2 h-0.5 w-[calc((100%-2rem)/3)] origin-left -translate-y-1/2 bg-brand transition-transform duration-[1200ms] group-data-[phase=waiting]:scale-x-0"
          style={delay(200)}
        />
        <ol className="relative flex justify-between" aria-label="Sete tentativas de entrega">
          {[1, 2, 3, 4, 5, 6, 7].map((n) => (
            <li
              key={n}
              style={delay(n * 140)}
              className={`grid size-8 place-items-center rounded-full border-2 text-xs font-bold transition duration-500 ${HIDDEN} ${
                n < 3
                  ? "border-line bg-white text-muted"
                  : n === 3
                    ? "border-ok bg-ok text-white"
                    : "border-dashed border-line bg-bg text-muted/60"
              }`}
            >
              {n}
            </li>
          ))}
        </ol>
      </div>
      <ul className="mt-4 space-y-1 rounded-xl bg-bg px-3 py-2.5 font-mono text-[11px]">
        {log.map(([n, s, t], i) => (
          <li
            key={n}
            style={delay(700 + i * 220)}
            className="flex justify-between transition duration-500 group-data-[phase=waiting]:translate-x-[-8px] group-data-[phase=waiting]:opacity-0"
          >
            <span className="text-muted">{n}</span>
            <span className={i === 2 ? "font-bold text-ink" : "text-muted"}>{s}</span>
            <span className="text-muted">{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TwoFactor() {
  const [ref, phase] = usePlay<HTMLDivElement>();
  return (
    <div ref={ref} data-phase={phase} className="group text-center">
      <p className="text-xs font-medium text-muted">Código do app autenticador</p>
      <div className="mt-3 flex justify-center gap-1.5 sm:gap-2">
        {"482917".split("").map((d, i) => (
          <span
            key={i}
            style={delay(250 + i * 160)}
            className="grid h-12 w-9 place-items-center rounded-xl border-2 border-brand bg-white text-xl font-bold tabular-nums transition-colors duration-300 group-data-[phase=waiting]:border-line sm:w-10"
          >
            <span style={delay(250 + i * 160)} className="transition duration-300 group-data-[phase=waiting]:translate-y-2 group-data-[phase=waiting]:opacity-0">
              {d}
            </span>
          </span>
        ))}
      </div>
      <p
        style={delay(1400)}
        className={`mt-4 inline-flex items-center gap-2 rounded-full border border-ok/30 bg-ok/10 px-3 py-1 text-xs font-semibold text-ink transition duration-500 ${HIDDEN}`}
      >
        <span className="size-2 rounded-full bg-ok" aria-hidden />
        Saque autorizado
      </p>
    </div>
  );
}

const SCOPES: [string, boolean][] = [
  ["charges:write", true],
  ["charges:read", true],
  ["balance:read", true],
  ["statement:read", true],
  ["payouts:write", false],
  ["payouts:read", false],
  ["med:read", false],
];

function Scopes() {
  const [ref, phase] = usePlay<HTMLDivElement>();
  return (
    <div ref={ref} data-phase={phase} className="group w-full max-w-[300px]">
      <p className="font-mono text-[11px] text-muted">vk_live_9fQ2…  ·  “Loja principal”</p>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Escopos da chave de exemplo">
        {SCOPES.map(([s, on], i) => (
          <li
            key={s}
            style={delay(150 + i * 90)}
            className={`rounded-full border px-2.5 py-1 font-mono text-[11px] transition duration-500 ${HIDDEN} ${
              on ? "border-brand/25 bg-brand/10 font-semibold text-brand" : "border-line bg-white text-muted line-through"
            }`}
          >
            {s}
          </li>
        ))}
      </ul>
      <p style={delay(900)} className={`mt-3 font-mono text-[11px] text-muted transition duration-500 ${HIDDEN}`}>
        IPs permitidos: 203.0.113.10
      </p>
    </div>
  );
}

function Med() {
  const [ref, phase] = usePlay<HTMLDivElement>();
  return (
    <div ref={ref} data-phase={phase} className="group w-full max-w-[300px] text-sm">
      <p className="flex items-center justify-between text-xs">
        <span className="font-semibold">MED aberto</span>
        <span className="text-muted">{EXAMPLE.sale} bloqueado</span>
      </p>
      <div className="mt-3 rounded-2xl border border-line bg-white p-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-[10px] font-bold text-brand">PDF</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold">comprovante-de-entrega.pdf</p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                style={delay(250)}
                className="h-full origin-left rounded-full bg-brand transition-transform duration-[1200ms] ease-out group-data-[phase=waiting]:scale-x-0"
              />
            </div>
          </div>
        </div>
      </div>
      <p
        style={delay(1500)}
        className={`mt-3 inline-flex items-center gap-2 rounded-full border border-ok/30 bg-ok/10 px-3 py-1 text-xs font-semibold transition duration-500 ${HIDDEN}`}
      >
        <span className="size-2 rounded-full bg-ok" aria-hidden />
        Defesa enviada
      </p>
    </div>
  );
}

function Card({ title, visual, children, i }: { title: string; visual: ReactNode; children: ReactNode; i: number }) {
  return (
    <Reveal delay={(i % 3) * 100} className="h-full">
      <article className="flex h-full flex-col rounded-3xl border border-line bg-white p-6 shadow-[0_20px_50px_-30px_rgb(59_55_242/0.35)]">
        <div className="flex min-h-44 items-center justify-center">{visual}</div>
        <h3 className="mt-6 text-lg">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
      </article>
    </Reveal>
  );
}

const PILARES = [
  ["Conta própria por lojista", `Cada lojista tem a sua conta na ${PSP_NAME}. Nada de saldo de todos misturado numa conta só.`],
  ["Cadastro com análise", "Com CPF ou CNPJ, todo cadastro é analisado antes de liberar o acesso ao painel."],
  ["Limites claros", "Cobrança de R$ 1,00 a R$ 100.000,00. Saque de até R$ 50.000,00 por pedido."],
  ["Segredos só com hash", "Senhas e chaves de API ficam guardadas só como hash. A chave aparece uma única vez, na criação."],
];

export function Recursos() {
  return (
    <section id="recursos" aria-labelledby="recursos-titulo" className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Reveal className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Recursos</p>
          <h2 id="recursos-titulo" className="mt-3 text-3xl sm:text-4xl md:text-5xl">
            Do QR Code ao saque, <span className="hl">num painel só</span>.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            O que quem vende produto digital precisa para receber por Pix, sem mensalidade e sem letra miúda.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Card i={0} title="Tarifa que cabe na conta" visual={<Gauge value={EXAMPLE.kept} label="fica com você" />}>
            {FEE_IN} por Pix recebido. Numa venda de {EXAMPLE.sale}, a tarifa é {EXAMPLE.fee} e {EXAMPLE.net} ficam com você.
          </Card>
          <Card i={1} title="Extrato em tempo real" visual={<LineChart />}>
            Cada Pix recebido, tarifa e saque vira uma linha no extrato, com saldo disponível e bloqueado. Exporte em CSV quando quiser.
          </Card>
          <Card i={2} title="Webhooks assinados" visual={<Retries />}>
            Cada evento sai assinado com HMAC-SHA256 e timestamp. Se o seu servidor falhar, tentamos de novo em 1 min, 5 min, 30 min, 2 h, 6 h e 24 h.
          </Card>
          <Card i={3} title="Saque protegido" visual={<TwoFactor />}>
            2FA obrigatório no login e nos saques pelo painel; pela API, o saque exige chave com o escopo payouts:write e, se você
            configurar, lista de IPs permitidos. Senha vazada, sozinha, não movimenta o seu dinheiro.
          </Card>
          <Card i={4} title="Chaves de API com escopo" visual={<Scopes />}>
            Cada chave tem só as permissões de que precisa e pode ter lista de IPs permitidos. Revogue quando quiser.
          </Card>
          <Card i={5} title="MED com defesa pelo painel" visual={<Med />}>
            Se um pagador abrir MED, só o valor contestado fica bloqueado e você envia a defesa com texto e anexos (PDF, PNG ou JPEG).
          </Card>
        </div>

        <Reveal className="mt-5">
          <ul className="grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {PILARES.map(([t, d]) => (
              <li key={t} className="bg-white p-6">
                <h3 className="text-base">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
