import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createTestDb } from "./helpers/db";

it("test db runs migrations and answers", async () => {
  const d = await createTestDb();
  // Db é agnóstico de driver (execute → unknown); aqui sabemos que é PGlite.
  const r = (await d.execute(sql`select 1 as ok`)) as { rows: { ok: number }[] };
  expect(r.rows[0].ok).toBe(1);
}, 20_000); // PGlite + migrations passam de 5 s com a suíte toda em paralelo
