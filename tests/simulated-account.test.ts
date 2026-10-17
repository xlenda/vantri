import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Precos } from "@/app/(site)/components/Precos";
import { Recursos } from "@/app/(site)/components/Recursos";
import { POST as chargesPOST } from "@/app/api/v1/charges/route";
import { POST as payoutsPOST } from "@/app/api/v1/payouts/route";
import { DEMO_PUBLIC_TEXT, DemoBanner } from "@/app/components/demo-banner";
import { createApiKey } from "@/lib/api/keys";
import { type Db, setDb } from "@/lib/db/client";
import { charges, merchants, payouts } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { createCharge } from "@/lib/services/charges";
import { createPayout } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Com o parceiro real ligado, getProvider devolve o adaptador dele; aqui o simulador faz esse papel (o resto do
// módulo, inclusive a guarda, é o de verdade).
vi.mock("@/lib/provider", async (importOriginal) => {
  const { simulator } = await import("@/lib/provider/simulator");
  return { ...(await importOriginal<typeof import("@/lib/provider")>()), getProvider: () => simulator };
});

const MSG =
  "Esta conta é do ambiente de demonstração (Pix simulado) e não movimenta dinheiro de verdade. Fale com o suporte para abrir a conta na instituição parceira.";
let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

afterEach(() => vi.unstubAllEnvs());

/** Lojista ativo com R$ 1.000,00 disponíveis (saldo criado no simulador). */
async function merchantWith(providerAccountId: string) {
  const id = await newMerchant(d, 1);
  await d.update(merchants).set({ status: "active", providerAccountId }).where(eq(merchants.id, id));
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId: id, amountCents: 100_000, bucket: "available", kind: "adjustment", refType: "manual", refId: id },
    ]),
  );
  return id;
}

const CHARGE = { external_ref: "pedido-1", amount: 14990 };
const PAYOUT = { amount: 10_000, pix_key: "fornecedor@exemplo.com", pix_key_type: "email" };

async function api(h: typeof chargesPOST, key: string, body: unknown) {
  const req = new Request("http://localhost/api/v1/x", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "idempotency-key": "pedido-saque-0001" },
    body: JSON.stringify(body),
  });
  const res = await h(req, { params: Promise.resolve({}) });
  return { status: res.status, json: await res.json() };
}

it("conta sim_ com o parceiro real ligado: cobrança e saque recusados (403 na API), nada gravado", async () => {
  const m = await merchantWith("sim_acc_1");
  const { key } = await createApiKey(m, { name: "k", scopes: ["charges:write", "payouts:write"], ipAllowlist: [] });
  vi.stubEnv("PIX_PROVIDER", "parceiro");

  await expect(createCharge(m, CHARGE)).rejects.toMatchObject({ code: "simulated_account", message: MSG });
  await expect(createPayout(m, PAYOUT, "pedido-saque-0001")).rejects.toMatchObject({ code: "simulated_account", message: MSG });
  expect(await api(chargesPOST, key, CHARGE)).toEqual({ status: 403, json: { error: { code: "simulated_account", message: MSG } } });
  expect(await api(payoutsPOST, key, PAYOUT)).toEqual({ status: 403, json: { error: { code: "simulated_account", message: MSG } } });

  expect(await d.select().from(charges)).toHaveLength(0);
  expect(await d.select().from(payouts)).toHaveLength(0);
  expect((await getBalance(m)).available).toBe(100_000);
});

it("no simulador a conta sim_ funciona; com o parceiro, conta aberta nele também", async () => {
  vi.stubEnv("PIX_PROVIDER", "simulator");
  const sim = await merchantWith("sim_acc_1");
  expect((await createCharge(sim, CHARGE)).created).toBe(true);
  expect((await createPayout(sim, PAYOUT, "pedido-saque-0001")).payout.status).toBe("completed");

  vi.stubEnv("PIX_PROVIDER", "parceiro");
  await d.update(merchants).set({ providerAccountId: "acc_parceiro_1" }).where(eq(merchants.id, sim));
  expect((await createCharge(sim, { ...CHARGE, external_ref: "pedido-2" })).created).toBe(true);
  expect((await createPayout(sim, PAYOUT, "pedido-saque-0002")).replayed).toBe(false);
});

describe("aviso de demonstração (PIX_PROVIDER=simulator)", () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

  it("faixa só no simulador, com o texto do lugar", () => {
    vi.stubEnv("PIX_PROVIDER", "simulator");
    expect(html(createElement(DemoBanner))).toContain("Ambiente de demonstração: Pix simulado, sem dinheiro de verdade.");
    expect(html(createElement(DemoBanner, { text: DEMO_PUBLIC_TEXT }))).toContain(
      "Ambiente de demonstração: o Pix é simulado e ainda não movimenta dinheiro.",
    );
    vi.stubEnv("PIX_PROVIDER", "parceiro");
    expect(html(createElement(DemoBanner))).toBe("");
  });

  it("vitrine: frase de conta no parceiro só fora do simulador", () => {
    for (const C of [Recursos, Precos]) {
      const real = html(createElement(C, { simulator: false }));
      const demo = html(createElement(C, { simulator: true }));
      expect(real).toContain("Conta própria");
      expect(demo).not.toContain("Conta própria");
      expect(demo).toMatch(/Saldo (separado|e extrato separados) por lojista/);
    }
  });
});
