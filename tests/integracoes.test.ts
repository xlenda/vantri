import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookAction,
  rotateSecretAction,
  testIpAction,
  testWebhookAction,
  toggleWebhookAction,
  updateAllowlistAction,
  updateWebhookAction,
} from "@/app/painel/integracoes/actions";
import { GET as deliveryJson } from "@/app/painel/integracoes/entregas/[id]/json/route";
import EntregaPage from "@/app/painel/integracoes/entregas/[id]/page";
import EntregasPage from "@/app/painel/integracoes/entregas/page";
import { eventLabel, SCOPE_GROUPS } from "@/app/painel/integracoes/labels";
import IntegracoesPage from "@/app/painel/integracoes/page";
import { createApiKey, revokeApiKey, SCOPES } from "@/lib/api/keys";
import { decrypt } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { apiKeys, merchants, webhookAttempts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { createEndpoint } from "@/lib/services/events";
import { verifySignature } from "@/lib/webhooks/sign";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Ações e telas de integrações com a sessão simulada (o guarda de verdade é testado em tests/auth.test.ts).
// redirect/notFound lançam como os reais. O DNS é falso (nada sai para a rede) e o fetch de cada teste é um espião.
const auth = vi.hoisted(() => ({ session: null as null | { user: { id: string }; merchant: { id: string } } }));
vi.mock("@/lib/auth/guards", () => ({
  requireUser: vi.fn(async (opts: { role: string }) => {
    if (!auth.session || opts.role !== "merchant") throw new Error("NEXT_REDIRECT /entrar");
    return auth.session;
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const dns = vi.hoisted(() => ({ address: "93.184.216.34" }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: dns.address, family: 4 }]) }));

let d: Db;
let merchantId: string;
let otherId: string;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  merchantId = await newMerchant(d, 1);
  otherId = await newMerchant(d, 2);
  const [m] = await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, merchantId)).returning();
  auth.session = { user: { id: "8d7c2f4e-1b3a-4c5d-9e6f-0a1b2c3d4e5f" }, merchant: m };
  dns.address = "93.184.216.34";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const form = (o: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
};
const URL_A = "https://loja.example.com/hooks/vantri";
const URL_B = "https://outra.example.com/hooks";
const endpointRow = async (id: string) => (await d.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)))[0];
const keyRow = async (id: string) => (await d.select().from(apiKeys).where(eq(apiKeys.id, id)))[0];
const twoEndpoints = async () => ({
  own: await createEndpoint(merchantId, { url: URL_A, events: ["charge.paid"] }),
  alheio: await createEndpoint(otherId, { url: URL_B, events: ["charge.paid"] }),
});
function spyFetch(status = 200) {
  const send = vi.fn<typeof fetch>(async () => new Response("recebido", { status }));
  vi.stubGlobal("fetch", send);
  return send;
}
const render = async (sp: Record<string, string>) => renderToStaticMarkup(await IntegracoesPage({ searchParams: Promise.resolve(sp) }));

it("cada escopo está em um grupo só; webhook.test tem rótulo", () => {
  expect(SCOPE_GROUPS.flatMap(([, s]) => s).sort()).toEqual([...SCOPES].sort());
  expect(eventLabel("webhook.test")).toBe("Teste");
  expect(eventLabel("charge.paid")).toBe("Cobrança paga");
});

describe("webhooks pelo painel", () => {
  it("criar com nome: grava o nome; o segredo volta só no estado da ação", async () => {
    const r = await createWebhookAction(undefined, form({ url: URL_A, events: ["charge.paid"], description: " Loja principal " }));
    expect(r).toMatchObject({ secret: expect.stringMatching(/^whsec_/), url: URL_A });
    const [ep] = await d.select().from(webhookEndpoints);
    expect(ep).toMatchObject({ merchantId, description: "Loja principal", events: ["charge.paid"] });
    expect(decrypt(ep.secretEnc)).toBe((r as { secret: string }).secret);
  });

  it("editar: só o próprio, URL re-validada, segredo intacto", async () => {
    const { own, alheio } = await twoEndpoints();
    const antes = await endpointRow(own.id);
    const edit = { id: own.id, url: "https://loja.example.com/v2", events: ["charge.paid", "payout.failed"], description: "Produção" };

    expect(await updateWebhookAction(undefined, form({ ...edit, url: "https://10.0.0.5/h" }))).toMatchObject({
      error: "Endereço interno não é permitido para webhook.",
      values: { url: "https://10.0.0.5/h", description: "Produção" },
    });
    expect(await updateWebhookAction(undefined, form({ ...edit, id: alheio.id }))).toMatchObject({ error: "Webhook não encontrado." });
    expect(await endpointRow(alheio.id)).toMatchObject({ url: URL_B, description: null });

    await expect(updateWebhookAction(undefined, form(edit))).rejects.toThrow("NEXT_REDIRECT /painel/integracoes?aba=webhooks&ok=atualizado");
    expect(await endpointRow(own.id)).toMatchObject({
      url: "https://loja.example.com/v2",
      events: ["charge.paid", "payout.failed"],
      description: "Produção",
      secretEnc: antes.secretEnc,
    });
  });

  it("ativar/desativar: só o próprio", async () => {
    const { own, alheio } = await twoEndpoints();
    await expect(toggleWebhookAction(form({ id: own.id, active: "0" }))).rejects.toThrow(
      "NEXT_REDIRECT /painel/integracoes?aba=webhooks&ok=desativado",
    );
    expect((await endpointRow(own.id)).active).toBe(false);
    await expect(toggleWebhookAction(form({ id: alheio.id, active: "0" }))).rejects.toThrow(
      "NEXT_REDIRECT /painel/integracoes?aba=webhooks&erro=situacao",
    );
    expect((await endpointRow(alheio.id)).active).toBe(true);
    await expect(toggleWebhookAction(form({ id: own.id, active: "1" }))).rejects.toThrow("NEXT_REDIRECT /painel/integracoes?aba=webhooks&ok=ativado");
    expect((await endpointRow(own.id)).active).toBe(true);
  });

  it("novo segredo: devolvido uma vez e guardado; de outro lojista nada muda; a tela nunca mostra segredo", async () => {
    const { own, alheio } = await twoEndpoints();
    const r = await rotateSecretAction(undefined, form({ id: own.id }));
    expect(r).toEqual({ secret: expect.stringMatching(/^whsec_/) });
    const secret = (r as { secret: string }).secret;
    expect(secret).not.toBe(own.secret);
    expect(decrypt((await endpointRow(own.id)).secretEnc)).toBe(secret);

    const alheioAntes = (await endpointRow(alheio.id)).secretEnc;
    expect(await rotateSecretAction(undefined, form({ id: alheio.id }))).toEqual({ error: "Webhook não encontrado." });
    expect((await endpointRow(alheio.id)).secretEnc).toBe(alheioAntes);

    // Recarregar (aba de webhooks, editando este): nenhum segredo na página.
    const html = await render({ aba: "webhooks", editar: own.id });
    expect(html).toContain("Editar webhook");
    expect(html).toContain("Gerar novo segredo");
    expect(html).not.toContain("whsec_");
    // Editar um webhook de outro lojista pela URL: não aparece.
    const alheia = await render({ aba: "webhooks", editar: alheio.id });
    expect(alheia).toContain("Webhook não encontrado.");
    expect(alheia).not.toContain(URL_B);
  });

  it("testar: POST assinado pelo sendOne, resultado no inspetor; webhook de outro lojista não recebe nada", async () => {
    const { own, alheio } = await twoEndpoints();
    await d.update(webhookEndpoints).set({ active: false }).where(eq(webhookEndpoints.id, own.id)); // vale desativado
    const send = spyFetch(200);

    await expect(testWebhookAction(form({ id: alheio.id }))).rejects.toThrow("NEXT_REDIRECT /painel/integracoes?aba=webhooks&erro=testar");
    expect(send).not.toHaveBeenCalled();
    expect(await d.select().from(webhookDeliveries)).toHaveLength(0);

    await expect(testWebhookAction(form({ id: own.id }))).rejects.toThrow(
      `NEXT_REDIRECT /painel/integracoes/entregas?endpoint=${own.id}&teste=entregue`,
    );
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe(URL_A);
    expect(verifySignature(own.secret, init.body, init.headers["X-Vantri-Signature"], Math.floor(Date.now() / 1000))).toBe(true);
    expect(await d.select().from(webhookDeliveries)).toMatchObject([
      { endpointId: own.id, eventType: "webhook.test", status: "delivered", attempts: 1 },
    ]);
  });

  it("testar: nome que resolve para IP interno não recebe o teste (mesmo guard do dispatcher)", async () => {
    const { own } = await twoEndpoints();
    dns.address = "10.0.0.5";
    const send = spyFetch(200);
    await expect(testWebhookAction(form({ id: own.id }))).rejects.toThrow(
      `NEXT_REDIRECT /painel/integracoes/entregas?endpoint=${own.id}&teste=falhou`,
    );
    expect(send).not.toHaveBeenCalled();
    expect(await d.select().from(webhookDeliveries)).toMatchObject([{ status: "failed", lastError: "endereço bloqueado" }]);
  });

  it("testar: até 10 por minuto por lojista", async () => {
    const { own } = await twoEndpoints();
    const send = spyFetch(200);
    for (let i = 0; i < 10; i++) await expect(testWebhookAction(form({ id: own.id }))).rejects.toThrow("teste=entregue");
    await expect(testWebhookAction(form({ id: own.id }))).rejects.toThrow("NEXT_REDIRECT /painel/integracoes?aba=webhooks&erro=teste-limite");
    expect(send).toHaveBeenCalledTimes(10);
  });
});

describe("inspetor de entregas", () => {
  async function seed() {
    const { own, alheio } = await twoEndpoints();
    const [mine, theirs] = await d
      .insert(webhookDeliveries)
      .values([
        {
          endpointId: own.id,
          eventId: "evt_meu_00000001",
          eventType: "charge.paid",
          payload: { id: "evt_meu_00000001", type: "charge.paid", data: { id: "ch_meu" } },
          status: "failed" as const,
          attempts: 2,
          lastStatusCode: 500,
          lastError: "resposta HTTP 500",
        },
        {
          endpointId: alheio.id,
          eventId: "evt_alheio_000001",
          eventType: "charge.paid",
          payload: { id: "evt_alheio_000001", type: "charge.paid", data: { id: "ch_alheio" } },
          status: "delivered" as const,
          attempts: 1,
        },
      ])
      .returning();
    await d.insert(webhookAttempts).values([
      { deliveryId: mine.id, n: 1, statusCode: null, latencyMs: 12, error: "conexão recusada" },
      { deliveryId: mine.id, n: 2, statusCode: 500, latencyMs: 34, error: "resposta HTTP 500", responseSnippet: "erro interno do lojista" },
    ]);
    return { own, mine, theirs };
  }

  it("detalhe e JSON: só do próprio lojista, sem segredo; de outro lojista → 404", async () => {
    const { own, mine, theirs } = await seed();
    const page = (id: string) => EntregaPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
    await expect(page(theirs.id)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(page("nao-e-uuid")).rejects.toThrow("NEXT_NOT_FOUND");
    const html = renderToStaticMarkup(await page(mine.id));
    expect(html).toContain("Assinado com HMAC (X-Vantri-Signature)");
    expect(html).toContain("Tentativa 2 · HTTP 500 · 34 ms");
    expect(html).toContain("erro interno do lojista");
    expect(html).not.toContain(own.secret);

    const get = (id: string) => deliveryJson(new Request(`http://localhost/painel/integracoes/entregas/${id}/json`), { params: Promise.resolve({ id }) });
    expect((await get(theirs.id)).status).toBe(404);
    const res = await get(mine.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''webhook-entrega-${mine.id}.json`);
    const text = await res.text();
    expect(text).not.toContain(own.secret);
    expect(JSON.parse(text)).toMatchObject({
      id: mine.id,
      request: { method: "POST", url: URL_A, body: { id: "evt_meu_00000001" } },
      attempt_history: [
        { n: 1, error: "conexão recusada" },
        { n: 2, status_code: 500, response_snippet: "erro interno do lojista" },
      ],
    });
  });

  it("lista: só entregas do lojista; aviso do teste; busca curta mostra a mensagem do serviço", async () => {
    const { own, mine, theirs } = await seed();
    const list = async (sp: Record<string, string>) => renderToStaticMarkup(await EntregasPage({ searchParams: Promise.resolve(sp) }));
    const html = await list({ endpoint: own.id, teste: "entregue" });
    expect(html).toContain("Teste entregue");
    expect(html).toContain(`/painel/integracoes/entregas/${mine.id}`);
    expect(html).not.toContain(theirs.id);
    expect(html).not.toContain("outra.example.com");
    expect(await list({ q: "abc" })).toContain("Digite o identificador completo (pelo menos 8 caracteres).");
    expect(await list({ q: "ch_alheio_x" })).not.toContain(theirs.id);
  });
});

describe("segurança e IPs", () => {
  it("salvar lista: valida cada entrada, normaliza e grava só na chave ativa do próprio lojista", async () => {
    const { id } = await createApiKey(merchantId, { name: "Prod", scopes: ["charges:read"], ipAllowlist: [] });
    const alheia = await createApiKey(otherId, { name: "Outra", scopes: ["charges:read"], ipAllowlist: ["198.51.100.7"] });
    const save = (keyId: string, ips: string) => updateAllowlistAction(undefined, form({ id: keyId, ips }));

    expect(await save(id, "203.0.113.0/24\n10.0.0.0/8")).toMatchObject({
      error: "10.0.0.0/8: Prefixo muito amplo: aceito IPv4 a partir de /24 e IPv6 a partir de /64.",
      values: { ips: "203.0.113.0/24\n10.0.0.0/8" },
    });
    expect(await save(id, Array.from({ length: 21 }, (_, i) => `203.0.113.${i + 1}`).join("\n"))).toMatchObject({
      error: "Use até 20 IPs ou faixas por chave.",
    });
    expect((await keyRow(id)).ipAllowlist).toEqual([]);

    expect(await save(alheia.id, "")).toMatchObject({ error: "Chave não encontrada." });
    expect((await keyRow(alheia.id)).ipAllowlist).toEqual(["198.51.100.7"]);

    expect(await save(id, "203.0.113.0/24, 2001:DB8::/64\n203.0.113.0/24")).toMatchObject({ ok: expect.stringContaining("Lista salva") });
    expect((await keyRow(id)).ipAllowlist).toEqual(["203.0.113.0/24", "2001:db8::/64"]);

    await revokeApiKey(merchantId, id);
    expect(await save(id, "")).toMatchObject({ error: "Chave não encontrada." });
    expect((await keyRow(id)).ipAllowlist).toEqual(["203.0.113.0/24", "2001:db8::/64"]);
  });

  it("testar IP: aceito (com a faixa que casou), bloqueado, sem restrição; só IP puro; chave alheia não vaza", async () => {
    const own = await createApiKey(merchantId, { name: "Prod", scopes: ["charges:read"], ipAllowlist: ["198.51.100.7", "203.0.113.0/24"] });
    const open = await createApiKey(merchantId, { name: "Livre", scopes: ["charges:read"], ipAllowlist: [] });
    const alheia = await createApiKey(otherId, { name: "Outra", scopes: ["charges:read"], ipAllowlist: ["192.0.2.0/24"] });
    const t = (id: string, ip: string) => testIpAction(undefined, form({ id, ip }));

    expect(await t(own.id, " 203.0.113.10 ")).toEqual({ tone: "ok", message: "203.0.113.10 seria aceito (casa com 203.0.113.0/24)." });
    expect(await t(own.id, "192.0.2.1")).toEqual({
      tone: "error",
      message: "192.0.2.1 seria bloqueado: não casa com nenhum IP ou faixa desta chave.",
    });
    expect(await t(open.id, "192.0.2.1")).toEqual({ tone: "info", message: "192.0.2.1 seria aceito: esta chave ainda não tem restrição de IP." });
    expect(await t(own.id, "203.0.113.0/24")).toEqual({ tone: "error", message: "Informe um IP (sem prefixo CIDR) para testar." });
    expect(await t(own.id, "999.1.1.1")).toEqual({ tone: "error", message: "IP inválido. Use IPv4 (ex.: 203.0.113.10) ou IPv6." });
    expect(await t(alheia.id, "192.0.2.1")).toEqual({ tone: "error", message: "Chave não encontrada." });
  });

  it("abas: Segurança só com chaves ativas e a faixa de estado; Chaves com escopos por rótulo", async () => {
    await createApiKey(merchantId, { name: "Restrita", scopes: ["charges:read", "balance:read"], ipAllowlist: ["203.0.113.0/24"] });
    const velha = await createApiKey(merchantId, { name: "Velha", scopes: ["charges:read"], ipAllowlist: [] });
    await revokeApiKey(merchantId, velha.id);

    const seg = await render({ aba: "seguranca" });
    expect(seg).toContain("Restrição por IP ativa.");
    expect(seg).toContain("203.0.113.0/24");
    expect(seg).not.toContain("Velha");

    const chaves = await render({});
    expect(chaves).toContain("Saldo e extrato");
    expect(chaves).toContain("Ler cobranças, Ler saldo");
    expect(chaves).toContain("Velha");
  });
});
