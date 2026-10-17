import { text } from "node:stream/consumers";
import { renderToStaticMarkup } from "react-dom/server";
import { prerenderToNodeStream } from "react-dom/static";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import BuscaPage from "@/app/painel/busca/page";
import { brl } from "@/lib/br/money";
import { type Db, setDb } from "@/lib/db/client";
import { charges, payouts } from "@/lib/db/schema";
import type { PayoutRow } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Tela /painel/busca com a sessão simulada (o guarda de verdade é testado em tests/auth.test.ts); banco e
// searchTransactions são os de verdade.
const auth = vi.hoisted(() => ({ session: null as null | { user: { id: string }; merchant: { id: string } } }));
vi.mock("@/lib/auth/guards", () => ({
  requireUser: vi.fn(async (opts: { role: string }) => {
    if (!auth.session || opts.role !== "merchant") throw new Error("NEXT_REDIRECT /entrar");
    return auth.session;
  }),
}));

// Um banco para o arquivo todo: cada teste usa identificadores próprios (seq), então não se enxergam.
let d: Db;
let mine: string;

beforeAll(async () => {
  d = await createTestDb();
  mine = await newMerchant(d, 1);
}, 60_000);

beforeEach(() => {
  setDb(d);
  auth.session = { user: { id: "u1" }, merchant: { id: mine } };
});

afterEach(() => vi.restoreAllMocks());

const el = (q?: string) => BuscaPage({ searchParams: Promise.resolve(q === undefined ? {} : { q }) });
/** O que chega primeiro ao navegador: a busca ainda não terminou. */
const shell = async (q?: string) => renderToStaticMarkup(await el(q));
/** A página inteira, com a busca resolvida. */
const page = async (q: string) => text((await prerenderToNodeStream(await el(q))).prelude);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Campo interno marcado: se "SEGREDO" aparecer no HTML, vazou.
const SEGREDO = "SEGREDO";
let seq = 0;

async function charge(merchantId: string, over: Partial<typeof charges.$inferInsert> = {}) {
  seq++;
  const [c] = await d
    .insert(charges)
    .values({
      merchantId,
      txid: `txid${seq}`,
      externalRef: `ref-${seq}`,
      amountCents: 14990,
      feeCents: 223,
      status: "paid",
      brcode: `000201${SEGREDO}`,
      providerChargeId: `${SEGREDO}-ch-${seq}`,
      expiresAt: new Date(Date.now() + 3600_000),
      ...over,
    })
    .returning();
  return c;
}

async function payout(merchantId: string, over: Partial<typeof payouts.$inferInsert> = {}) {
  seq++;
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId,
      amountCents: 10000,
      feeCents: 100,
      pixKey: "52998224725",
      pixKeyType: "cpf",
      status: "completed",
      providerPayoutId: `${SEGREDO}-prov-${seq}`,
      idempotencyKey: `${SEGREDO}-idem-${seq}`,
      requestHash: `${SEGREDO}-hash-${seq}`,
      ...over,
    })
    .returning();
  return p;
}

it("exige sessão de lojista", async () => {
  auth.session = null;
  await expect(el("ab")).rejects.toThrow("NEXT_REDIRECT");
});

it("estados: sem termo só o campo; 1 caractere pede 2; com termo, 'Buscando…' até a busca terminar", async () => {
  const vazio = await shell();
  expect(vazio).toContain('name="q"');
  expect(vazio).not.toMatch(/Buscando|Digite pelo menos|Nenhuma transação/);

  expect(await shell(" a ")).toContain("Digite pelo menos 2 caracteres.");

  const buscando = await shell("Maria");
  expect(buscando).toContain('value="Maria"');
  expect(buscando).toContain("Buscando…");
});

it("acha cobrança e saque só do lojista, com link para o detalhe e só campos públicos", async () => {
  const c = await charge(mine, { txid: "TXIDBUSCA01", endToEndId: "E00000000202610171200busca00001", payerName: "Maria Silva" });
  const p = await payout(mine, { endToEndId: "E00000000202610171200busca00002" });
  const outro = await newMerchant(d, 2);
  await charge(outro, { payerName: "Mariana Alheia" }); // mesmo prefixo, outro lojista

  const porNome = await page("mar");
  expect(porNome).toContain(`href="/painel/cobrancas?id=${c.id}"`);
  expect(porNome).toContain("Maria Silva");
  expect(porNome).toContain("TXIDBUSCA01");
  expect(porNome).not.toContain("Mariana Alheia");
  expect(porNome).toMatch(new RegExp(`class="[^"]*\\bvalor-sensivel\\b[^"]*">${esc(brl(14990))}<`));

  const porE2e = await page("E00000000202610171200busca00002");
  expect(porE2e).toContain(`href="/painel/saques/${p.id}"`);
  expect(porE2e).toContain("***.982.247-**");
  expect(porE2e).not.toContain("52998224725"); // chave inteira nunca
  expect(porE2e).toMatch(new RegExp(`class="[^"]*\\bvalor-sensivel\\b[^"]*">${esc(brl(10000))}<`));

  for (const html of [porNome, porE2e]) expect(html).not.toContain(SEGREDO);

  // O escopo é o lojista da sessão: com a sessão do outro, o resultado se inverte.
  auth.session = { user: { id: "u2" }, merchant: { id: outro } };
  const doOutro = await page("mar");
  expect(doOutro).toContain("Mariana Alheia");
  expect(doOutro).not.toContain("Maria Silva");
});

const KEYS: Array<[PayoutRow["pixKeyType"], string, string]> = [
  ["cpf", "52998224725", "***.982.247-**"],
  ["cnpj", "11222333000181", "11.222.333/****-**"],
  ["email", "fornecedor1@exemplo.com", "f***@exemplo.com"],
  ["phone", "+5511987654321", "***4321"],
  ["evp", "123e4567-e89b-42d3-a456-426614174000", "***4000"],
];
it.each(KEYS)("chave Pix %s aparece mascarada", async (pixKeyType, pixKey, masked) => {
  await payout(mine, { pixKeyType, pixKey, endToEndId: `E2E${pixKeyType}0001` });
  const html = await page(`E2E${pixKeyType}0001`);
  expect(html).toContain(masked);
  expect(html).not.toContain(pixKey);
});

it("nada encontrado; termo com caractere de controle também (nem vai ao banco, não é falha)", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await page("E00000000000000000000naoexiste01")).toContain(
    "Nenhuma transação encontrada para “E00000000000000000000naoexiste01”.",
  );
  const nul = await page("ab\u0000cd");
  expect(nul).toContain("Nenhuma transação encontrada");
  expect(nul).not.toContain("Não foi possível buscar");
  expect(err).not.toHaveBeenCalled();
});

it("falha ao buscar não vira 'nada encontrado'; o log não leva o termo", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  setDb({
    select: () => {
      throw new Error("Failed query … params: Maria Silva");
    },
  } as unknown as Db);

  const html = await page("Maria Silva");
  expect(html).toContain("Não foi possível buscar agora");
  expect(html).not.toContain("Nenhuma transação encontrada");
  expect(err).toHaveBeenCalledWith("painel: busca falhou", expect.any(String));
  expect(JSON.stringify(err.mock.calls)).not.toContain("Maria");
});
