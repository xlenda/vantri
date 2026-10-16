import { json, listQuery, readJson, withApi } from "@/lib/api/http";
import { toChargeJson } from "@/lib/api/serializers";
import { createCharge, listCharges } from "@/lib/services/charges";

/** 201 criada; 200 quando o `external_ref` já existia com o mesmo valor (idempotente). */
export const POST = withApi("charges:write", async ({ merchantId, req }) => {
  const { charge, created } = await createCharge(merchantId, await readJson(req));
  return json(await toChargeJson(charge, { withQr: true }), created ? 201 : 200);
});

export const GET = withApi("charges:read", async ({ merchantId, req }) => {
  const { data, nextCursor } = await listCharges(merchantId, listQuery(req));
  return json({
    data: await Promise.all(data.map((c) => toChargeJson(c, { withQr: true }))),
    next_cursor: nextCursor,
  });
});
