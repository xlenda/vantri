import { buttonClass } from "@/app/components/ui/button";

// Campo escuro próprio (não reusa inputClass: ele é claro e brigaria com o fundo do shell).
// text-base (16px) no mobile evita o zoom do iOS ao focar.
const darkInput =
  "block h-10 w-full rounded-xl border border-white/15 bg-white/10 px-3.5 text-base text-white transition-colors placeholder:text-white/50 focus:border-white/40 focus:outline-none focus:ring-4 focus:ring-white/10 sm:text-[15px]";

/**
 * Busca global "Localizar operação": GET para /admin/busca (a Task 14 lê `q` e devolve o resumo).
 * Form nativo — navega e limpa sem JS; não vaza nada por si, quem decide o que mostrar é a rota.
 */
export function AdminSearch({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <form action="/admin/busca" role="search" className="flex items-center gap-2">
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        aria-label="Localizar operação"
        placeholder="Localizar operação (cliente, txid, saque…)"
        className={darkInput}
      />
      <button type="submit" className={buttonClass("accent", "h-10 px-4")}>
        Consultar
      </button>
      <button type="reset" className={buttonClass("ghost", "h-10 border-white/15 bg-transparent px-4 text-white hover:border-white/50")}>
        Limpar
      </button>
    </form>
  );
}
