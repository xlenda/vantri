import { json, listQuery, withApi } from "@/lib/api/http";
import { toMedCaseJson } from "@/lib/api/serializers";
import { listMedCases } from "@/lib/services/med";

export const GET = withApi("med:read", async ({ merchantId, req }) => {
  const { limit, cursor } = listQuery(req);
  const rows = await listMedCases(merchantId, { limit, cursor });
  // ponytail: o serviço não diz se há mais; página cheia ⇒ cursor (a seguinte pode vir vazia). limit+1 no serviço resolve.
  return json({ data: rows.map(toMedCaseJson), next_cursor: rows.length === limit ? rows[limit - 1].id : null });
});
