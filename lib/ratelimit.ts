import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateLimits } from "@/lib/db/schema";

// ponytail: janela fixa no Postgres; Redis/Upstash se o volume pedir
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const window = sql`make_interval(secs => ${windowSec})`;
  // No SET, as colunas sem qualificação são as da linha antiga: as duas expressões veem o mesmo estado.
  const expired = sql`${rateLimits.windowStart} <= now() - ${window}`;
  const [row] = await db()
    .insert(rateLimits)
    .values({ key, windowStart: sql`now()`, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${expired} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        windowStart: sql`CASE WHEN ${expired} THEN now() ELSE ${rateLimits.windowStart} END`,
      },
    })
    .returning({
      count: rateLimits.count,
      retryAfterSec: sql<number>`greatest(1, ceil(extract(epoch from ${rateLimits.windowStart} + ${window} - now())))::int`,
    });
  const ok = row.count <= limit;
  return { ok, retryAfterSec: ok ? 0 : row.retryAfterSec };
}
