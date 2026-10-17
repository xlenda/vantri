import { requireAdmin } from "@/lib/auth/guards";
import { recordExport } from "@/lib/services/admin/audit";
import { searchCsvRows, searchOperations } from "@/lib/services/admin/search";
import { csvResponse } from "../../admin-lib";
import { todayDate } from "../../format";

/** /admin/busca/export?q= — o mesmo resultado da tela em CSV. A auditoria guarda quantas linhas, nunca o termo. */
export async function GET(req: Request): Promise<Response> {
  const { user } = await requireAdmin({ perm: "transacoes:exportar" });
  const { header, rows } = searchCsvRows(await searchOperations(new URL(req.url).searchParams.get("q") ?? ""));
  // Nome do arquivo só com a data do dia: o termo (pode ser nome/e-mail) não vai para o nome.
  return recordExport(csvResponse(`busca-vantri-${todayDate()}.csv`, header, rows), user.id, "export.search", {
    rows: rows.length,
  });
}
