import Link from "next/link";
import { buttonClass } from "./button";

/** "Anterior / Próxima" por links. `href(n)` monta a URL da página n (mantendo os filtros). */
export function Pager({ page, hasNext, href }: { page: number; hasNext: boolean; href: (page: number) => string }) {
  if (page <= 1 && !hasNext) return null;
  return (
    <nav aria-label="Paginação" className="mt-4 flex items-center justify-between gap-3">
      {page > 1 ? (
        <Link href={href(page - 1)} className={buttonClass("ghost")}>
          Anterior
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm text-muted">Página {page}</span>
      {hasNext ? (
        <Link href={href(page + 1)} className={buttonClass("ghost")}>
          Próxima
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
