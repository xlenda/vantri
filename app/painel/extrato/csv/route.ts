import { painelSession } from "../../lib";
import { exportResponse } from "../export";

/** /painel/extrato/csv — mesmos filtros da tela (período, tipo, movimento, valor; `visao=fecho` = fechamento diário). */
export async function GET(req: Request) {
  const { merchant } = await painelSession();
  return exportResponse(merchant.id, req, "csv");
}
