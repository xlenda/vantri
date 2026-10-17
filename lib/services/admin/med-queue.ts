import { and, asc, count, desc, eq, gte, inArray, lt, notExists, type SQL, sql } from "drizzle-orm";
import { DAY_MS, todayStart } from "@/app/admin/format";
import { db } from "@/lib/db/client";
import { charges, medCases, medEvents, merchants } from "@/lib/db/schema";
import { writeAudit } from "@/lib/services/admin/audit-util";
import { getMedCase, listMedEvents, listMedFiles, MedError, type MedCaseRow } from "@/lib/services/med";

// Fila de MED do admin (todos os lojistas). Quem chama já passou por requireAdmin({ perm: "med:ler" }).

const HOUR_MS = 3_600_000;
const WINDOW_MS = 30 * DAY_MS; // taxa de MED e tempo médio olham os últimos 30 dias
const NOTE_MAX = 2000;

export type DeadlineBucket = "red" | "amber" | "ok";
export type MedQueueRow = MedCaseRow & { tradeName: string; deadlineBucket: DeadlineBucket };

/** Em aberto = ainda sem desfecho (com ou sem defesa). Mesma regra do "MEDs em aberto" do início. */
const isOpenStatus = (s: MedCaseRow["status"]) => s === "open" || s === "defended";
const isOpen = inArray(medCases.status, ["open", "defended"]);
const isClosed = inArray(medCases.status, ["merchant_won", "payer_refunded"]);

/** Cor do prazo da defesa: vermelho < 24 h (ou vencido), âmbar < 72 h. Encerrado não tem mais prazo. */
export function deadlineBucket(c: Pick<MedCaseRow, "status" | "defenseDeadline">, now = Date.now()): DeadlineBucket {
  if (!isOpenStatus(c.status)) return "ok";
  const left = c.defenseDeadline.getTime() - now;
  return left < 24 * HOUR_MS ? "red" : left < 72 * HOUR_MS ? "amber" : "ok";
}

// count/sum são bigint (string no postgres-js): mapWith(Number).
const countWhere = (where: SQL | undefined) => sql`count(*) filter (where ${where})`.mapWith(Number);

export async function medKpis(now = Date.now()): Promise<{
  open: number;
  blockedCents: number;
  dueToday: number;
  overdue: number;
  defensePendingSend: number;
  avgResolutionMs: number | null;
}> {
  const at = new Date(now);
  const sent = db()
    .select({ one: sql`1` })
    .from(medEvents)
    .where(and(eq(medEvents.medCaseId, medCases.id), eq(medEvents.type, "defense_sent")));
  const [k] = await db()
    .select({
      open: countWhere(isOpen),
      blockedCents: sql`coalesce(sum(${medCases.amountCents}) filter (where ${isOpen}), 0)`.mapWith(Number),
      // Vencem ainda hoje (dia de Brasília); os que já passaram contam em `overdue`.
      dueToday: countWhere(
        and(isOpen, gte(medCases.defenseDeadline, at), lt(medCases.defenseDeadline, new Date(todayStart(now) + DAY_MS))),
      ),
      overdue: countWhere(and(isOpen, lt(medCases.defenseDeadline, at))),
      // Defesa do lojista que ainda não foi ao parceiro (envio "requer parceiro").
      defensePendingSend: countWhere(and(eq(medCases.status, "defended"), notExists(sent))),
      // avg de numeric: string nos dois drivers; null sem caso encerrado na janela.
      avgMs: sql<string | null>`avg(extract(epoch from ${medCases.closedAt} - ${medCases.createdAt}) * 1000) filter (where ${gte(medCases.closedAt, new Date(now - WINDOW_MS))})`,
    })
    .from(medCases);
  const { avgMs, ...rest } = k;
  return { ...rest, avgResolutionMs: avgMs === null ? null : Math.round(Number(avgMs)) };
}

/**
 * Abertos por prazo da defesa (o mais urgente primeiro) e, depois, os encerrados, mais novos primeiro.
 * `cursor` = id do último item da página anterior; desconhecido/inválido → página vazia.
 */
export async function listMedByDeadline(
  opts: { limit?: number; cursor?: string; onlyOpen?: boolean } = {},
): Promise<{ data: MedQueueRow[]; nextCursor: string | null }> {
  const limit = Number.isInteger(opts.limit) ? Math.min(Math.max(1, opts.limit!), 100) : 50;
  const at = opts.cursor === undefined ? null : await getMedCase(null, opts.cursor);
  if (opts.cursor !== undefined && !at) return { data: [], nextCursor: null };
  const fromOpen = !at || isOpenStatus(at.status);

  // Compara com os valores do próprio banco (created_at tem microssegundos; o Date do JS, só milissegundos).
  const page = (where: SQL | undefined, order: SQL[], n: number) =>
    db()
      .select({ c: medCases, tradeName: merchants.tradeName })
      .from(medCases)
      .innerJoin(merchants, eq(merchants.id, medCases.merchantId))
      .where(where)
      .orderBy(...order)
      .limit(n);
  let rows = fromOpen
    ? await page(
        and(
          isOpen,
          at
            ? sql`(${medCases.defenseDeadline}, ${medCases.id}) > (select mc.defense_deadline, mc.id from ${medCases} mc where mc.id = ${at.id})`
            : undefined,
        ),
        [asc(medCases.defenseDeadline), asc(medCases.id)],
        limit + 1,
      )
    : [];
  if (!opts.onlyOpen && rows.length <= limit) {
    const after =
      at && !fromOpen
        ? sql`(${medCases.createdAt}, ${medCases.id}) < (select mc.created_at, mc.id from ${medCases} mc where mc.id = ${at.id})`
        : undefined;
    rows = rows.concat(await page(and(isClosed, after), [desc(medCases.createdAt), desc(medCases.id)], limit + 1 - rows.length));
  }

  const now = Date.now();
  const data = rows.slice(0, limit).map(({ c, tradeName }) => ({ ...c, tradeName, deadlineBucket: deadlineBucket(c, now) }));
  return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
}

/**
 * Taxa de MED por lojista: casos abertos ÷ cobranças pagas, nos últimos 30 dias.
 * Sem cobrança paga na janela, divide por 1 (2 MEDs e nenhuma venda = 200%, não 0%).
 */
export async function merchantMedRates(merchantIds: string[], now = Date.now()): Promise<Map<string, number>> {
  const ids = [...new Set(merchantIds)];
  if (!ids.length) return new Map();
  const since = new Date(now - WINDOW_MS);
  const [cases, paid] = await Promise.all([
    db()
      .select({ id: medCases.merchantId, n: count() })
      .from(medCases)
      .where(and(inArray(medCases.merchantId, ids), gte(medCases.createdAt, since)))
      .groupBy(medCases.merchantId),
    db()
      .select({ id: charges.merchantId, n: count() })
      .from(charges)
      .where(and(inArray(charges.merchantId, ids), eq(charges.status, "paid"), gte(charges.paidAt, since)))
      .groupBy(charges.merchantId),
  ]);
  const byId = (rows: Array<{ id: string; n: number }>) => new Map(rows.map((r) => [r.id, r.n]));
  const c = byId(cases);
  const p = byId(paid);
  return new Map(ids.map((id) => [id, (c.get(id) ?? 0) / Math.max(p.get(id) ?? 0, 1)]));
}

/** Tudo do caso para a tela de detalhe; caso inexistente/id inválido → null. */
export async function medCaseDetail(id: string) {
  const c = await getMedCase(null, id);
  if (!c) return null;
  const [[origin], events, files, rates] = await Promise.all([
    db()
      .select({
        tradeName: merchants.tradeName,
        charge: {
          id: charges.id,
          amountCents: charges.amountCents,
          status: charges.status,
          paidAt: charges.paidAt,
          endToEndId: charges.endToEndId,
        },
      })
      .from(charges)
      .innerJoin(merchants, eq(merchants.id, charges.merchantId))
      .where(eq(charges.id, c.chargeId)),
    listMedEvents(c.id, { role: "admin" }),
    listMedFiles(c.id, { role: "admin" }),
    merchantMedRates([c.merchantId]),
  ]);
  return {
    case: c,
    tradeName: origin.tradeName,
    charge: origin.charge,
    events,
    files,
    merchantMedRate: rates.get(c.merchantId) ?? 0,
  };
}

/** Anotação interna (só a equipe vê): evento `note` na linha do tempo + audit_log `med.note` só com ids. */
export async function addMedNote(caseId: string, actorUserId: string, note: string): Promise<void> {
  const text = typeof note === "string" ? note.trim() : "";
  if (!text || text.length > NOTE_MAX) {
    throw new MedError("invalid_request", `A anotação precisa ter entre 1 e ${NOTE_MAX} caracteres.`);
  }
  // jsonb recusa \u0000: viraria erro 500.
  if (text.includes("\u0000")) throw new MedError("invalid_request", "A anotação contém caracteres inválidos.");
  const c = await getMedCase(null, caseId);
  if (!c) throw new MedError("not_found", "Caso de MED não encontrado.");
  await db().transaction(async (tx) => {
    await tx.insert(medEvents).values({ medCaseId: c.id, type: "note", source: "admin", meta: { note: text } });
    await writeAudit(tx, actorUserId, "med.note", { merchantId: c.merchantId, medCaseId: c.id });
  });
}
