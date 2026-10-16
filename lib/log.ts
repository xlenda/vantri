/**
 * Log de erro sem dado pessoal. O erro de query do Drizzle traz "Failed query … params: …" na mensagem (nome do
 * pagador, chave Pix) e o do Postgres traz `detail` com valores: nada disso sai. Só o contexto, os ids passados,
 * o nome do erro e, em erro de query, o código e a mensagem do Postgres (`cause`).
 */
export function logError(context: string, err: unknown, ids: Record<string, string> = {}): void {
  const e = err as { query?: unknown; params?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const info: Record<string, unknown> = { ...ids, error: err instanceof Error ? err.name : typeof err };
  if (typeof e?.query === "string" && "params" in e) {
    info.code = e.cause?.code;
    info.cause = e.cause?.message;
  }
  console.error(context, JSON.stringify(info));
}
