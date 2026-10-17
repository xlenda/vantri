import type { Tx } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

/**
 * Uma linha no audit_log, na transação do próprio efeito (se ela desfizer, a auditoria some junto).
 * `meta` só com ids e valores (taxa, desfecho), nunca dado pessoal; `merchantId` quando houver lojista,
 * que é por onde a Auditoria filtra (meta->>'merchantId').
 */
export async function writeAudit(
  tx: Tx,
  actorUserId: string | null,
  action: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({ actorUserId, action, meta });
}
