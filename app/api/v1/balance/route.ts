import { json, withApi } from "@/lib/api/http";
import { toBalanceJson } from "@/lib/api/serializers";
import { getBalance } from "@/lib/money/ledger";

export const GET = withApi("balance:read", async ({ merchantId }) => json(toBalanceJson(await getBalance(merchantId))));
