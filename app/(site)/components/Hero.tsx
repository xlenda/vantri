"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { EXAMPLE, FEE_IN, FEE_OUT } from "../site";
import { Mark } from "./Logo";

export type Qr = { size: number; d: string };

const TABS = [
  { id: "cobranca", label: "Cobrança", nav: "Cobranças" },
  { id: "extrato", label: "Extrato", nav: "Extrato" },
  { id: "saque", label: "Saque", nav: "Saques" },
] as const;
const NAV = ["Início", "Cobranças", "Extrato", "Saques", "Integrações", "MED"];

const card = "rounded-2xl border border-line bg-white p-4 sm:p-5";

function Field({ label, value, className = "" }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 truncate rounded-lg border border-line bg-bg/50 px-3 py-2 text-sm font-semibold">{value}</p>
    </div>
  );
}

function Title({ kicker, children }: { kicker: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{kicker}</p>
      <h3 className="mt-0.5 text-lg">{children}</h3>
    </div>
  );
}

const Fake = ({ children, dark = false }: { children: ReactNode; dark?: boolean }) => (
  <span className={`inline-flex h-9 items-center rounded-full px-4 text-xs font-semibold ${dark ? "bg-ink text-white" : "bg-brand text-white"}`}>
    {children}
  </span>
);

function Cobranca({ qr }: { qr: Qr }) {
  const pagas = [
    ["AR", "Ana R.", "+R$ 197,00", "agora"],
    ["BT", "Bruno T.", "+R$ 47,00", "há 3 min"],
    ["CM", "Carla M.", "+R$ 497,00", "há 9 min"],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
      <div className="min-w-0 space-y-4">
        <div className={card}>
          <Title kicker="Cobranças">Nova cobrança Pix</Title>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Valor" value={EXAMPLE.sale} />
            <Field label="Validade" value="60 minutos" />
            <Field className="col-span-2" label="Descrição" value="Curso de Fotografia (turma 3)" />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Fake>Gerar QR Code</Fake>
            <span className="text-xs text-muted">
              Tarifa {EXAMPLE.fee} ({FEE_IN})
            </span>
          </div>
        </div>
        <div className={card}>
          <p className="text-xs font-semibold text-muted">Pagas hoje</p>
          <ul className="mt-2 divide-y divide-line">
            {pagas.map(([ini, nome, valor, quando]) => (
              <li key={nome} className="flex items-center gap-3 py-2 text-sm">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand/10 text-[10px] font-bold text-brand">{ini}</span>
                <span className="flex-1 truncate">{nome}</span>
                <span className="font-semibold tabular-nums">{valor}</span>
                <span className="w-16 text-right text-xs text-muted">{quando}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className={`${card} flex flex-col items-center text-center`}>
        <p className="self-start text-xs font-semibold text-muted">QR Code dinâmico</p>
        <svg
          viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`}
          className="mt-3 w-full max-w-[180px] rounded-xl bg-white"
          shapeRendering="crispEdges"
          role="img"
          aria-label="QR Code de exemplo"
        >
          <path d={qr.d} fill="var(--color-ink)" />
        </svg>
        <p className="mt-3 w-full truncate rounded-lg bg-bg px-2 py-1.5 font-mono text-[10px] text-muted">00020101021226870014br.gov.bcb.pix…</p>
        <p className="mt-3 inline-flex items-center gap-2 text-xs font-semibold">
          <span className="relative flex size-2">
            <span className="absolute inset-0 animate-ping-soft rounded-full bg-brand" />
            <span className="relative size-2 rounded-full bg-brand" />
          </span>
          Aguardando pagamento
        </p>
      </div>
    </div>
  );
}

function Extrato() {
  const linhas = [
    ["14:02", "Pix recebido · Curso de Fotografia", "+R$ 197,00"],
    ["14:02", "Tarifa do Pix recebido", "−R$ 2,94"],
    ["11:40", "Pix recebido · Mentoria individual", "+R$ 497,00"],
    ["11:40", "Tarifa do Pix recebido", "−R$ 7,41"],
    ["09:15", "Saque para chave e-mail", "−R$ 1.000,00"],
    ["09:15", "Tarifa do saque", "−R$ 1,00"],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
      <div className={`${card} min-w-0`}>
        <div className="flex items-start justify-between gap-3">
          <Title kicker="Extrato">Hoje</Title>
          <Fake dark>Baixar CSV</Fake>
        </div>
        <ul className="mt-3 divide-y divide-line">
          {linhas.map(([h, d, v], i) => (
            <li key={i} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="w-10 shrink-0 text-xs tabular-nums text-muted">{h}</span>
              <span className="min-w-0 flex-1 truncate">{d}</span>
              <span className={`shrink-0 font-semibold tabular-nums ${v.startsWith("+") ? "text-ink" : "text-muted"}`}>{v}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid content-start gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <div className="rounded-2xl bg-ink p-5 text-white">
          <p className="text-xs font-semibold text-white/70">Saldo disponível</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">R$ 3.482,16</p>
          <p className="mt-3 inline-flex rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-bold text-ink">D+0</p>
        </div>
        <div className={card}>
          <p className="text-xs font-semibold text-muted">Bloqueado (MED)</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">R$ 0,00</p>
        </div>
      </div>
    </div>
  );
}

function Saque() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
      <div className={`${card} min-w-0`}>
        <Title kicker="Saques">Sacar para sua chave Pix</Title>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Tipo de chave" value="E-mail" />
          <Field label="Valor" value="R$ 1.000,00" />
          <Field className="col-span-2" label="Chave" value="financeiro@sualoja.com.br" />
        </div>
        <p className="mt-3 text-xs text-muted">
          Tarifa {FEE_OUT} · sai do saldo <strong className="text-ink">R$ 1.001,00</strong>
        </p>
        <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted">Código 2FA</p>
        <div className="mt-1.5 flex gap-1.5">
          {"482917".split("").map((d, i) => (
            <span key={i} className="grid h-10 w-8 place-items-center rounded-lg border-2 border-brand/40 text-base font-bold tabular-nums sm:w-9">
              {d}
            </span>
          ))}
        </div>
        <div className="mt-4">
          <Fake>Confirmar saque</Fake>
        </div>
      </div>
      <div className={card}>
        <p className="text-xs font-semibold text-muted">Saldo disponível</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">R$ 3.482,16</p>
        <p className="mt-4 text-xs font-semibold text-muted">Últimos saques</p>
        <ul className="mt-2 space-y-2 text-sm">
          {["R$ 1.000,00", "R$ 2.500,00"].map((v) => (
            <li key={v} className="flex items-center justify-between">
              <span className="font-semibold tabular-nums">{v}</span>
              <span className="inline-flex items-center gap-1.5 text-xs">
                <span className="size-1.5 rounded-full bg-ok" aria-hidden />
                Concluído
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Hero({ qr }: { qr: Qr }) {
  const [tab, setTab] = useState(0);
  const mockRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // O painel "assenta" conforme rola: inclinado e menor ao entrar, reto no meio da tela.
  // Opacidade fica sempre 1 (nada de mock lavado na primeira dobra).
  const { scrollYProgress } = useScroll({ target: mockRef, offset: ["start end", "end start"] });
  const scale = useTransform(scrollYProgress, [0, 0.45, 1], [0.94, 1, 0.98]);
  const rotateX = useTransform(scrollYProgress, [0, 0.45], [9, 0]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (tab + step + TABS.length) % TABS.length;
    setTab(n);
    document.getElementById(`aba-${TABS[n].id}`)?.focus();
  };

  return (
    // overflow-x-clip (não hidden): corta o brilho largo sem cortar a sombra do painel embaixo.
    <section id="top" className="relative overflow-x-clip">
      <div aria-hidden className="grid-bg pointer-events-none absolute inset-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-120px] h-[520px] w-[min(1000px,140vw)] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(201_242_91/0.45),transparent)] blur-3xl"
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-14 text-center sm:px-6 sm:pt-20 md:pt-28">
        <p className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold">
          <span className="relative flex size-2">
            <span className="absolute inset-0 animate-ping-soft rounded-full bg-brand" />
            <span className="relative size-2 rounded-full bg-brand" />
          </span>
          Pix para infoprodutos e vendas digitais
        </p>
        <h1 className="mx-auto mt-6 max-w-4xl text-4xl leading-[1.05] sm:text-5xl md:text-7xl">
          Receba Pix nas suas <span className="hl">vendas digitais</span>.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          Cobrança com QR Code, aviso por webhook quando o cliente paga e saque para a sua chave Pix. Para quem vende cursos,
          mentorias, e-books, comunidades e SaaS.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href="/cadastro" className="btn btn-primary w-full sm:w-auto">
            Criar conta
            <svg viewBox="0 0 16 16" aria-hidden className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </a>
          {/* /docs tem CSP própria (Scalar): navegação completa, não client-side. */}
          <a href="/docs" className="btn btn-ghost w-full sm:w-auto">
            Ver documentação
          </a>
        </div>
        <p className="mt-5 text-xs text-muted sm:text-sm">
          Sem mensalidade · {FEE_IN} por Pix recebido · {FEE_OUT} por Pix enviado
        </p>
      </div>

      <div className="relative mx-auto max-w-5xl px-4 pb-16 sm:px-6 sm:pb-20">
        <div role="tablist" aria-label="Telas do painel" onKeyDown={onKey} className="mx-auto mb-5 flex w-fit gap-1 rounded-full border border-line bg-white p-1 shadow-sm">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`aba-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === i}
              aria-controls={`tela-${t.id}`}
              tabIndex={tab === i ? 0 : -1}
              onClick={() => setTab(i)}
              className={`h-9 rounded-full px-4 text-sm font-semibold transition-colors sm:px-5 ${tab === i ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="[perspective:1400px]">
          <motion.div
            ref={mockRef}
            style={reduce ? undefined : { scale, rotateX }}
            className="origin-top max-md:transform-none!"
          >
            <div className="overflow-hidden rounded-[28px] border border-line bg-white text-left shadow-[0_40px_100px_-40px_rgb(59_55_242/0.45)]">
              <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
                <span className="size-2.5 rounded-full bg-line" />
                <span className="size-2.5 rounded-full bg-line" />
                <span className="size-2.5 rounded-full bg-line" />
                <span className="ml-2 text-xs font-semibold text-muted">Painel Vantri</span>
                <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink">
                  dados de exemplo
                </span>
              </div>
              <div className="grid md:grid-cols-[180px_1fr]">
                <aside aria-hidden className="hidden border-r border-line bg-bg/60 p-4 md:block">
                  <svg viewBox="0 0 48 48" className="size-7">
                    <Mark />
                  </svg>
                  <ul className="mt-5 space-y-1 text-sm">
                    {NAV.map((n) => (
                      <li
                        key={n}
                        className={`rounded-lg px-3 py-2 ${n === TABS[tab].nav ? "bg-white font-semibold text-ink shadow-sm" : "text-muted"}`}
                      >
                        {n}
                      </li>
                    ))}
                  </ul>
                </aside>
                <div className="min-w-0 bg-bg/30 p-3 sm:p-6">
                  {TABS.map((t, i) => (
                    <div key={t.id} id={`tela-${t.id}`} role="tabpanel" aria-labelledby={`aba-${t.id}`} hidden={tab !== i} className="animate-tab-in">
                      {t.id === "cobranca" ? <Cobranca qr={qr} /> : t.id === "extrato" ? <Extrato /> : <Saque />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
