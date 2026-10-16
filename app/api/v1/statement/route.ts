import { json, withApi } from "@/lib/api/http";
import { toStatementEntryJson } from "@/lib/api/serializers";
import { listStatement } from "@/lib/api/statement";

export const GET = withApi("statement:read", async ({ merchantId, req }) => {
  const { data, nextCursor } = await listStatement(merchantId, Object.fromEntries(new URL(req.url).searchParams));
  return json({ data: data.map(toStatementEntryJson), next_cursor: nextCursor });
});
