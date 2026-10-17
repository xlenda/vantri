import { requireAdmin } from "@/lib/auth/guards";
import { parseTxFilters } from "../../queries";
import { exportTransactions } from "../lib";

/** /admin/transacoes/export?tipo&cliente&status&de&ate — o filtro da tela, todas as páginas, em CSV. */
export async function GET(req: Request) {
  const { user } = await requireAdmin({ perm: "transacoes:exportar" });
  return exportTransactions(parseTxFilters(Object.fromEntries(new URL(req.url).searchParams)), user.id);
}
