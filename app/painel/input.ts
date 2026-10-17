import { z } from "zod";
import { formText } from "@/app/conta/acesso";
import { SCOPES } from "@/lib/api/keys";
import { parseReais } from "@/lib/br/money";
import { pixKeyProblem } from "@/lib/services/payouts";
import { WEBHOOK_EVENT_TYPES } from "@/lib/services/events";
import { CHARGE_EXPIRY, hasControlChars, phoneKey, PIX_KEY_TYPES } from "./lib";

// Entrada das Server Actions do painel: lista branca (só as chaves do schema saem do FormData) + zod estrito.
// Toda checagem traz a própria mensagem em português: a ação mostra a do primeiro problema.

/** Só as chaves do schema: texto (arquivo vira ""), ou todos os valores de texto quando o campo é array. */
export function formInput<T extends z.ZodObject | z.ZodPipe<z.ZodObject, z.ZodType>>(
  schema: T,
  fd: FormData,
): z.ZodSafeParseResult<z.output<T>> {
  const obj = (schema instanceof z.ZodPipe ? schema.in : schema) as z.ZodObject;
  const raw = Object.fromEntries(
    Object.entries(obj.shape).map(([k, s]) => [
      k,
      s instanceof z.ZodArray ? fd.getAll(k).filter((v) => typeof v === "string") : formText(fd, k),
    ]),
  );
  return schema.safeParse(raw) as z.ZodSafeParseResult<z.output<T>>;
}

/** Mensagem do primeiro problema (todas as checagens abaixo têm mensagem própria). */
export const firstIssue = (e: z.ZodError) => e.issues[0].message;

const money = (msg: string) =>
  z
    .string()
    .max(20, msg)
    .refine((s) => parseReais(s) !== null, msg)
    .transform((s) => parseReais(s)!);

const freeText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `${what} pode ter até ${max} caracteres.`)
    .refine((s) => !hasControlChars(s), `${what} tem caracteres inválidos.`);

export const chargeInput = z.strictObject({
  amount: money("Valor inválido. Digite em reais, por exemplo 49,90 ou 1.234,56."),
  description: freeText(140, "A descrição"),
  expiresIn: z
    .string()
    .refine((s) => CHARGE_EXPIRY.some(([sec]) => String(sec) === s), "Escolha uma validade da lista.")
    .transform(Number),
});

const KEY_TYPES = PIX_KEY_TYPES.map(([t]) => t) as [(typeof PIX_KEY_TYPES)[number][0], ...(typeof PIX_KEY_TYPES)[number][0][]];

export const payoutInput = z
  .strictObject({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9]{24}$/, "Formulário expirado. Recarregue a página e tente de novo."),
    amount: money("Valor inválido. Digite em reais, por exemplo 150,00 ou 1.234,56.")
      .refine((c) => c >= 100, "O valor mínimo do saque é R$ 1,00.")
      .refine((c) => c <= 5_000_000, "O valor máximo por saque é R$ 50.000,00."),
    pixKeyType: z.enum(KEY_TYPES, "Escolha o tipo da chave Pix."),
    pixKey: z.string().trim().min(1, "Informe a chave Pix de destino.").max(100, "A chave Pix pode ter até 100 caracteres."),
    description: freeText(140, "A descrição"),
  })
  // Celular digitado com máscara vira +55…; o formato da chave é conferido aqui, antes do código 2FA.
  .transform((v) => ({ ...v, pixKey: v.pixKeyType === "phone" ? phoneKey(v.pixKey) : v.pixKey }))
  .superRefine((v, ctx) => {
    if (pixKeyProblem(v.pixKeyType, v.pixKey)) {
      const label = PIX_KEY_TYPES.find(([t]) => t === v.pixKeyType)![1];
      ctx.addIssue({ code: "custom", path: ["pixKey"], message: `Chave Pix inválida para ${label}. Confira e tente de novo.` });
    }
  });

export const keyInput = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Dê um nome à chave (até 60 caracteres).")
    .max(60, "Dê um nome à chave (até 60 caracteres).")
    .refine((s) => !hasControlChars(s), "O nome tem caracteres inválidos."),
  scopes: z.array(z.enum(SCOPES, "Escopo inválido.")).min(1, "Escolha ao menos um escopo."),
  ips: z
    .string()
    .max(2000, "Lista de IPs longa demais: use até 20 endereços.")
    .transform((s) => s.split(/[\s,;]+/).filter(Boolean)),
});

export const webhookInput = z.strictObject({
  url: z
    .string()
    .trim()
    .min(1, "Informe a URL do webhook.")
    .max(2048, "URL longa demais (máximo de 2048 caracteres).")
    .refine((s) => !hasControlChars(s), "URL inválida."),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES, "Evento inválido.")).min(1, "Escolha ao menos um evento."),
});

export const idInput = z.strictObject({ id: z.uuid("Item não encontrado.") });

export const defenseInput = z.strictObject({
  caseId: z.uuid("Caso de MED não encontrado."),
  text: z.string().max(5000, "A defesa precisa ter entre 20 e 5000 caracteres."), // mínimo e NUL: o submitDefense
});
