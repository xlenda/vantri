import { Reveal } from "./Reveal";

export function CtaFinal() {
  return (
    <section aria-labelledby="cta-titulo" className="relative overflow-hidden bg-ink text-white">
      {/* Listras e brilho em CSS puro (nada de PNG de fundo). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60 [background:repeating-linear-gradient(90deg,rgb(59_55_242/0.22)_0_28px,transparent_28px_56px)] [mask-image:linear-gradient(to_right,transparent,#000_30%,#000_70%,transparent)]"
      />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 left-1/2 h-80 w-[min(900px,140vw)] -translate-x-1/2 rounded-full bg-brand/45 blur-3xl" />
      <Reveal className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-28">
        <h2 id="cta-titulo" className="text-3xl sm:text-5xl md:text-6xl">
          Pronto para receber Pix nas suas vendas?
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-white/75 sm:text-lg">
          Crie a conta, envie seus dados para análise e comece a cobrar pelo painel ou pela API.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href="/cadastro" className="btn btn-accent w-full sm:w-auto">
            Criar conta
          </a>
          <a href="/docs" className="btn w-full border border-white/25 text-white hover:border-white sm:w-auto">
            Ver documentação
          </a>
        </div>
      </Reveal>
    </section>
  );
}
