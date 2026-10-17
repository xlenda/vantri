import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TransacoesPage from "@/app/painel/transacoes/page";
import { listTransactions, medCaseIdsOfCharge, parseTxFilters, type TxFilters } from "@/app/painel/transacoes/queries";
import { brl, dateTime } from "@/lib/br/money";
import { type Db, setDb } from "@/lib/db/client";
import { charges, medCases, medEvents, payouts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Sessão simulada (o guarda de verdade é testado em tests/auth.test.ts): o lojista da sessão é `auth.merchantId`.
const auth = vi.hoisted(() => ({ merchantId: "" }));
vi.mock("@/lib/auth/guards", () => ({
  requireUser: vi.fn(async () => ({ user: { id: "u1" }, merchant: { id: auth.merchantId } })),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

let d: Db;
let m: string; // lojista da sessão
let outro: string;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  m = await newMerchant(d, 1);
  outro = await newMerchant(d, 2);
  auth.merchantId = m;
});

let seq = 0;
async function charge(merchantId: string, over: Partial<typeof charges.$inferInsert> = {}) {
  seq++;
  const [c] = await d
    .insert(charges)
    .values({
      merchantId,
      txid: `txid-${seq}`,
      externalRef: `ref-${seq}`,
      amountCents: 14990,
      feeCents: 223,
      status: "paid",
      brcode: `000201-brcode-${seq}`,
      providerChargeId: `sim_ch_${seq}`,
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
      pixKey: "fornecedor@exemplo.com",
      pixKeyType: "email",
      status: "completed",
      idempotencyKey: `idem-${seq}`,
      requestHash: `hash-${seq}`,
      ...over,
    })
    .returning();
  return p;
}

const ids = async (f: TxFilters, limit?: number) => (await listTransactions(m, f, limit)).data.map((t) => t.row.id);

describe("listTransactions", () => {
  it("cobranças e saques numa lista só, mais novos primeiro; nada de outro lojista", async () => {
    const c1 = await charge(m, { createdAt: new Date("2026-10-01T10:00:00Z") });
    const p1 = await payout(m, { createdAt: new Date("2026-10-01T11:00:00Z") });
    const c2 = await charge(m, { createdAt: new Date("2026-10-01T12:00:00Z") });
    await charge(outro, { createdAt: new Date("2026-10-01T13:00:00Z") });
    await payout(outro, { createdAt: new Date("2026-10-01T13:30:00Z") });

    const r = await listTransactions(m, {});
    expect(r.data.map((t) => [t.kind, t.row.id])).toEqual([
      ["charge", c2.id],
      ["payout", p1.id],
      ["charge", c1.id],
    ]);
    expect(r.nextCursor).toBeNull();
  });

  it("cursor percorre as duas tabelas sem repetir nem pular, inclusive no mesmo milissegundo", async () => {
    // Mesmo milissegundo, microssegundos diferentes: a cobrança é a mais nova, mas o id do saque é maior. Ordenar pelo
    // Date do JS (milissegundos) com desempate por id poria o saque antes e a página seguinte pularia a cobrança.
    const c = await charge(m, { id: "00000000-0000-4000-8000-000000000001" });
    const p = await payout(m, { id: "ffffffff-ffff-4fff-bfff-ffffffffffff" });
    await d.update(charges).set({ createdAt: sql`'2026-10-01 12:00:00.000900+00'` }).where(eq(charges.id, c.id));
    await d.update(payouts).set({ createdAt: sql`'2026-10-01 12:00:00.000100+00'` }).where(eq(payouts.id, p.id));
    // Mesmo microssegundo: desempata pelo id (maior primeiro), como o banco compara no cursor.
    const c2 = await charge(m, { id: "00000000-0000-4000-8000-000000000002" });
    const p2 = await payout(m, { id: "ffffffff-ffff-4fff-bfff-fffffffffffe" });
    await d.update(charges).set({ createdAt: sql`'2026-09-30 18:00:00.000500+00'` }).where(eq(charges.id, c2.id));
    await d.update(payouts).set({ createdAt: sql`'2026-09-30 18:00:00.000500+00'` }).where(eq(payouts.id, p2.id));
    const older = await payout(m, { createdAt: new Date("2026-09-30T12:00:00Z") });
    const oldest = await charge(m, { createdAt: new Date("2026-09-29T12:00:00Z") });

    for (const size of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listTransactions(m, { cursor }, size);
        expect(page.data.length).toBeLessThanOrEqual(size);
        seen.push(...page.data.map((t) => t.row.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual([c.id, p.id, p2.id, c2.id, older.id, oldest.id]);
    }
  });

  it("cursor de outro lojista: página vazia (nunca os dados dele)", async () => {
    await charge(m);
    const alheio = await payout(outro);
    expect(await ids({ cursor: alheio.id })).toEqual([]);
  });

  it("filtra no servidor por tipo e situação; pendente vencida conta como expirada", async () => {
    const pend = await charge(m, { status: "pending", expiresAt: new Date(Date.now() + 3600_000) });
    const vencida = await charge(m, { status: "pending", expiresAt: new Date(Date.now() - 1000) });
    const paga = await charge(m, { status: "paid" });
    const proc = await payout(m, { status: "processing" });
    const feito = await payout(m, { status: "completed" });
    const falhou = await payout(m, { status: "failed" });
    const sorted = async (f: TxFilters) => (await ids(f)).sort();

    expect(await sorted({ situacao: "andamento" })).toEqual([pend.id, proc.id].sort());
    expect(await sorted({ situacao: "concluidas" })).toEqual([paga.id, feito.id].sort());
    expect(await sorted({ situacao: "falhas" })).toEqual([vencida.id, falhou.id].sort());
    expect(await sorted({ tipo: "saques" })).toEqual([proc.id, feito.id, falhou.id].sort());
    expect(await sorted({ tipo: "cobrancas" })).toEqual([pend.id, vencida.id, paga.id].sort());
    const [x] = (await listTransactions(m, { tipo: "cobrancas", situacao: "falhas" })).data;
    expect([x.row.id, x.row.status]).toEqual([vencida.id, "expired"]);
  });

  it("período pelo dia de criação em Brasília, 'ate' inclusivo", async () => {
    const fimDo1 = await charge(m, { createdAt: new Date("2026-10-02T02:59:59.999Z") }); // 01/10 23:59:59 em Brasília
    const inicioDo2 = await payout(m, { createdAt: new Date("2026-10-02T03:00:00.000Z") }); // 02/10 00:00 em Brasília
    const do3 = await charge(m, { createdAt: new Date("2026-10-03T15:00:00Z") });

    expect(await ids({ de: "2026-10-01", ate: "2026-10-01" })).toEqual([fimDo1.id]);
    expect(await ids({ de: "2026-10-02", ate: "2026-10-02" })).toEqual([inicioDo2.id]);
    expect(await ids({ de: "2026-10-02" })).toEqual([do3.id, inicioDo2.id]);
    expect(await ids({ ate: "2026-10-02" })).toEqual([inicioDo2.id, fimDo1.id]);
  });

  it("parseTxFilters: lista branca da URL; valor inválido ou repetido some", () => {
    const id = "3f1c2b8e-7a4d-4c1e-9b2a-1d2e3f4a5b6c";
    expect(
      parseTxFilters({ tipo: "saques", situacao: "falhas", de: "2026-10-01", ate: "2026-10-31", cursor: id, merchantId: outro }),
    ).toEqual({ tipo: "saques", situacao: "falhas", de: "2026-10-01", ate: "2026-10-31", cursor: id });
    expect(
      parseTxFilters({ tipo: "tudo", situacao: ["andamento", "falhas"], de: "2026-13-01", ate: "ontem", cursor: "1' or '1'='1" }),
    ).toEqual({});
  });

  it("medCaseIdsOfCharge: só os casos do próprio lojista", async () => {
    const c = await charge(m);
    const [mc] = await d
      .insert(medCases)
      .values({ merchantId: m, chargeId: c.id, providerCaseId: "sim_med_1", amountCents: 100, reason: "golpe", status: "open", defenseDeadline: new Date() })
      .returning();
    expect(await medCaseIdsOfCharge(m, c.id)).toEqual([mc.id]);
    expect(await medCaseIdsOfCharge(outro, c.id)).toEqual([]);
    expect(await medCaseIdsOfCharge(m, "não-é-uuid")).toEqual([]);
  });
});

describe("página /painel/transacoes", () => {
  const render = async (sp: Record<string, string>) =>
    renderToStaticMarkup(await TransacoesPage({ searchParams: Promise.resolve(sp) }));
  // Todo valor em R$ da tela fica num elemento com a classe valor-sensivel (o "ocultar saldos" esconde).
  const allSensitive = (html: string) => {
    const shown = html.match(/>[^<>]*R\$[^<>]*</g) ?? [];
    const hidden = html.match(/class="[^"]*\bvalor-sensivel\b[^"]*">R\$[^<>]*</g) ?? [];
    return shown.length > 0 && shown.length === hidden.length;
  };

  it("lista do lojista da sessão, sem as transações de outro", async () => {
    await charge(m, { description: "Pedido da casa" });
    await payout(m, { description: "Fornecedor da casa" });
    await charge(outro, { description: "Pedido alheio" });
    const html = await render({});
    expect(html).toContain("Pedido da casa");
    expect(html).toContain("Fornecedor da casa");
    expect(html).not.toContain("Pedido alheio");
    expect(allSensitive(html)).toBe(true);
  });

  it("id de outro lojista: não encontrada, sem vazar nada dele", async () => {
    const alheia = await charge(outro, { description: "Pedido alheio", amountCents: 77_700 });
    const html = await render({ id: alheia.id });
    expect(html).toContain("Transação não encontrada.");
    expect(html).not.toContain("Pedido alheio");
    expect(html).not.toContain(brl(77_700));
    expect(html).not.toContain(alheia.txid);
  });

  it("detalhe da cobrança: abas com tarifa de verdade, você recebeu, entregas, linha do tempo com MED e JSON público", async () => {
    const c = await charge(m, {
      description: "Pedido 42",
      payerName: "Maria Silva",
      payerDocumentMasked: "***.456.789-**",
      endToEndId: "E12345678202610011200abcdef0001",
      paidAt: new Date("2026-10-01T15:00:00Z"),
    });
    const [ep] = await d
      .insert(webhookEndpoints)
      .values({ merchantId: m, url: "https://loja.example.com/hook", secretEnc: "x", events: ["charge.paid"] })
      .returning();
    await d.insert(webhookDeliveries).values({
      endpointId: ep.id,
      eventId: "evt_1",
      eventType: "charge.paid",
      payload: { id: "evt_1", type: "charge.paid", data: { id: c.id } },
      status: "delivered",
      attempts: 1,
      lastStatusCode: 200,
    });
    const [mc] = await d
      .insert(medCases)
      .values({ merchantId: m, chargeId: c.id, providerCaseId: "sim_med_9", amountCents: 14990, reason: "golpe", status: "open", defenseDeadline: new Date() })
      .returning();
    const dataDaNota = new Date("2030-01-02T12:00:00Z"); // data única: se a anotação vazasse, ela apareceria
    await d.insert(medEvents).values([
      { medCaseId: mc.id, type: "opened", source: "provider" },
      { medCaseId: mc.id, type: "note", source: "admin", meta: { note: "segredo interno da equipe" }, createdAt: dataDaNota },
    ]);

    const html = await render({ id: c.id });
    for (const aba of ["Resumo", "Pix", "Financeiro", "Webhooks", "Timeline", "Payloads"]) {
      expect(html).toContain(`>${aba}</button>`);
    }
    expect(html).toContain(brl(223)); // tarifa gravada na cobrança
    expect(html).toContain(brl(14990 - 223)); // "você recebeu", do JSON público (net)
    expect(html).toContain("Maria Silva");
    expect(html).toContain("***.456.789-**");
    expect(html).toContain("E12345678202610011200abcdef0001");
    expect(html).toContain("Cobrança paga"); // entrega de webhook desta cobrança
    expect(html).toContain("https://loja.example.com/hook");
    expect(html).toContain("MED aberto pelo banco do pagador");
    expect(html).not.toContain("segredo interno da equipe");
    expect(html).not.toContain(dateTime(dataDaNota)); // anotação interna da equipe fica fora da linha do tempo
    expect(html).toContain(`&quot;id&quot;: &quot;${c.id}&quot;`); // JSON público na aba Payloads
    expect(html).toContain("&quot;net&quot;: 14767");
    expect(html).toContain(`/painel/cobrancas?id=${c.id}`);
    expect(allSensitive(html)).toBe(true);
  });

  it("detalhe do saque: chave CPF mascarada, links para o saque e o comprovante", async () => {
    const p = await payout(m, { pixKey: "12345678909", pixKeyType: "cpf", status: "completed", completedAt: new Date() });
    const html = await render({ id: p.id });
    expect(html).toContain("***.456.789-**");
    expect(html).not.toContain("12345678909"); // nem na aba Pix nem fora do JSON público
    expect(html).toContain(`href="/painel/saques/${p.id}"`);
    expect(html).toContain(`href="/painel/saques/${p.id}/comprovante"`);
    expect(allSensitive(html)).toBe(true);
  });

  it("busca por identificador no histórico inteiro, escopada ao lojista", async () => {
    const c = await charge(m, { txid: "TXIDPROCURADO", description: "Achei" });
    await charge(outro, { txid: "TXIDALHEIO", description: "Alheia" });
    const html = await render({ q: "TXIDPROCURADO" });
    expect(html).toContain("Achei");
    expect(html).toContain(`id=${c.id}`);
    expect(await render({ q: "TXIDALHEIO" })).toContain("Nada encontrado");
  });
});
