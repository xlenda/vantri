import { ApiError, json, withApi } from "@/lib/api/http";
import { toPayoutJson } from "@/lib/api/serializers";
import { getPayout } from "@/lib/services/payouts";

export const GET = withApi<{ id: string }>("payouts:read", async ({ merchantId, params }) => {
  const payout = await getPayout(merchantId, params.id);
  if (!payout) throw new ApiError("not_found", "Saque não encontrado.");
  return json(toPayoutJson(payout));
});
