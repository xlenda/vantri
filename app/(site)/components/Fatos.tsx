import { Counter } from "./Counter";
import { Reveal } from "./Reveal";

// Fatos do produto, não de volume: nada de "processado", "clientes" ou "uptime".
export function Fatos() {
  return (
    <section id="produto" aria-labelledby="fatos-titulo" className="border-y border-line bg-white/60">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 id="fatos-titulo" className="sr-only">
          O produto em quatro fatos
        </h2>
        <Reveal className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
          <Counter prefix="R$ " to={0} label="de mensalidade e de taxa de setup" />
          <Counter prefix="D+" to={0} label="o valor líquido entra no saldo quando o Pix é confirmado" />
          <Counter to={7} label="tentativas de entrega para cada webhook" />
          <Counter to={2} suffix="FA" label="obrigatório no login e em todo saque" />
        </Reveal>
      </div>
    </section>
  );
}
