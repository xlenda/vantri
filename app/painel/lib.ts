import { notFound } from "next/navigation";
import { totpCode } from "@/app/conta/acesso";
import { requireUser } from "@/lib/auth/guards";
import { verifyUserTotp } from "@/lib/auth/session";
import type { Scope } from "@/lib/api/keys";
import { maskDocument } from "@/lib/br/documents";
import { brl } from "@/lib/br/money";
import type { ledgerEntries, payouts } from "@/lib/db/schema";
import type { WebhookEventType } from "@/lib/services/events";

// Apoio do painel do lojista (sem "use server": nada aqui vira endpoint de Server Action).

/** Sessão de lojista ativo com 2FA. Chamar no layout E em toda ação/rota: o layout sozinho não protege ação. */
export async function painelSession() {
  const { user, merchant } = await requireUser({ role: "merchant" });
  if (!merchant) notFound(); // requireUser de lojista sempre traz o merchant; só estreita o tipo
  return { user, merchant };
}

/**
 * Código 2FA novo (anti-replay) para o que movimenta dinheiro: saque e criação de chave de API (uma chave com
 * payouts:write saca pela API). A mensagem do erro, ou null se o código valeu e foi consumido.
 */
export async function freshTotpProblem(userId: string, fd: FormData): Promise<string | null> {
  const code = totpCode(fd);
  if (!code) return "Digite o código de 6 dígitos do app autenticador.";
  if (!(await verifyUserTotp(userId, code))) {
    return "Código de verificação inválido ou já usado. Espere o próximo código no app e tente de novo.";
  }
  return null;
}

const TZ = "America/Sao_Paulo";
/** Dia civil em Brasília, AAAA-MM-DD. */
export const diaBrasilia = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

export const LEDGER_KIND: Record<(typeof ledgerEntries.$inferSelect)["kind"], string> = {
  cash_in: "Pix recebido",
  fee_in: "Tarifa do Pix recebido",
  cash_out: "Saque",
  fee_out: "Tarifa do saque",
  cash_out_reversal: "Estorno de saque",
  med_hold: "Bloqueio por MED",
  med_release: "Liberação de MED",
  med_debit: "Débito de MED",
  adjustment: "Ajuste",
};

export const LEDGER_BUCKET: Record<(typeof ledgerEntries.$inferSelect)["bucket"], string> = {
  available: "Disponível",
  blocked: "Bloqueado",
};

export const LEDGER_REF: Record<(typeof ledgerEntries.$inferSelect)["refType"], string> = {
  charge: "Cobrança",
  payout: "Saque",
  med_case: "MED",
  manual: "Manual",
};

/**
 * Célula de CSV (separador ";"). Começo que planilha lê como fórmula (= + - @ tab CR) ganha aspa simples na frente
 * (injeção de CSV); com ; aspas ou quebra de linha, vai entre aspas duplas.
 */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Validade da cobrança oferecida no formulário, em segundos (o serviço aceita 300–86400). */
export const CHARGE_EXPIRY: ReadonlyArray<readonly [number, string]> = [
  [900, "15 minutos"],
  [1800, "30 minutos"],
  [3600, "1 hora"],
  [21600, "6 horas"],
  [86400, "24 horas"],
];

/** Taxa legível: 149 bps + 0 → "1,49%"; 0 bps + 100 → "R$ 1,00"; os dois → "1,49% + R$ 1,00". */
export function feeText(bps: number, fixedCents: number): string {
  const pct = bps ? `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : "";
  const fixed = fixedCents ? brl(fixedCents) : "";
  return [pct, fixed].filter(Boolean).join(" + ") || "sem tarifa";
}

/** Controle Unicode (inclui NUL, que o Postgres recusa em text) em texto livre do formulário. */
export const hasControlChars = (s: string) => /\p{Cc}/u.test(s);

export const SCOPE_LABEL: Record<Scope, string> = {
  "balance:read": "Ler saldo",
  "charges:read": "Ler cobranças",
  "charges:write": "Criar cobranças",
  "payouts:read": "Ler saques",
  "payouts:write": "Criar saques",
  "statement:read": "Ler extrato",
  "med:read": "Ler MED",
};

export const EVENT_LABEL: Record<WebhookEventType, string> = {
  "charge.paid": "Cobrança paga",
  "charge.expired": "Cobrança expirada",
  "payout.completed": "Saque concluído",
  "payout.failed": "Saque com falha",
  "med.opened": "MED aberto",
  "med.closed": "MED encerrado",
};

export const PIX_KEY_TYPES = [
  ["cpf", "CPF"],
  ["cnpj", "CNPJ"],
  ["email", "E-mail"],
  ["phone", "Celular"],
  ["evp", "Chave aleatória"],
] as const;

/** Chave Pix na tela: CPF/CNPJ pelo maskDocument; e-mail, celular e aleatória só com as pontas. */
export function maskPixKey(type: (typeof payouts.$inferSelect)["pixKeyType"], key: string): string {
  switch (type) {
    case "cpf":
    case "cnpj":
      return maskDocument(key);
    case "email": {
      const at = key.lastIndexOf("@");
      return at > 0 ? `${key[0]}•••${key.slice(at)}` : "•••";
    }
    case "phone":
      return key.length > 7 ? `${key.slice(0, 5)}•••••${key.slice(-2)}` : "•••";
    case "evp":
      return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "•••";
  }
}

/** Código de falha do cash-out (os 12 do parceiro, mapa §1.14) → motivo em PT. A Cashyin mostra o código cru. */
export const FAILURE_LABEL: Record<string, string> = {
  pix_key_not_found: "Chave Pix não encontrada",
  pix_key_invalid: "Chave Pix inválida",
  pix_key_validation_failed: "Não foi possível validar a chave Pix",
  recipient_bank_rejected: "Recusado pela instituição do favorecido",
  recipient_account_invalid: "Conta do favorecido inválida ou encerrada",
  amount_not_allowed: "Valor não permitido para esta transferência",
  recipient_timeout: "A instituição do favorecido não respondeu a tempo",
  returned_by_recipient: "Devolvido pelo favorecido",
  temporarily_unavailable: "Pix temporariamente indisponível",
  duplicate_request: "Transferência duplicada, recusada para não pagar em dobro",
  under_review: "Retido para análise de segurança",
  processing_failed: "Falha no processamento do Pix",
};

/** Motivo legível, sem ponto final; código ausente ou desconhecido não aparece cru (hasOwn: "constructor" não é motivo). */
export const failureReason = (code: string | null) =>
  code && Object.hasOwn(FAILURE_LABEL, code) ? FAILURE_LABEL[code] : "Não informado pelo banco";

/** Celular digitado como "(11) 98765-4321" → "+5511987654321" (formato do DICT); o resto passa sem mexer. */
export function phoneKey(s: string): string {
  const d = s.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return `+${d}`;
  return s.trim();
}

/** Nome de arquivo para `filename*=UTF-8''…` (RFC 8187): além do encodeURIComponent, escapa ' ( ) * também. */
export const rfc8187 = (name: string) =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Caminho com query string, sem os parâmetros vazios. */
export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return q ? `${path}?${q}` : path;
}

/** Só para links de paginação: id de cursor com cara de UUID, senão nada. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidOrUndefined = (v: string | string[] | undefined) =>
  typeof v === "string" && UUID_RE.test(v) ? v : undefined;
