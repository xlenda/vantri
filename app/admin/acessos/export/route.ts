import { requireAdmin } from "@/lib/auth/guards";
import { accessCsvRows, parseAccessFilters } from "@/lib/services/admin/access";
import { EXPORT_MAX_ROWS, exportName, recordExport, tooManyRows } from "@/lib/services/admin/audit";
import { csvResponse } from "../../admin-lib";

/**
 * /admin/acessos/export?… — registros de acesso do filtro da tela (todas as páginas), para atender ordem judicial.
 * A auditoria guarda `export.access_logs` com o período e o SHA-256 do arquivo; o e-mail/IP buscado não vai para lá.
 */
export async function GET(req: Request): Promise<Response> {
  const { user } = await requireAdmin({ perm: "acessos:exportar" });
  const f = parseAccessFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { header, rows } = await accessCsvRows(f);
  if (rows.length > EXPORT_MAX_ROWS) return tooManyRows();
  const res = csvResponse(exportName("acessos", f), header, rows);
  return recordExport(res, user.id, "export.access_logs", { from: f.from ?? null, to: f.to ?? null });
}
