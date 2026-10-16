import { FEE_IN, FEE_OUT, RC16 } from "../site";
import { Reveal } from "./Reveal";

// O mesmo array gera o FAQ visível e o JSON-LD FAQPage (page.tsx): nunca divergem.
export const FAQS: { q: string; a: string }[] = [
  {
    q: "O que é a Vantri?",
    a: "Uma plataforma de cobrança Pix para quem vende produto digital. Você gera cobranças com QR Code pelo painel ou pela API, recebe o aviso de pagamento por webhook e saca o saldo para a sua chave Pix.",
  },
  { q: "A Vantri é um banco?", a: `Não. ${RC16}` },
  {
    q: "Quanto custa?",
    a: `${FEE_IN} por Pix recebido e ${FEE_OUT} por Pix enviado (saque). Sem mensalidade e sem taxa de setup.`,
  },
  {
    q: "Quando o dinheiro fica disponível?",
    a: "Assim que o Pix é confirmado, o valor líquido (já sem a tarifa) entra no seu saldo disponível. Se o pagador abrir um MED, só o valor contestado fica bloqueado até a decisão.",
  },
  {
    q: "Como integro com o meu checkout?",
    a: "Pela API REST, com chave Bearer que tem escopos e lista de IPs. Você cria a cobrança em POST /api/v1/charges e recebe o evento charge.paid no seu webhook, assinado no header X-Vantri-Signature. A documentação completa fica em /docs.",
  },
  {
    q: "Preciso ter CNPJ?",
    a: "Não. Dá para se cadastrar com CPF ou CNPJ. Todo cadastro passa por análise antes de liberar o acesso.",
  },
  {
    q: "O que é MED?",
    a: "É o Mecanismo Especial de Devolução do Pix, usado quando há suspeita de fraude ou falha operacional. Quando um MED é aberto, o valor contestado fica bloqueado e você envia a sua defesa pelo painel, com texto e anexos.",
  },
  { q: "Atendem apostas?", a: "Não." },
];

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-titulo" className="border-t border-line bg-white/60 py-16 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <Reveal className="text-center">
          <p className="eyebrow">Perguntas frequentes</p>
          <h2 id="faq-titulo" className="mt-3 text-3xl sm:text-4xl md:text-5xl">
            Dúvidas <span className="hl">comuns</span>
          </h2>
        </Reveal>
        <Reveal className="mt-10">
          <div className="divide-y divide-line border-y border-line">
            {FAQS.map(({ q, a }) => (
              <details key={q} className="group py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-base font-semibold [&::-webkit-details-marker]:hidden">
                  {q}
                  <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-lg leading-none transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="pb-5 pr-10 text-sm leading-relaxed text-muted sm:text-base">{a}</p>
              </details>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
