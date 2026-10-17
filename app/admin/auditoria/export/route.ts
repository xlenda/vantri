import { requireAdmin } from "@/lib/auth/guards";
import {
  auditCsvRows,
  EXPORT_MAX_ROWS,
  exportName,
  parseAuditFilters,
  recordExport,
  tooManyRows,
} from "@/lib/services/admin/audit";
import { csvResponse } from "../../admin-lib";

/** /admin/auditoria/export?… — o mesmo filtro da tela, todas as páginas. A exportação também entra na auditoria. */
export async function GET(req: Request): Promise<Response> {
  const { user } = await requireAdmin({ perm: "auditoria:exportar" });
  const f = parseAuditFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { header, rows } = await auditCsvRows(f);
  if (rows.length > EXPORT_MAX_ROWS) return tooManyRows();
  const res = csvResponse(exportName("auditoria", f), header, rows);
  return recordExport(res, user.id, "export.audit_log", { from: f.from ?? null, to: f.to ?? null });
}
