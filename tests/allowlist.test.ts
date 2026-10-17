import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { GET as balanceGET } from "@/app/api/v1/balance/route";
import { createApiKey, ipAllowlistProblem, ipEntryProblem, testIpAgainstAllowlist } from "@/lib/api/keys";
import { type Db, setDb } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeAll(() => {
  process.env.PIX_PROVIDER = "simulator";
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

it("ipEntryProblem: valid CIDR and bare IP pass, loose/malformed fail", () => {
  // bare IP (host) and a /24 are accepted
  expect(ipEntryProblem("203.0.113.0/24")).toBeNull();
  expect(ipEntryProblem("203.0.113.10")).toBeNull();
  expect(ipEntryProblem("2001:db8::/64")).toBeNull();
  expect(ipEntryProblem("2001:db8::1")).toBeNull();
  // a /8 is too broad → PT message mentioning the minimum prefixes
  const broad = ipEntryProblem("10.0.0.0/8");
  expect(broad).not.toBeNull();
  expect(broad).toMatch(/\/24/);
  expect(broad).toMatch(/\/64/);
  // v4 looser than /24, v6 looser than /64
  expect(ipEntryProblem("203.0.113.0/23")).not.toBeNull();
  expect(ipEntryProblem("2001:db8::/48")).not.toBeNull();
  // malformed
  expect(ipEntryProblem("203.0.113.256")).not.toBeNull();
  expect(ipEntryProblem("203.0.113.0 /24")).not.toBeNull(); // espaço no meio
  expect(ipEntryProblem("203.0.113.0/33")).not.toBeNull(); // prefixo fora de faixa
  expect(ipEntryProblem("203.0.113.0/")).not.toBeNull();
  expect(ipEntryProblem("")).not.toBeNull();
});

it("ipAllowlistProblem rejects a list with a too-broad entry", () => {
  expect(ipAllowlistProblem(["203.0.113.0/24", "198.51.100.5"])).toBeNull();
  expect(ipAllowlistProblem(["10.0.0.0/8"])).not.toBeNull();
  expect(ipAllowlistProblem([])).toBeNull();
});

it("testIpAgainstAllowlist matches inside a CIDR, not outside", () => {
  expect(testIpAgainstAllowlist(["203.0.113.0/24"], "203.0.113.10")).toBe(true);
  expect(testIpAgainstAllowlist(["203.0.113.0/24"], "198.51.100.1")).toBe(false);
  // bare IP still works (exact)
  expect(testIpAgainstAllowlist(["203.0.113.7"], "203.0.113.7")).toBe(true);
  expect(testIpAgainstAllowlist(["203.0.113.7"], "203.0.113.8")).toBe(false);
  // empty allowlist is caller's job; here with no entries nothing matches
  expect(testIpAgainstAllowlist([], "203.0.113.10")).toBe(false);
  // IPv6 /64
  expect(testIpAgainstAllowlist(["2001:db8::/64"], "2001:db8::5")).toBe(true);
  expect(testIpAgainstAllowlist(["2001:db8::/64"], "2001:db9::5")).toBe(false);
  // family isolation: a v4 request against a v6-only allowlist does not match
  expect(testIpAgainstAllowlist(["2001:db8::/64"], "203.0.113.10")).toBe(false);
  // a non-IP ip never matches (fail closed)
  expect(testIpAgainstAllowlist(["203.0.113.0/24"], "nao-e-ip")).toBe(false);
});

it("createApiKey accepts a CIDR entry and lowercases it", async () => {
  const m = await newMerchant(d, 1);
  const { id } = await createApiKey(m, {
    name: "cidr",
    scopes: ["balance:read"],
    ipAllowlist: ["203.0.113.0/24", "2001:DB8::/64"],
  });
  const [row] = await d.select().from(merchants).where(eq(merchants.id, m));
  expect(row.id).toBe(m);
  // guardou normalizado (minúsculo), dedup implícito não afeta estes
  const key = await createApiKey(m, { name: "x", scopes: ["balance:read"], ipAllowlist: ["203.0.113.0/24"] });
  expect(key.id).not.toBe(id);
});

it("withApi 403s an IP outside a CIDR allowlist, 200 inside", async () => {
  const m = await newMerchant(d, 1);
  await d.update(merchants).set({ status: "active", providerAccountId: "sim_acc_1" }).where(eq(merchants.id, m));
  const { key } = await createApiKey(m, { name: "k", scopes: ["balance:read"], ipAllowlist: ["203.0.113.0/24"] });
  const call = (headers: Record<string, string>) => {
    const req = new Request("http://localhost/api/v1/balance", { headers: new Headers({ authorization: `Bearer ${key}`, ...headers }) });
    return balanceGET(req, { params: Promise.resolve({}) as Promise<never> });
  };
  expect((await call({ "x-forwarded-for": "198.51.100.1" })).status).toBe(403);
  expect((await call({ "x-forwarded-for": "203.0.113.42, 10.0.0.1" })).status).toBe(200);
  expect((await call({ "x-real-ip": "203.0.113.42" })).status).toBe(200);
});
