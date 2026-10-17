import { createHash } from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { accessLogs, auditLog, merchants, users } from "@/lib/db/schema";
import { writeAudit } from "./audit-util";

// Leituras da Auditoria (audit_log) e o apoio que a tela de Acessos (./access.ts) reusa: filtros da URL,
// período em dia de Brasília, carimbo de data em UTC + Brasília, teto e auditoria das exportações.
// Quem chama já passou por requireAdmin({ perm }).

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditFilters = { actorUserId?: string; action?: string; merchantId?: string; from?: string; to?: string; page: number };
export type Params = Record<string, string | string[] | undefined>;

export const PAGE_SIZE = 25;
// ponytail: o arquivo inteiro é montado em memória e a resposta da Vercel vai até 4,5 MB. Acima do teto a rota
// recusa (nunca corta calado); streaming se precisar de mais.
export const EXPORT_MAX_ROWS = 20_000;

/** Rótulo em PT das ações do writeAudit (`recurso.verbo`). Ação sem rótulo aparece pelo código. */
const ACTION_LABEL: Record<string, string> = {
  "merchant.create": "Cliente criado",
  "merchant.approve": "Cliente aprovado",
  "merchant.reject": "Cliente recusado",
  "merchant.suspend": "Cliente suspenso",
  "merchant.reactivate": "Cliente reativado",
  "merchant.update_fees": "Taxas do cliente alteradas",
  "med.open_test": "MED de teste aberto",
  "med.close": "MED encerrado",
  "export.audit_log": "Auditoria exportada",
  "export.access_logs": "Registros de acesso exportados",
  // Nomes padronizados no plano do admin para as próximas telas.
  "payout.repoll": "Saque consultado no parceiro",
  "payout.resend": "Saque reenviado ao parceiro",
  "payout.force_fail": "Saque marcado como falho",
  "balance.adjust": "Ajuste de saldo",
  "webhook.resend": "Webhook reenviado",
  "webhook.endpoint_disable": "Endpoint de webhook desativado",
  "user.reset_2fa": "2FA zerado",
  "user.force_password": "Troca de senha exigida",
  "user.drop_sessions": "Sessões derrubadas",
  "user.unlock": "Usuário desbloqueado",
  "role.set": "Papel de admin alterado",
  "approval.request": "Pedido de quatro olhos aberto",
  "approval.approve": "Pedido de quatro olhos aprovado",
  "approval.reject": "Pedido de quatro olhos recusado",
  "fee_plan.create": "Plano de tarifa criado",
  "export.transactions": "Transações exportadas",
  "export.payouts": "Saques exportados",
  "export.search": "Busca exportada",
};
export const actionLabel = (action: string) => (Object.hasOwn(ACTION_LABEL, action) ? ACTION_LABEL[action] : action);

export const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** Valor que passa no schema, senão nada (filtro de URL é lista branca: inválido fica sem aquele filtro). */
export const opt = <T extends z.ZodType>(s: T, v: unknown): z.output<T> | undefined => {
  const r = s.safeParse(v);
  return r.success ? r.data : undefined;
};
export const pageParam = (v: unknown) => opt(z.coerce.number().int().min(1).max(10_000), v) ?? 1;

/** Filtros da URL de /admin/auditoria (e da exportação, que ignora a página). */
export function parseAuditFilters(sp: Params): AuditFilters {
  return {
    actorUserId: opt(z.uuid(), first(sp.quem)),
    action: opt(z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/).max(64), first(sp.acao)),
    merchantId: opt(z.uuid(), first(sp.cliente)),
    from: opt(z.iso.date(), first(sp.de)),
    to: opt(z.iso.date(), first(sp.ate)),
    page: pageParam(first(sp.pagina)),
  };
}

const DAY_MS = 86_400_000;
// Dia civil de Brasília (UTC−3, sem horário de verão desde 2019), como no restante do admin.
const dayStart = (date: string) => Date.parse(`${date}T00:00:00-03:00`);

/** Período em dias de Brasília; `to` inclusivo. */
export const period = (col: typeof auditLog.createdAt | typeof accessLogs.createdAt, f: { from?: string; to?: string }) =>
  and(
    f.from ? gte(col, new Date(dayStart(f.from))) : undefined,
    f.to ? lt(col, new Date(dayStart(f.to) + DAY_MS)) : undefined,
  );

const brt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium" });
/** Data/hora com segundos: UTC em ISO 8601 (sem ambiguidade) e Brasília ("16/10/2026, 21:07:05"). */
export const utc = (d: Date) => d.toISOString();
export const brasilia = (d: Date) => brt.format(d);

function auditQuery(f: AuditFilters) {
  return db()
    .select({
      log: auditLog,
      actorEmail: users.email,
      merchant: { id: merchants.id, tradeName: merchants.tradeName },
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    // Comparação em texto: um meta.merchantId fora do formato de UUID não derruba a consulta.
    .leftJoin(merchants, sql`${merchants.id}::text = ${auditLog.meta}->>'merchantId'`)
    .where(
      and(
        f.actorUserId ? eq(auditLog.actorUserId, f.actorUserId) : undefined,
        f.action ? eq(auditLog.action, f.action) : undefined,
        f.merchantId ? sql`${auditLog.meta}->>'merchantId' = ${f.merchantId}` : undefined, // parametrizado
        period(auditLog.createdAt, f),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id));
}

/** Auditoria, mais novos primeiro. Só o e-mail do autor sai de `users` (nunca hash de senha nem segredo). */
export async function listAudit(f: AuditFilters, limit = PAGE_SIZE) {
  const rows = await auditQuery(f)
    .limit(limit + 1)
    .offset((f.page - 1) * limit);
  return { rows: rows.slice(0, limit), hasNext: rows.length > limit };
}

/** Opções dos filtros "Quem" (todo usuário admin) e "Ação" (as que já aconteceram). */
export async function auditFilterOptions() {
  // ponytail: DISTINCT varre o audit_log; índice em action se a tabela passar de centenas de milhares de linhas.
  const [actors, actions] = await Promise.all([
    db().select({ id: users.id, email: users.email }).from(users).where(eq(users.role, "admin")).orderBy(users.email),
    db().selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(auditLog.action),
  ]);
  return { actors, actions: actions.map((a) => a.action) };
}

/** Linhas do CSV: todas as do filtro (a página é ignorada), até EXPORT_MAX_ROWS + 1 para a rota saber que passou. */
export async function auditCsvRows(f: AuditFilters): Promise<{ header: string[]; rows: string[][] }> {
  const rows = await auditQuery(f).limit(EXPORT_MAX_ROWS + 1);
  return {
    header: ["Data/hora (UTC)", "Data/hora (Brasília)", "Autor", "Ação", "Descrição", "Cliente", "Detalhes"],
    rows: rows.map(({ log, actorEmail, merchant }) => [
      utc(log.createdAt),
      brasilia(log.createdAt),
      actorEmail ?? "Sistema",
      log.action,
      actionLabel(log.action),
      merchant?.tradeName ?? "",
      JSON.stringify(log.meta),
    ]),
  };
}

/**
 * Grava a exportação na auditoria com o SHA-256 dos bytes do arquivo (o que a pessoa baixa, com o BOM: quem
 * recebe o CSV numa ordem judicial confere com `sha256sum`) e devolve a mesma resposta. Sem auditoria, sem arquivo.
 * `meta` só com período/ids, nunca o e-mail ou IP buscado.
 */
export async function recordExport(
  res: Response,
  actorUserId: string,
  action: `export.${string}`,
  meta: Record<string, unknown>,
): Promise<Response> {
  const sha256 = createHash("sha256")
    .update(new Uint8Array(await res.clone().arrayBuffer()))
    .digest("hex");
  await db().transaction((tx) => writeAudit(tx, actorUserId, action, { ...meta, sha256 }));
  return res;
}

/** Resposta da rota quando o filtro passa do teto de linhas. */
export const tooManyRows = () =>
  new Response("Registros demais para um arquivo só. Escolha um período menor ou mais filtros.", {
    status: 422,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

/** Nome do arquivo: só com datas já validadas por z.iso.date(). */
export const exportName = (base: string, f: { from?: string; to?: string }) =>
  f.from || f.to ? `${base}_${f.from ?? "inicio"}_a_${f.to ?? "hoje"}.csv` : `${base}.csv`;
