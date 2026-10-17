import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { accessLogs, users } from "@/lib/db/schema";
import { brasilia, EXPORT_MAX_ROWS, first, opt, PAGE_SIZE, pageParam, type Params, period, utc } from "./audit";

// Registros de acesso (Marco Civil da Internet, art. 15): IP + data/hora de cada acesso, guardados por 6 meses.
// Quem chama já passou por requireAdmin({ perm: "acessos:ler" / "acessos:exportar" }).

type AccessEvent = (typeof accessLogs.$inferSelect)["event"];
export type AccessFilters = { email?: string; userId?: string; ip?: string; from?: string; to?: string; page: number };

export const EVENT_LABEL: Record<AccessEvent, string> = {
  login: "Login",
  login_failed: "Login recusado",
  api_call: "Chamada à API",
  session_use: "Uso de sessão",
};

/** Filtros da URL de /admin/acessos. E-mail e IP são busca exata (ordem judicial pede um titular/IP, não um palpite). */
export function parseAccessFilters(sp: Params): AccessFilters {
  return {
    email: opt(z.string().trim().toLowerCase().min(3).max(254), first(sp.email)),
    userId: opt(z.uuid(), first(sp.usuario)),
    ip: opt(z.string().trim().min(1).max(64), first(sp.ip)),
    from: opt(z.iso.date(), first(sp.de)),
    to: opt(z.iso.date(), first(sp.ate)),
    page: pageParam(first(sp.pagina)),
  };
}

function accessQuery(f: AccessFilters) {
  return db()
    .select({
      id: accessLogs.id,
      ip: accessLogs.ip,
      event: accessLogs.event,
      createdAt: accessLogs.createdAt,
      email: users.email,
    })
    .from(accessLogs)
    .leftJoin(users, eq(users.id, accessLogs.userId))
    .where(
      and(
        f.email ? eq(users.email, f.email) : undefined,
        f.userId ? eq(accessLogs.userId, f.userId) : undefined,
        f.ip ? eq(accessLogs.ip, f.ip) : undefined,
        period(accessLogs.createdAt, f),
      ),
    )
    .orderBy(desc(accessLogs.createdAt), desc(accessLogs.id));
}

/** Acessos, mais novos primeiro. `email` é null em tentativa com e-mail que não existe. */
export async function listAccess(f: AccessFilters, limit = PAGE_SIZE) {
  // ponytail: sem índice em access_logs (created_at/ip/user_id); criar numa migração quando a tabela crescer.
  const rows = await accessQuery(f)
    .limit(limit + 1)
    .offset((f.page - 1) * limit);
  return { rows: rows.slice(0, limit), hasNext: rows.length > limit };
}

/** Linhas do CSV, com a data em UTC e em Brasília (todas as do filtro; a página é ignorada). */
export async function accessCsvRows(f: AccessFilters): Promise<{ header: string[]; rows: string[][] }> {
  const rows = await accessQuery(f).limit(EXPORT_MAX_ROWS + 1);
  return {
    header: ["Data/hora (UTC)", "Data/hora (Brasília)", "E-mail", "IP", "Evento"],
    rows: rows.map((r) => [utc(r.createdAt), brasilia(r.createdAt), r.email ?? "", r.ip, EVENT_LABEL[r.event]]),
  };
}

/**
 * Limpeza do Marco Civil: apaga só registro com mais de 6 meses. A conta de mês é do Postgres (31/08 − 6 meses =
 * 28/02); a do JS (setMonth) daria 03/03 e apagaria registro com menos de 6 meses. Devolve quantos apagou.
 */
export async function deleteAccessLogsOlderThan6Months(now = new Date()): Promise<number> {
  const deleted = await db()
    .delete(accessLogs)
    .where(lt(accessLogs.createdAt, sql`${now.toISOString()}::timestamptz - interval '6 months'`))
    .returning({ id: accessLogs.id });
  return deleted.length;
}
