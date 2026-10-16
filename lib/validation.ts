import type { z } from "zod";

type Issue = z.ZodError["issues"][number];

/** Primeiro problema do zod em português, sem ecoar o valor recebido. */
export function zodIssueMessage(i: Issue): string {
  return i.code === "unrecognized_keys"
    ? `Campo não permitido: ${i.keys.join(", ")}.`
    : `Campo inválido: ${i.path.join(".") || "entrada"}.`;
}

/** `safeParse`; na falha lança o erro do serviço (`mkError`) com a mensagem do primeiro problema. */
export function parseOr<T extends z.ZodType>(
  schema: T,
  input: unknown,
  mkError: (msg: string) => Error,
): z.output<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw mkError(zodIssueMessage(r.error.issues[0]));
}
