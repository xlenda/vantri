import { painelSession } from "../../lib";
import { exportResponse } from "../export";

/** /painel/extrato/xlsx — o mesmo arquivo do CSV em Excel (dinheiro como número; texto protegido contra fórmula). */
export async function GET(req: Request) {
  const { merchant } = await painelSession();
  return exportResponse(merchant.id, req, "xlsx");
}
