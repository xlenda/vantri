import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Banco local de desenvolvimento (Ruling 27): sem DATABASE_URL e fora de produção, PGlite em .data/pglite.
// Cada teste roda num diretório temporário com uma cópia de drizzle/, para não tocar no .data do repositório.
const repo = process.cwd();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vantri-devdb-"));
  cpSync(join(repo, "drizzle"), join(dir, "drizzle"), { recursive: true });
  process.chdir(dir);
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "");
});

afterEach(async () => {
  const g = globalThis as { vantriDevDb?: { $client: { close(): Promise<void> } } };
  await g.vantriDevDb?.$client.close();
  delete g.vantriDevDb;
  vi.unstubAllEnvs();
  process.chdir(repo);
  rmSync(dir, { recursive: true, force: true });
});

it("fora de produção usa PGlite em .data/pglite, com as migrations aplicadas antes da primeira query", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const { db } = await import("@/lib/db/client");
  const { merchants } = await import("@/lib/db/schema");
  const d = db(); // síncrono para quem chama
  expect(await d.select().from(merchants)).toEqual([]);
  expect(db()).toBe(d);
  expect(existsSync(join(dir, ".data", "pglite", "PG_VERSION"))).toBe(true);
}, 20_000); // PGlite em disco + migrations passam de 5 s com a suíte toda em paralelo

it("em produção sem DATABASE_URL continua lançando", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const { db } = await import("@/lib/db/client");
  expect(() => db()).toThrow("DATABASE_URL não definida");
});
