import Link from "next/link";
import { buttonClass } from "@/app/components/ui/button";

/** Paginação por cursor (só para a frente): volta ao início ou vai para a próxima página. */
export function Pager({ first, next }: { first?: string; next?: string }) {
  if (!first && !next) return null;
  return (
    <div className="flex justify-between gap-3">
      {first ? (
        <Link href={first} className={buttonClass("ghost")}>
          Voltar ao início
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link href={next} className={buttonClass("ghost")}>
          Próxima página
        </Link>
      )}
    </div>
  );
}
