"use client";

import type { ReactNode } from "react";
import { SITE_URL } from "../site";
import { Reveal, usePlay } from "./Reveal";

// Evento charge.paid real: envelope de webhook ({ id, type, created_at, data }) com `data` no
// formato da Charge da API, sem qr_code_base64 (webhook não leva o QR). txid tem 25 base62. brcode encurtado.
const EVENT = {
  id: "evt_4hT9qLx2VbN7cR1mZs8KdWfE",
  type: "charge.paid",
  created_at: "2026-10-16T14:02:11.000Z",
  data: {
    id: "6f1c2b8e-3d4a-4c5b-9e7f-1a2b3c4d5e6f",
    txid: "Vt7Kq2Lm9Xp4Rs8Nw3Yz6Bc1D",
    external_ref: "pedido_1042",
    amount: 19700,
    fee: 294,
    net: 19406,
    description: "Curso de Fotografia (turma 3)",
    status: "paid",
    brcode: "00020101021226870014br.gov.bcb.pix…",
    expires_at: "2026-10-16T15:01:47.000Z",
    paid_at: "2026-10-16T14:02:10.000Z",
    payer: { name: "Ana Ribeiro", document_masked: "***.456.789-**" },
    end_to_end_id: "E00000000202610161402aB3cD4eF5gH",
    created_at: "2026-10-16T14:01:47.000Z",
  },
};
// Assinatura real deste exemplo: t = created_at em segundos Unix, v1 = HMAC-SHA256 em hex com o segredo
// de exemplo "whsec_exemplo" sobre `${t}.${JSON.stringify(EVENT)}`. Mudou o EVENT? Recalcule.
const SIGNATURE = "t=1792159331,v1=c1eb8b186ce44f9ce22f8d4694a55e6429cf1b2012eb653e2a6bc2e37f7707bb";

const REQUEST = [
  `curl -X POST ${SITE_URL}/api/v1/charges \\`,
  `  -H "Authorization: Bearer vk_live_…" \\`,
  `  -H "Content-Type: application/json" \\`,
  `  -d '{`,
  `    "external_ref": "pedido_1042",`,
  `    "amount": 19700,`,
  `    "description": "Curso de Fotografia (turma 3)",`,
  `    "expires_in": 3600`,
  `  }'`,
];

// Pinta chaves, strings e números de uma linha de JSON (sem lookbehind: iOS 15).
function paint(line: string): ReactNode[] {
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?|true|false|null)/g;
  const out: ReactNode[] = [];
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out.push(line.slice(last, m.index));
    if (m[1]) {
      out.push(
        <span key={m.index} className={m[2] ? "text-[#b4b8ff]" : "text-accent"}>
          {m[1]}
        </span>,
        m[2] ?? "",
      );
    } else {
      out.push(
        <span key={m.index} className="text-[#ffc98a]">
          {m[3]}
        </span>,
      );
    }
    last = re.lastIndex;
  }
  out.push(line.slice(last));
  return out;
}

function Check({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent">
        <svg viewBox="0 0 16 16" aria-hidden className="size-3" fill="none" stroke="var(--color-ink)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  );
}

function Webhook() {
  const [ref, phase] = usePlay<HTMLDivElement>(0.2);
  const lines = JSON.stringify(EVENT, null, 2).split("\n");
  return (
    <div ref={ref} data-phase={phase} className="group min-w-0 overflow-hidden rounded-3xl bg-ink text-white shadow-[0_30px_80px_-30px_rgb(59_55_242/0.6)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
        <p className="font-mono text-xs text-white/80">
          webhook · <span className="text-accent">charge.paid</span>
        </p>
        <p className="inline-flex items-center gap-2 text-xs font-semibold text-white/80">
          <span className="relative flex size-2">
            <span className="absolute inset-0 animate-ping-soft rounded-full bg-accent" />
            <span className="relative size-2 rounded-full bg-accent" />
          </span>
          ao vivo
        </p>
      </div>
      <pre className="overflow-x-auto px-5 py-4 font-mono text-[11.5px] leading-[1.7] sm:text-xs">
        <code>
          <span className="block text-white/60">POST /seu-endpoint</span>
          <span className="block text-white/60">Content-Type: application/json</span>
          <span className="mb-2 block">
            <span className="text-white/60">X-Vantri-Signature: </span>
            <span className="text-accent">{SIGNATURE}</span>
          </span>
          {lines.map((l, i) => (
            <span
              key={i}
              style={{ transitionDelay: `${i * 45}ms` }}
              className="block text-white/70 transition duration-300 group-data-[phase=waiting]:translate-x-[-6px] group-data-[phase=waiting]:opacity-0"
            >
              {paint(l)}
            </span>
          ))}
        </code>
      </pre>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-5 py-3 text-xs text-white/70">
        <span className="inline-flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden />
          200 OK · tentativa 1 de 7
        </span>
        <span className="font-mono">exemplo · segredo whsec_exemplo</span>
        <p className="w-full text-white/60">
          A assinatura cobre o corpo cru, exatamente como chegou (JSON compacto). O JSON formatado acima é só para leitura: copiado assim,
          não confere.
        </p>
      </div>
    </div>
  );
}

export function Dev() {
  return (
    <section id="dev" aria-labelledby="dev-titulo" className="border-y border-line bg-white/60 py-16 sm:py-24">
      <div className="mx-auto grid max-w-6xl items-start gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
        <Reveal className="min-w-0 lg:sticky lg:top-28">
          <p className="eyebrow">Para desenvolvedores</p>
          <h2 id="dev-titulo" className="mt-3 text-3xl sm:text-4xl md:text-5xl">
            Uma chamada cria a cobrança. <span className="hl">Um webhook avisa que pagou.</span>
          </h2>
          <p className="mt-5 text-base leading-relaxed text-muted sm:text-lg">
            API REST em JSON, valores em centavos e contrato OpenAPI 3.1. O mesmo <code className="font-mono text-ink">external_ref</code>{" "}
            não gera cobrança duplicada, e o header <code className="font-mono text-ink">Idempotency-Key</code> não deixa sair saque em dobro.
          </p>
          <ul className="mt-6 space-y-3 text-sm sm:text-base">
            <Check>Chave Bearer com escopos e lista de IPs permitidos</Check>
            <Check>
              Webhooks assinados no header <code className="font-mono">X-Vantri-Signature</code> (HMAC-SHA256 com timestamp)
            </Check>
            <Check>Até 7 tentativas de entrega, com reenvio manual pelo painel</Check>
            <Check>
              OpenAPI 3.1 em <code className="font-mono">/api/v1/openapi.json</code>
            </Check>
            <Check>Limite de 120 requisições por minuto por chave</Check>
          </ul>
          <a href="/docs" className="btn btn-primary mt-8">
            Ler a documentação
          </a>
        </Reveal>

        <div className="grid min-w-0 gap-5">
          <Reveal className="min-w-0">
            <div className="overflow-hidden rounded-3xl border border-line bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                <p className="font-mono text-xs">
                  <span className="font-bold text-brand">POST</span> /api/v1/charges
                </p>
                <span className="rounded-full bg-accent px-2.5 py-0.5 font-mono text-[11px] font-bold">201 Created</span>
              </div>
              <pre className="overflow-x-auto px-5 py-4 font-mono text-[11.5px] leading-[1.7] text-ink/80 sm:text-xs">
                <code>
                  {REQUEST.map((l, i) => (
                    <span key={i} className="block">
                      {l}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          </Reveal>
          <Reveal className="min-w-0" delay={120}>
            <Webhook />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
