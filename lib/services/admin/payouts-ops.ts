import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { DAY_MS, dayStart, reais } from "@/app/admin/format";
import { PAGE_SIZE, STUCK_PAYOUT_MIN } from "@/app/admin/queries";
import { KEY_TYPES, STATUS_LABEL, when } from "@/app/admin/transacoes/lib";
import { maskPixKey } from "@/app/painel/lib";
import { db } from "@/lib/db/client";
import { auditLog, merchants, payouts, users } from "@/lib/db/schema";
import { type PayoutRow, toPayoutJson } from "@/lib/services/payouts";
import { type AuditLogRow, EXPORT_MAX_ROWS, first, opt, type Params, pageParam } from "./audit";

// Operação de saques do admin (todos os lojistas). Leitura: quem chama passou por requireAdmin({ perm: "transacoes:ler" }).

export type PayoutOpFilters = {
  merchantId?: string;
  status?: PayoutRow["status"];
  stuck?: boolean;
  from?: string;
  to?: string;
  page: number;
};

/** Filtros da URL de /admin/saques (e da exportação, que ignora a página). Lista branca: inválido fica sem filtro. */
export function parsePayoutOpFilters(sp: Params): PayoutOpFilters {
  return {
    merchantId: opt(z.uuid(), first(sp.cliente)),
    status: opt(z.enum(payouts.status.enumValues), first(sp.status)),
    stuck: first(sp.presos) === "1" || undefined,
    from: opt(z.iso.date(), first(sp.de)),
    to: opt(z.iso.date(), first(sp.ate)),
    page: pageParam(first(sp.pagina)),
  };
}

/**
 * "Presos" = processing criado há mais de STUCK_PAYOUT_MIN (o mesmo número da fila do início), o mais antigo
 * primeiro; sem esse filtro, os mais novos primeiro. Período em dias de Brasília pela criação, `to` inclusivo.
 */
function opsQuery(f: PayoutOpFilters, now: number) {
  return db()
    .select({ payout: payouts, tradeName: merchants.tradeName })
    .from(payouts)
    .innerJoin(merchants, eq(merchants.id, payouts.merchantId))
    .where(
      and(
        f.merchantId ? eq(payouts.merchantId, f.merchantId) : undefined,
        f.status ? eq(payouts.status, f.status) : undefined,
        f.stuck
          ? and(eq(payouts.status, "processing"), lt(payouts.createdAt, new Date(now - STUCK_PAYOUT_MIN * 60_000)))
          : undefined,
        f.from ? gte(payouts.createdAt, new Date(dayStart(f.from))) : undefined,
        f.to ? lt(payouts.createdAt, new Date(dayStart(f.to) + DAY_MS)) : undefined,
      ),
    )
    .orderBy(...(f.stuck ? [asc(payouts.createdAt), asc(payouts.id)] : [desc(payouts.createdAt), desc(payouts.id)]));
}

const ageMin = (p: PayoutRow, now: number) => Math.max(0, Math.floor((now - p.createdAt.getTime()) / 60_000));

/** Idade para a tela: 14 → "14 min"; 125 → "2 h 5 min"; 3000 → "2 d 2 h". */
export function ageText(min: number): string {
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
}

export async function listPayoutsOps(
  f: PayoutOpFilters,
  limit = PAGE_SIZE,
  now = Date.now(),
): Promise<{ rows: Array<{ payout: PayoutRow; tradeName: string; ageMin: number }>; hasNext: boolean }> {
  const rows = await opsQuery(f, now)
    .limit(limit + 1)
    .offset((f.page - 1) * limit);
  return {
    rows: rows.slice(0, limit).map((r) => ({ ...r, ageMin: ageMin(r.payout, now) })),
    hasNext: rows.length > limit,
  };
}

export type PayoutEvent = AuditLogRow & { actorEmail: string | null };

/**
 * Saque + linha do tempo do audit_log: consultas/reenvios (do cron e do admin), o pedido de quatro olhos, a decisão
 * (achada pelo approvalId do pedido) e o efeito. Mais antigo primeiro; empate (mesma transação) pela ação, que põe a
 * decisão antes do efeito. Só o e-mail do autor sai de `users`. Id inválido ou inexistente → null.
 */
export async function payoutDetail(id: string): Promise<{ payout: PayoutRow; tradeName: string; events: PayoutEvent[] } | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [r] = await db()
    .select({ payout: payouts, tradeName: merchants.tradeName })
    .from(payouts)
    .innerJoin(merchants, eq(merchants.id, payouts.merchantId))
    .where(eq(payouts.id, id));
  if (!r) return null;
  const requests = sql`(select a.meta->>'approvalId' from ${auditLog} a where a.action = 'approval.request' and a.meta->>'payoutId' = ${id})`;
  const events = await db()
    .select({ log: auditLog, actorEmail: users.email })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(or(sql`${auditLog.meta}->>'payoutId' = ${id}`, sql`${auditLog.meta}->>'approvalId' in ${requests}`))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.action));
  return { ...r, events: events.map(({ log, actorEmail }) => ({ ...log, actorEmail })) };
}

/**
 * CSV do filtro da tela (todas as páginas), até EXPORT_MAX_ROWS + 1 para a rota saber que passou. Sai do JSON público
 * + id no parceiro e idade; chave mascarada; nada de request_hash nem chave de idempotência.
 */
export async function payoutsCsvRows(f: PayoutOpFilters, now = Date.now()): Promise<{ header: string[]; rows: string[][] }> {
  const rows = await opsQuery(f, now).limit(EXPORT_MAX_ROWS + 1);
  return {
    header: [
      "Pedido em",
      "Cliente",
      "ID do saque",
      "Valor (R$)",
      "Tarifa (R$)",
      "Tipo de chave",
      "Chave Pix (mascarada)",
      "Status",
      "Minutos em processamento",
      "Código da falha",
      "ID no parceiro",
      "ID da transação (E2E)",
      "Concluído em",
    ],
    rows: rows.map(({ payout: p, tradeName }) => {
      const j = toPayoutJson(p);
      return [
        when(j.created_at),
        tradeName,
        j.id,
        reais(j.amount),
        reais(j.fee),
        KEY_TYPES[j.pix_key_type],
        maskPixKey(j.pix_key_type, j.pix_key),
        STATUS_LABEL.saques[j.status],
        j.status === "processing" ? String(ageMin(p, now)) : "",
        j.failure_code ?? "",
        p.providerPayoutId ?? "",
        j.end_to_end_id ?? "",
        when(j.completed_at),
      ];
    }),
  };
}
