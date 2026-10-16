import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** `logger` recebe o SQL de cada query (inclusive as das migrations). */
export async function createTestDb(opts: { logger?: (q: string) => void } = {}): Promise<Db> {
  const { logger } = opts;
  const d = drizzle(new PGlite(), { schema, logger: logger && { logQuery: (q) => logger(q) } });
  // Sem journal ainda não há migration (a Task 2 gera a primeira).
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) await migrate(d, { migrationsFolder });
  return d;
}
