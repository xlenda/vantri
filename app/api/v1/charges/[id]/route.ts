import { ApiError, json, withApi } from "@/lib/api/http";
import { toChargeJson } from "@/lib/api/serializers";
import { getCharge } from "@/lib/services/charges";

export const GET = withApi<{ id: string }>("charges:read", async ({ merchantId, params }) => {
  const charge = await getCharge(merchantId, params.id);
  if (!charge) throw new ApiError("not_found", "Cobrança não encontrada.");
  return json(await toChargeJson(charge, { withQr: true }));
});
