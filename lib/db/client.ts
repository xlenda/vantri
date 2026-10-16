import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let instance: Db | undefined;

export function db(): Db {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (url) instance = drizzle(postgres(url, { prepare: false, max: 1 }), { schema });
    else if (process.env.NODE_ENV !== "production") instance = devDb();
    else throw new Error("DATABASE_URL não definida");
  }
  return instance;
}

export function setDb(d: Db): void {
  instance = d;
}

/**
 * Banco local sem DATABASE_URL (só fora de produção): PGlite persistido em .data/pglite, com as migrations de
 * drizzle/ aplicadas uma vez por processo; toda query espera por elas, então db() segue síncrono.
 * O require de runtime (process.getBuiltinModule) deixa o PGlite e o wasm dele fora do bundle do Next.
 * Uma instância por processo em globalThis: o hot reload reavalia este módulo, e duas instâncias abertas no
 * mesmo diretório corrompem os dados (pelo mesmo motivo, scripts não podem abrir .data/pglite com o servidor no ar).
 */
function devDb(): Db {
  const g = globalThis as { vantriDevDb?: Db };
  if (g.vantriDevDb) return g.vantriDevDb;
  const { join, resolve } = process.getBuiltinModule("node:path");
  const load = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  const { PGlite } = load("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  const pglite = load("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
  const { migrate } = load("drizzle-orm/pglite/migrator") as typeof import("drizzle-orm/pglite/migrator");

  // PGLITE_DIR separa o banco de servidores paralelos (o PGlite é de um processo só).
  const dataDir = resolve(process.cwd(), process.env.PGLITE_DIR || join(".data", "pglite"));
  process.getBuiltinModule("node:fs").mkdirSync(dataDir, { recursive: true }); // o PGlite só cria o último nível
  const raw = new PGlite(dataDir);
  const ready = migrate(pglite.drizzle(raw), { migrationsFolder: join(process.cwd(), "drizzle") });
  // Só o que o driver drizzle-orm/pglite usa (query, transaction), mais close.
  const client = {
    async query(...a: Parameters<typeof raw.query>) {
      await ready;
      return raw.query(...a);
    },
    async transaction(...a: Parameters<typeof raw.transaction>) {
      await ready;
      return raw.transaction(...a);
    },
    close: () => raw.close(),
  } as unknown as typeof raw;
  return (g.vantriDevDb = pglite.drizzle({ client, schema }));
}
