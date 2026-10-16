import { EXAMPLE, FEE_IN, FEE_OUT, PSP_NAME } from "../site";
import { Reveal } from "./Reveal";

const INCLUSO = [
  "Painel com extrato, saldo e exportação em CSV",
  "QR Code dinâmico e Pix copia e cola",
  "API REST, webhooks assinados e OpenAPI 3.1",
  "2FA, chaves com escopo e lista de IPs",
  "MED com defesa pelo painel",
  `Conta própria na ${PSP_NAME}`,
];

export function Precos() {
  return (
    <section id="precos" aria-labelledby="precos-titulo" className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Preço</p>
          <h2 id="precos-titulo" className="mt-3 text-3xl sm:text-4xl md:text-5xl">
            Pague só quando <span className="hl">vender</span>.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">Um plano só, sem mensalidade e sem setup. A tarifa é descontada do saldo, Pix a Pix.</p>
        </Reveal>

        <Reveal className="mx-auto mt-12 max-w-4xl">
          <div className="grid overflow-hidden rounded-[28px] border border-line bg-white shadow-[0_30px_80px_-40px_rgb(59_55_242/0.45)] md:grid-cols-[1.05fr_1fr]">
            <div className="relative overflow-hidden bg-ink p-7 text-white sm:p-9">
              <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-brand/50 blur-3xl" />
              <div className="relative">
                <p className="inline-flex rounded-full bg-accent px-3 py-1 text-xs font-bold text-ink">Pague pelo uso</p>
                <p className="mt-6 text-6xl font-bold tracking-tight tabular-nums sm:text-7xl">{FEE_IN}</p>
                <p className="mt-1 text-white/75">por Pix recebido</p>
                <p className="mt-6 text-3xl font-bold tabular-nums">{FEE_OUT}</p>
                <p className="mt-1 text-white/75">por Pix enviado (saque)</p>
                <ul className="mt-6 flex flex-wrap gap-2 text-xs font-semibold">
                  <li className="rounded-full border border-white/20 px-3 py-1">Sem mensalidade</li>
                  <li className="rounded-full border border-white/20 px-3 py-1">Sem setup</li>
                </ul>
                <a href="/cadastro" className="btn btn-accent mt-8 w-full sm:w-auto">
                  Criar conta
                </a>
              </div>
            </div>
            <div className="p-7 sm:p-9">
              <h3 className="text-base">Tudo incluso</h3>
              <ul className="mt-4 space-y-3 text-sm">
                {INCLUSO.map((t) => (
                  <li key={t} className="flex gap-3">
                    <svg viewBox="0 0 16 16" aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                    {t}
                  </li>
                ))}
              </ul>
              <div className="mt-7 rounded-2xl bg-bg p-4 text-sm">
                <p className="font-semibold">Na prática</p>
                <dl className="mt-2 space-y-1 tabular-nums">
                  <div className="flex justify-between">
                    <dt className="text-muted">Venda</dt>
                    <dd>{EXAMPLE.sale}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Tarifa ({FEE_IN})</dt>
                    <dd>−{EXAMPLE.fee}</dd>
                  </div>
                  <div className="flex justify-between border-t border-line pt-1 font-bold">
                    <dt>Fica com você</dt>
                    <dd>{EXAMPLE.net}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
