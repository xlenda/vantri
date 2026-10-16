import { ApiError, json, withApi } from "@/lib/api/http";
import { toMedCaseJson } from "@/lib/api/serializers";
import { getMedCase } from "@/lib/services/med";

export const GET = withApi<{ id: string }>("med:read", async ({ merchantId, params }) => {
  const medCase = await getMedCase(merchantId, params.id);
  if (!medCase) throw new ApiError("not_found", "Caso de MED não encontrado.");
  return json(toMedCaseJson(medCase));
});
