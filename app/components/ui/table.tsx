import { Children, type ReactNode } from "react";

/**
 * Tabela com cabeçalho e linhas (`<tr><td>…</td></tr>` como children). Sem linhas, mostra `empty`.
 * No celular rola na horizontal dentro da própria caixa, sem empurrar a página.
 */
export function Table({
  columns,
  children,
  empty = "Nada por aqui ainda.",
  caption,
}: {
  columns: ReactNode[];
  children?: ReactNode;
  empty?: ReactNode;
  caption?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-white">
      <table className="w-full min-w-[36rem] text-left text-sm [&_td]:px-4 [&_td]:py-3 [&_td]:align-middle">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="border-b border-line bg-bg/60 text-xs font-semibold uppercase tracking-wide text-muted">
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col" className="px-4 py-3 font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {Children.toArray(children).length > 0 ? (
            children
          ) : (
            <tr>
              <td colSpan={columns.length} className="text-center text-muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
