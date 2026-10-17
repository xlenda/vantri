import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PainelInicio from "@/app/painel/page";
import { brl } from "@/lib/br/money";
import { type Db, setDb } from "@/lib/db/client";
import { charges, ledgerEntries, medCases, merchants, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { payoutCeilingCents } from "@/lib/services/payouts";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Início do painel renderizado de verdade sobre o razão (PGlite). Só a sessão é simulada: o guarda real é testado
// em tests/auth.test.ts; aqui conta que a página chama painelSession e lê tudo pelo merchant da sessão.
const auth = vi.hoisted(() => ({ session: null as unknown }));
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

// "Agora" = 17/10/2026, 12:00 em Brasília. Este mês = 01–17/10; período anterior (mesma duração) = 14–30/09.
const NOW = new Date("2026-10-17T15:00:00Z");
const HOUR = 3_600_000;

let d: Db;
let m: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  d = await createTestDb();
  setDb(d);
  m = await newMerchant(d, 1);
  const [merchant] = await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, m)).returning();
  auth.session = { user: { id: m }, merchant };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Entry = typeof ledgerEntries.$inferInsert;
const lanca = (
  merchantId: string,
  amountCents: number,
  kind: Entry["kind"],
  refType: Entry["refType"],
  refId: string,
  at: string,
  bucket: Entry["bucket"] = "available",
) => d.insert(ledgerEntries).values({ merchantId, amountCents, kind, refType, refId, bucket, createdAt: new Date(at) });

const render = async (sp: Record<string, string | undefined> = {}) =>
  renderToStaticMarkup(await PainelInicio({ searchParams: Promise.resolve(sp) }));

/** Trecho da seção `aria-labelledby={id}` até o fim dela. */
const secao = (html: string, id: string) => {
  const i = html.indexOf(`aria-labelledby="${id}"`);
  if (i < 0) throw new Error(`seção ${id} não encontrada`);
  return html.slice(i, html.indexOf("</section>", i));
};

const CH0 = uuid(1);
const CH1 = uuid(2);
const CH2 = uuid(3);
const PO1 = uuid(4);

async function cenario() {
  await lanca(m, 20_000, "cash_in", "charge", CH0, "2026-09-20T15:00:00Z"); // período anterior
  await lanca(m, 100_000, "adjustment", "manual", m, "2026-10-01T11:00:00Z"); // o mais antigo do mês: fica fora das 6
  await lanca(m, 10_000, "cash_in", "charge", CH1, "2026-10-02T15:00:00Z");
  await lanca(m, -149, "fee_in", "charge", CH1, "2026-10-02T15:00:01Z");
  await lanca(m, -5_000, "cash_out", "payout", PO1, "2026-10-10T15:00:00Z");
  await lanca(m, -100, "fee_out", "payout", PO1, "2026-10-10T15:00:01Z");
  await lanca(m, 20_000, "cash_in", "charge", CH2, "2026-10-17T12:00:00Z"); // hoje, 09:00 em Brasília
  await lanca(m, -149, "fee_in", "charge", CH2, "2026-10-17T12:00:01Z");
  const outro = await newMerchant(d, 2); // nada do outro lojista aparece
  await lanca(outro, 999_999, "cash_in", "charge", uuid(9), "2026-10-17T13:00:00Z");
}

it("padrão = este mês: KPIs com delta, saldo, fluxo, últimas 6 do razão com saldo após e resumo do dia", async () => {
  await cenario();
  const html = await render();
  expect(html).toContain('value="2026-10-01"');
  expect(html).toContain('value="2026-10-17"');
  expect(html).not.toContain(brl(999_999));
  expect(html).not.toContain("Período inválido");

  // Entradas 300,00 (2 Pix, ticket 150,00) contra 200,00 no período anterior → +50,0%.
  // Saídas 50,00 (1 saque, tarifa 1,00) sem base no período anterior → sem delta.
  const kpis = secao(html, "kpis");
  for (const v of [30_000, 15_000, 298, 5_000, 100, 144_602]) expect(kpis).toContain(brl(v));
  expect(kpis).toContain("2 Pix recebidos");
  expect(kpis).toContain("1 saque");
  expect(kpis).toContain("+50,0%");
  expect(kpis.match(/vs\. período anterior/g)).toHaveLength(1);

  // Fluxo: lista para leitor de tela só com os dias que tiveram entrada ou saída (01/10 só teve ajuste).
  const fluxo = secao(html, "fluxo");
  const lista = fluxo.slice(fluxo.indexOf("<figcaption"));
  expect(lista.match(/<li>/g)).toHaveLength(3);
  expect(lista).toContain(`<li>02/10: entradas <span class="valor-sensivel">${brl(10_000)}</span>, saídas <span class="valor-sensivel">${brl(0)}</span></li>`);
  expect(lista).toContain(`<li>10/10: entradas <span class="valor-sensivel">${brl(0)}</span>, saídas <span class="valor-sensivel">${brl(5_000)}</span></li>`);
  expect(lista).toContain(`<li>17/10: entradas <span class="valor-sensivel">${brl(20_000)}</span>`);
  expect(fluxo).toContain("<title>05/10: entradas"); // o gráfico tem um par de barras por dia do período, com ou sem movimento
  expect(fluxo).toContain('href="/painel/extrato"');

  // Últimas 6 do razão (os dois sentidos), mais novas primeiro, com o saldo após cada uma.
  const ultimas = secao(html, "ultimas");
  expect(ultimas.match(/<li/g)).toHaveLength(6);
  expect(ultimas).not.toContain("Ajuste");
  expect(ultimas).toContain(`href="/painel/cobrancas?id=${CH2}"`);
  expect(ultimas).toContain(`href="/painel/saques/${PO1}"`);
  expect(ultimas).toContain(`+${brl(20_000)}`);
  expect(ultimas).toContain(brl(-5_000));
  expect(ultimas).toContain(brl(130_000)); // saldo após o Pix de 02/10: 20.000 + 100.000 + 10.000
  expect(ultimas.indexOf(CH2)).toBeLessThan(ultimas.indexOf(PO1));

  const dia = secao(html, "resumo-dia");
  expect(dia).toContain("17/10");
  expect(dia).toContain("Entradas (1)");
  expect(dia).toContain("Saídas (0)");
  expect(dia).toContain(`+${brl(20_000)}`);

  expect(secao(html, "alertas")).toContain("Nenhum alerta");
});

it("alertas: webhook com falha nos últimos 7 dias, saldo bloqueado e MED com prazo < 48 h — só do próprio lojista", async () => {
  const outro = await newMerchant(d, 2);
  const endpoint = async (merchantId: string) =>
    (
      await d
        .insert(webhookEndpoints)
        .values({ merchantId, url: "https://loja.example.com/h", secretEnc: "x", events: ["charge.paid"] })
        .returning()
    )[0].id;
  const falha = (endpointId: string, at: string) =>
    d.insert(webhookDeliveries).values({ endpointId, eventId: `evt_${at}`, eventType: "charge.paid", payload: {}, status: "failed", createdAt: new Date(at) });
  const caso = async (merchantId: string, n: number, prazoMs: number) => {
    const [c] = await d
      .insert(charges)
      .values({ merchantId, txid: `tx${n}`, externalRef: `ref${n}`, amountCents: 1000, feeCents: 0, status: "paid", brcode: "x", providerChargeId: `pc${n}`, expiresAt: NOW })
      .returning();
    await d.insert(medCases).values({
      merchantId,
      chargeId: c.id,
      providerCaseId: `case${n}`,
      amountCents: 1000,
      reason: "golpe",
      status: "open",
      defenseDeadline: new Date(NOW.getTime() + prazoMs),
    });
  };

  const meu = await endpoint(m);
  await falha(meu, "2026-10-11T02:59:59Z"); // 10/10 23:59 em Brasília: fora da janela de 7 dias (11–17/10)
  await falha(await endpoint(outro), "2026-10-16T15:00:00Z");
  await caso(m, 1, 5 * 24 * HOUR); // prazo longo
  await caso(m, 2, -HOUR); // prazo já passou: não há mais o que fazer
  await caso(outro, 3, 24 * HOUR);
  await lanca(outro, 3_000, "med_hold", "med_case", uuid(7), "2026-10-16T15:00:00Z", "blocked");
  expect(secao(await render(), "alertas")).toContain("Nenhum alerta");

  await falha(meu, "2026-10-11T03:00:00Z"); // 11/10 00:00 em Brasília: primeiro instante da janela
  await caso(m, 4, 47 * HOUR);
  await lanca(m, -3_000, "med_hold", "med_case", uuid(8), "2026-10-16T15:00:00Z");
  await lanca(m, 3_000, "med_hold", "med_case", uuid(8), "2026-10-16T15:00:00Z", "blocked");
  const alertas = secao(await render(), "alertas");
  expect(alertas).toContain('href="/painel/integracoes/entregas"');
  expect(alertas).toContain('href="/painel/extrato"');
  expect(alertas).toContain(brl(3_000));
  expect(alertas).toContain('href="/painel/med"');
  expect(alertas).toContain("1 caso de MED");
  expect(alertas).not.toContain("Nenhum alerta");
});

it("período pela URL: personalizado, atalho ativo; inválido ou acima de 366 dias volta para este mês com aviso", async () => {
  await cenario();
  const set = await render({ de: "2026-09-14", ate: "2026-09-30" });
  expect(set).toContain('value="2026-09-14"');
  expect(set).toContain('value="2026-09-30"');
  expect(secao(set, "kpis")).toContain("1 Pix recebido");
  expect(secao(set, "kpis")).toContain(brl(20_000));

  expect(await render({ de: "2026-10-17", ate: "2026-10-17" })).toMatch(/<a [^>]*aria-current="true"[^>]*>Hoje<\/a>/);
  expect(await render()).toMatch(/<a [^>]*aria-current="true"[^>]*>Este mês<\/a>/);
  expect(await render({ de: "2026-10-11", ate: "2026-10-17" })).toMatch(/<a [^>]*aria-current="true"[^>]*>7 dias<\/a>/);

  expect(await render({ de: "2025-10-17", ate: "2026-10-17" })).not.toContain("Período inválido"); // 366 dias: o máximo
  for (const sp of [
    { de: "2026-10-20", ate: "2026-10-01" },
    { de: "2025-10-16", ate: "2026-10-17" },
    { de: "lixo" },
    { de: "2026-02-30", ate: "2026-03-01" },
  ]) {
    const html = await render(sp);
    expect(html).toContain("Período inválido");
    expect(html).toContain('value="2026-10-01"');
    expect(html).toContain('value="2026-10-17"');
  }
});

it("limites Pix: demonstração, usado hoje de um limite diário configurável e o teto por transferência", async () => {
  await lanca(m, -7_000, "cash_out", "payout", uuid(5), "2026-10-17T13:00:00Z");
  await lanca(m, -9_000, "cash_out", "payout", uuid(6), "2026-10-16T13:00:00Z"); // ontem: fora do diário
  const lim = secao(await render(), "limites");
  expect(lim).toContain("demonstração");
  expect(lim).toContain("requer parceiro de Pix");
  expect(lim).toContain(brl(7_000));
  expect(lim).not.toContain(brl(16_000));
  expect(lim).toContain(brl(100_000_000));
  expect(lim).toContain(brl(payoutCeilingCents()));

  vi.stubEnv("PIX_DAILY_LIMIT_CENTS", "2500000");
  expect(secao(await render(), "limites")).toContain(brl(2_500_000));
  vi.stubEnv("PIX_DAILY_LIMIT_CENTS", "lixo");
  expect(secao(await render(), "limites")).toContain(brl(100_000_000));
});

it("sem sessão de lojista a página não renderiza (painelSession na própria página)", async () => {
  auth.session = null;
  await expect(render()).rejects.toThrow("NEXT_REDIRECT");
});
