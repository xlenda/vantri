import { beforeEach, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { sessions, users } from "@/lib/db/schema";
import { listSessions, revokeOtherSessions, revokeSession } from "@/lib/services/sessions";
import { createTestDb } from "./helpers/db";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

let userSeq = 0;
async function newUser(): Promise<string> {
  const n = ++userSeq;
  const [u] = await d
    .insert(users)
    .values({ email: `u${n}@x.com`, passwordHash: "hash", role: "admin" })
    .returning({ id: users.id });
  return u.id;
}

const HOUR = 3_600_000;
/** Cria uma sessão do usuário a partir de um token; devolve o id (sha256 do token). */
async function newSession(
  userId: string,
  token: string,
  opts: { expiresInMs?: number; mfaPassed?: boolean } = {},
): Promise<string> {
  const id = sha256Hex(token);
  await d.insert(sessions).values({
    id,
    userId,
    mfaPassed: opts.mfaPassed ?? false,
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 12 * HOUR)),
  });
  return id;
}

it("listSessions marks current and excludes expired", async () => {
  const u = await newUser();
  const other = await newUser();
  const curId = await newSession(u, "tok-atual");
  await newSession(u, "tok-outra");
  await newSession(u, "tok-velha", { expiresInMs: -1000 }); // já expirou
  await newSession(other, "tok-de-outro"); // de outro usuário

  const rows = await listSessions(u, "tok-atual");
  expect(rows).toHaveLength(2); // só as não expiradas do próprio usuário
  expect(rows.map((r) => r.id)).toContain(curId);
  expect(rows.filter((r) => r.current)).toHaveLength(1);
  expect(rows.find((r) => r.current)?.id).toBe(curId);
});

it("never leaks the raw token", async () => {
  const u = await newUser();
  await newSession(u, "tok-secreto");
  const rows = await listSessions(u, "tok-secreto");
  const dump = JSON.stringify(rows);
  expect(dump).not.toContain("tok-secreto"); // só o hash-id, nunca o token
  expect(rows[0].id).toBe(sha256Hex("tok-secreto"));
  expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "current", "expiresAt", "id", "mfaPassed"]);
});

it("revokeSession only removes own session", async () => {
  const u = await newUser();
  const other = await newUser();
  const mine = await newSession(u, "tok-meu");
  const theirs = await newSession(other, "tok-alheio");

  // id de outro usuário: não apaga, devolve false e a sessão continua lá.
  expect(await revokeSession(u, theirs)).toBe(false);
  expect(await d.select().from(sessions).then((r) => r.length)).toBe(2);

  // a própria sessão: apaga e devolve true.
  expect(await revokeSession(u, mine)).toBe(true);
  expect(await d.select().from(sessions).then((r) => r.map((s) => s.id))).toEqual([theirs]);
});

it("revokeOtherSessions keeps the current one", async () => {
  const u = await newUser();
  const other = await newUser();
  const keep = await newSession(u, "tok-atual");
  await newSession(u, "tok-b");
  await newSession(u, "tok-c");
  const alheio = await newSession(other, "tok-de-outro");

  expect(await revokeOtherSessions(u, keep)).toBe(2); // apagou as duas outras do usuário
  const left = await d.select().from(sessions).then((r) => r.map((s) => s.id).sort());
  expect(left).toEqual([keep, alheio].sort()); // a atual e a de outro usuário continuam
});
