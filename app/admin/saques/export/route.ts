import { requireAdmin } from "@/lib/auth/guards";
import { EXPORT_MAX_ROWS, exportName, recordExport, tooManyRows } from "@/lib/services/admin/audit";
import { parsePayoutOpFilters, payoutsCsvRows } from "@/lib/services/admin/payouts-ops";
import { csvResponse } from "../../admin-lib";

/** /admin/saques/export?cliente&status&presos&de&ate — o filtro da tela, todas as páginas. Entra na auditoria. */
export async function GET(req: Request): Promise<Response> {
  const { user } = await requireAdmin({ perm: "transacoes:exportar" });
  const f = parsePayoutOpFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { header, rows } = await payoutsCsvRows(f);
  if (rows.length > EXPORT_MAX_ROWS) return tooManyRows();
  const res = csvResponse(exportName("saques", f), header, rows);
  return recordExport(res, user.id, "export.payouts", {
    merchantId: f.merchantId ?? null,
    status: f.status ?? null,
    stuck: f.stuck ?? false,
    from: f.from ?? null,
    to: f.to ?? null,
  });
}
