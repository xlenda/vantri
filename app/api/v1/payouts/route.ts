import { after } from "next/server";
import { ApiError, json, listQuery, readJson, withApi } from "@/lib/api/http";
import { toPayoutJson } from "@/lib/api/serializers";
import { createPayout, listPayouts } from "@/lib/services/payouts";
import { dispatchDue } from "@/lib/webhooks/dispatch";

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,64}$/; // ASCII visível, 8 a 64

/** 201 criado; 200 quando a mesma Idempotency-Key volta com o mesmo corpo. */
export const POST = withApi("payouts:write", async ({ merchantId, req }) => {
  const key = req.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new ApiError("invalid_request", "Envie o header Idempotency-Key com 8 a 64 caracteres, sem espaços.");
  }
  const { payout, replayed } = await createPayout(merchantId, await readJson(req), key);
  after(() => dispatchDue()); // payout.completed/failed já na fila sai agora, não no próximo tick do cron
  return json(toPayoutJson(payout), replayed ? 200 : 201);
});

export const GET = withApi("payouts:read", async ({ merchantId, req }) => {
  const { data, nextCursor } = await listPayouts(merchantId, listQuery(req));
  return json({ data: data.map(toPayoutJson), next_cursor: nextCursor });
});
