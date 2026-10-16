import { json, listQuery, withApi } from "@/lib/api/http";
import { toMedCaseJson } from "@/lib/api/serializers";
import { listMedCases } from "@/lib/services/med";

export const GET = withApi("med:read", async ({ merchantId, req }) => {
  const { data, nextCursor } = await listMedCases(merchantId, listQuery(req));
  return json({ data: data.map(toMedCaseJson), next_cursor: nextCursor });
});
