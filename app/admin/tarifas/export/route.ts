import { z } from "zod";
import { csvResponse } from "@/app/admin/admin-lib";
import { requireAdmin } from "@/lib/auth/guards";
import { dateTime } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { writeAudit } from "@/lib/services/admin/audit-util";
import { feeHistory } from "@/lib/services/admin/fee-plans";
import { percent, reais } from "../../format";

const HEADER = [
  "Vigente desde (Brasília)",
  "Pix recebido (%)",
  "Pix recebido fixo (R$)",
  "Pix enviado (%)",
  "Pix enviado fixo (R$)",
  "Plano",
  "Alterado por",
];

/** /admin/tarifas/export?cliente=<id> — histórico de vigência de taxa de um cliente. Quem baixou fica na auditoria. */
export async function GET(req: Request) {
  const { user } = await requireAdmin({ perm: "tarifas:gerir" });
  const merchantId = new URL(req.url).searchParams.get("cliente") ?? "";
  if (!z.uuid().safeParse(merchantId).success) {
    return new Response("Cliente inválido.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const rows = (await feeHistory(merchantId)).map((r) => [
    dateTime(r.effectiveFrom),
    percent(r.feeInBps),
    reais(r.feeInFixedCents),
    percent(r.feeOutBps),
    reais(r.feeOutFixedCents),
    r.planName ?? "Personalizada",
    r.actorEmail ?? "",
  ]);
  await db().transaction((tx) => writeAudit(tx, user.id, "export.fee_history", { merchantId, rows: rows.length }));
  // merchantId já passou pelo z.uuid(): seguro no nome do arquivo.
  return csvResponse(`historico-tarifas-${merchantId}.csv`, HEADER, rows);
}
