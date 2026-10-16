import type { ledgerEntries } from "@/lib/db/schema";

// Cobrança, saque e MED: o JSON público é o mesmo dos webhooks e mora no serviço. Só reexporta.
export { toChargeJson } from "@/lib/services/charges";
export { toMedCaseJson } from "@/lib/services/med";
export { toPayoutJson } from "@/lib/services/payouts";

export const toBalanceJson = (b: { available: number; blocked: number; total: number }) => ({
  available: b.available,
  blocked: b.blocked,
  total: b.total,
});

export const toStatementEntryJson = (e: typeof ledgerEntries.$inferSelect) => ({
  id: e.id,
  kind: e.kind,
  bucket: e.bucket,
  amount: e.amountCents,
  ref_type: e.refType,
  ref_id: e.refId,
  created_at: e.createdAt.toISOString(),
});
