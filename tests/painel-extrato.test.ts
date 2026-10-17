import ExcelJS from "exceljs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csvGET } from "@/app/painel/extrato/csv/route";
import { exportSheet, reais, toCsv } from "@/app/painel/extrato/export";
import ExtratoPage from "@/app/painel/extrato/page";
import { parseExtrato, periodShortcuts } from "@/app/painel/extrato/query";
import { GET as xlsxGET } from "@/app/painel/extrato/xlsx/route";
import { brl } from "@/lib/br/money";
import { type Db, setDb } from "@/lib/db/client";
import { charges, ledgerEntries, payouts } from "@/lib/db/schema";
import { XLSX_MIME } from "@/lib/export/xlsx";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Sessão simulada (o guarda de verdade é testado em tests/auth.test.ts); redirect lança como o real.
const auth = vi.hoisted(() => ({ merchantId: "" }));
vi.mock("@/lib/auth/guards", () => ({
  requireUser: vi.fn(async () => ({ user: { id: "u" }, merchant: { id: auth.merchantId } })),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// Busca de verdade, com um interruptor para simular a falha do banco.
const searchFails = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/services/search", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/services/search")>();
  return {
    ...real,
    searchTransactions: async (...args: Parameters<typeof real.searchTransactions>) => {
      if (searchFails.on) throw new Error("falha simulada com dado pessoal");
      return real.searchTransactions(...args);
    },
  };
});

let d: Db;
let m: string;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  m = await newMerchant(d, 1);
  auth.merchantId = m;
  await seedLedger(m);
});

afterEach(() => {
  searchFails.on = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C1 = uuid(1);
const P1 = uuid(2);
const M1 = uuid(3);

// Saldo disponível corrido: 10000, 9851, 6851, 6751, -1249, -1249 (o bloqueado não mexe no disponível).
async function seedLedger(merchantId: string) {
  const rows = [
    [10000, "available", "cash_in", "charge", C1, "2026-03-01T12:00:00Z"],
    [-149, "available", "fee_in", "charge", C1, "2026-03-01T12:01:00Z"],
    [-3000, "available", "cash_out", "payout", P1, "2026-03-02T12:00:00Z"],
    [-100, "available", "fee_out", "payout", P1, "2026-03-02T12:01:00Z"],
    [-8000, "available", "med_hold", "med_case", M1, "2026-03-03T12:00:00Z"],
    [8000, "blocked", "med_hold", "med_case", M1, "2026-03-03T12:00:01Z"],
  ] as const;
  for (const [amountCents, bucket, kind, refType, refId, at] of rows) {
    await d.insert(ledgerEntries).values({ merchantId, amountCents, bucket, kind, refType, refId, createdAt: new Date(at) });
  }
}

const PERIOD = { from: "2026-03-01", to: "2026-03-03" };
const page = async (sp: Record<string, string | string[]>) =>
  renderToStaticMarkup(await ExtratoPage({ searchParams: Promise.resolve(sp) }));
const visible = (html: string) => html.replace(/<[^>]*>/g, " ");
/** Quantos "R$" da página NÃO estão no começo de um elemento valor-sensivel (o "ocultar saldos" esconderia). */
const exposedMoney = (html: string) =>
  (html.match(/R\$/g)?.length ?? 0) - (html.match(/class="valor-sensivel[^"]*">[+-]?R\$/g)?.length ?? 0);
const req = (qs: string, path = "csv") => new Request(`http://localhost/painel/extrato/${path}?${qs}`);
const valid = (qs: string, today = "2026-03-03") => {
  const r = parseExtrato(new URLSearchParams(qs), today);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("filtros da URL (parseExtrato)", () => {
  const p = (qs: string) => parseExtrato(new URLSearchParams(qs), "2026-10-17");

  it("sem datas é este mês; só 'até' é o mês dele; 366 dias passam", () => {
    expect(p("")).toEqual({ ok: true, value: { from: "2026-10-01", to: "2026-10-17", fecho: false } });
    expect(p("to=2026-03-15")).toMatchObject({ ok: true, value: { from: "2026-03-01", to: "2026-03-15" } });
    expect(p("from=2025-10-17&to=2026-10-17").ok).toBe(true);
  });

  it("atalhos Hoje / 7 dias / Este mês", () => {
    expect(periodShortcuts("2026-10-17").map((s) => [s.label, s.from, s.to])).toEqual([
      ["Hoje", "2026-10-17", "2026-10-17"],
      ["7 dias", "2026-10-11", "2026-10-17"],
      ["Este mês", "2026-10-01", "2026-10-17"],
    ]);
  });

  it.each(["from=2026-10-18&to=2026-10-17", "from=2026-02-30", "from=17/10/2026", "from=2025-10-16&to=2026-10-17", "from=2026-10-20"])(
    "período inválido: %s",
    (qs) => expect(p(qs)).toEqual({ ok: false, error: expect.stringContaining("Período inválido") }),
  );

  it("tipo repetido, movimento, faixa de valor em reais, visão e cursor", () => {
    expect(p(`kind=fee_in&kind=fee_out&direction=out&min=1,50&max=1.000,00&visao=fecho&cursor=${C1}`)).toEqual({
      ok: true,
      value: {
        from: "2026-10-01",
        to: "2026-10-17",
        kind: ["fee_in", "fee_out"],
        direction: "out",
        minCents: 150,
        maxCents: 100000,
        fecho: true,
        cursor: C1,
      },
    });
    expect(p("cursor=nao-e-uuid&direction=&min=")).toEqual({ ok: true, value: { from: "2026-10-01", to: "2026-10-17", fecho: false } });
  });

  it.each([
    ["kind=toString", "Filtro inválido"],
    ["kind=cash_in&kind=pix", "Filtro inválido"],
    ["direction=x", "Filtro inválido"],
    ["min=abc", "Valor mínimo inválido"],
    ["max=1.234", "Valor máximo inválido"],
    ["min=10&max=5", "Faixa de valor inválida"],
  ])("filtro inválido: %s", (qs, msg) => expect(p(qs)).toEqual({ ok: false, error: expect.stringContaining(msg) }));
});

describe("tela do extrato", () => {
  it("lançamentos: cards do período, saldo após de cada linha, links e todo valor sob valor-sensivel", async () => {
    const html = await page(PERIOD);
    const t = visible(html);
    for (const s of ["Entradas no período", "Saídas no período", "Resultado", "1 Pix recebido", "1 saque", "no saldo bloqueado"]) {
      expect(t).toContain(s);
    }
    expect(html).toContain(`>${brl(7000)}<`); // resultado = entradas − saídas
    for (const bal of [10000, 9851, 6851, 6751, -1249]) expect(html).toContain(`>${brl(bal)}<`); // saldo após
    expect(exposedMoney(html)).toBe(0);
    expect(t).not.toContain("fica indisponível");
    expect(html).toContain(`href="/painel/cobrancas?id=${C1}"`);
    expect(html).toContain(`href="/painel/saques/${P1}"`);
    expect(html).toContain(`href="/painel/med?id=${M1}"`);
    expect(html).toContain('href="/painel/extrato/csv?from=2026-03-01&amp;to=2026-03-03"');
    expect(html).toContain('href="/painel/extrato/xlsx?from=2026-03-01&amp;to=2026-03-03"');
  });

  it("sem datas abre em 'Este mês' (atalho marcado)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-03T15:00:00Z"));
    const html = await page({});
    const atalho = html.match(/<a [^>]*>Este mês<\/a>/)?.[0] ?? "";
    expect(atalho).toContain('href="/painel/extrato?from=2026-03-01&amp;to=2026-03-03"');
    expect(atalho).toContain('aria-current="page"');
    expect(html.match(/<a [^>]*>Hoje<\/a>/)?.[0]).not.toContain("aria-current");
    expect(html).toContain(`>${brl(7000)}<`);
  });

  it("filtro de tipo: coluna Saldo após vira — com aviso, e o filtro segue no export", async () => {
    const html = await page({ ...PERIOD, kind: ["fee_in", "fee_out"] });
    expect(visible(html)).toContain("a coluna Saldo após fica indisponível (—)");
    expect(html.match(/>—</g)).toHaveLength(2);
    expect(html).not.toContain(brl(9851));
    const box = (v: string) => html.match(new RegExp(`<input type="checkbox"[^>]*value="${v}"[^>]*>`))?.[0];
    expect(box("fee_in")).toContain('checked=""');
    expect(box("cash_in")).not.toContain("checked");
    expect(html).toContain("<details open");
    expect(html).toContain('href="/painel/extrato/csv?from=2026-03-01&amp;to=2026-03-03&amp;kind=fee_in&amp;kind=fee_out"');
    expect(exposedMoney(html)).toBe(0);
  });

  it("fechamento diário: abertura, entradas, saídas, tarifas, MED e fechamento; sem 'fecho' no texto", async () => {
    const html = await page({ ...PERIOD, visao: "fecho" });
    const t = visible(html);
    for (const s of ["Fechamento diário", "Abertura", "Tarifas", "MED", "01/03/2026", "02/03/2026", "03/03/2026"]) expect(t).toContain(s);
    for (const v of [9851, 6751, -1249, -8000, 149]) expect(html).toContain(`>${brl(v)}<`);
    expect(t).not.toMatch(/\bfecho\b/i);
    expect(html).toContain('href="/painel/extrato/xlsx?from=2026-03-01&amp;to=2026-03-03&amp;visao=fecho"');
    expect(exposedMoney(html)).toBe(0);
  });

  it("período ou valor inválido: aviso, sem dados", async () => {
    let t = visible(await page({ from: "2026-03-05", to: "2026-03-01" }));
    expect(t).toContain("Período inválido");
    expect(t).not.toContain("Entradas no período");
    t = visible(await page({ ...PERIOD, min: "abc" }));
    expect(t).toContain("Valor mínimo inválido");
  });

  it("export grande demais volta com aviso", async () => {
    expect(visible(await page({ ...PERIOD, erro: "muitas-linhas" }))).toContain("passaria de 50.000 lançamentos");
  });
});

describe("busca no topo do extrato", () => {
  async function charge(merchantId: string, txid: string) {
    const [c] = await d
      .insert(charges)
      .values({
        merchantId,
        txid,
        externalRef: `ref-${txid}`,
        amountCents: 14990,
        feeCents: 223,
        status: "paid",
        brcode: "000201...",
        providerChargeId: `sim_${txid}`,
        expiresAt: new Date(Date.now() + 3600_000),
        payerName: "Maria Souza",
      })
      .returning();
    return c;
  }

  it("acha cobrança e transferência do lojista, com link para o detalhe", async () => {
    const c = await charge(m, "TX-EXTRATO-1");
    const [p] = await d
      .insert(payouts)
      .values({
        merchantId: m,
        amountCents: 5000,
        feeCents: 100,
        pixKey: "fornecedor@exemplo.com",
        pixKeyType: "email",
        status: "completed",
        endToEndId: "E00000000202603021200abcdef0001",
        idempotencyKey: "idem-1",
        requestHash: "hash-1",
      })
      .returning();

    let html = await page({ ...PERIOD, q: "TX-EXTRATO-1" });
    expect(visible(html)).toContain("Cobranças (Pix recebido)");
    expect(html).toContain(`href="/painel/cobrancas?id=${c.id}"`);
    expect(html).toContain(`>${brl(14990)}<`);
    expect(exposedMoney(html)).toBe(0);

    html = await page({ ...PERIOD, q: "E00000000202603021200abcdef0001" });
    expect(visible(html)).toContain("Transferências (Pix enviado)");
    expect(html).toContain(`href="/painel/saques/${p.id}"`);
    expect(html).not.toContain("fornecedor@exemplo.com"); // a chave Pix inteira não aparece na lista
  });

  it("nada encontrado (inclusive de outro lojista), termo curto, e falha que não diz 'não existe'", async () => {
    const outro = await newMerchant(d, 2);
    await charge(outro, "TX-OUTRO");
    expect(visible(await page({ ...PERIOD, q: "TX-OUTRO" }))).toContain("Nenhuma transação encontrada para “TX-OUTRO”");
    expect(visible(await page({ ...PERIOD, q: "a" }))).toContain("Digite pelo menos 2 caracteres");

    searchFails.on = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = visible(await page({ ...PERIOD, q: "TX-OUTRO" }));
    expect(t).toContain("isto não significa que a transação não exista");
    expect(t).not.toContain("Nenhuma transação encontrada");
    expect(t).toContain("Entradas no período"); // o resto da tela segue de pé
    expect(log).toHaveBeenCalledWith("extrato: busca falhou", expect.not.stringContaining("dado pessoal"));
  });
});

describe("arquivos CSV e XLSX", () => {
  const lines = (body: string) => body.replace(/^﻿/, "").trimEnd().split("\r\n");

  it("CSV do extrato: cabeçalhos de download, BOM, saldo após com sinal", async () => {
    const res = await csvGET(req("from=2026-03-01&to=2026-03-03"));
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="extrato-vantri-2026-03-01-a-2026-03-03.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM (o text() do fetch o descarta ao decodificar)
    const [head, ...rows] = lines(new TextDecoder().decode(bytes));
    expect(head).toBe(
      "Data;Lançamento;Saldo afetado;Referência;ID da referência;Entrada (R$);Saída (R$);Saldo após (R$);ID do lançamento",
    );
    expect(rows.map((l) => l.split(";").slice(1, 8))).toEqual([
      ["Bloqueio por MED", "Bloqueado", "MED", M1, "80,00", "", "-12,49"],
      ["Bloqueio por MED", "Disponível", "MED", M1, "", "80,00", "-12,49"],
      ["Tarifa do saque", "Disponível", "Saque", P1, "", "1,00", "67,51"],
      ["Saque", "Disponível", "Saque", P1, "", "30,00", "68,51"],
      ["Tarifa do Pix recebido", "Disponível", "Cobrança", C1, "", "1,49", "98,51"],
      ["Pix recebido", "Disponível", "Cobrança", C1, "100,00", "", "100,00"],
    ]);
    expect(rows[5]).toMatch(/^01\/03\/2026,? 09:00:00;/); // horário de Brasília
  });

  it("CSV com filtro de tipo e movimento: só as linhas pedidas, saldo após vazio", async () => {
    const res = await csvGET(req("from=2026-03-01&to=2026-03-03&kind=fee_in&kind=fee_out&kind=cash_out&direction=out&min=1,00"));
    expect(lines(await res.text()).slice(1).map((l) => l.split(";").slice(1, 8))).toEqual([
      ["Tarifa do saque", "Disponível", "Saque", P1, "", "1,00", ""],
      ["Saque", "Disponível", "Saque", P1, "", "30,00", ""],
      ["Tarifa do Pix recebido", "Disponível", "Cobrança", C1, "", "1,49", ""],
    ]);
  });

  it("CSV do fechamento diário", async () => {
    const res = await csvGET(req("from=2026-03-01&to=2026-03-03&visao=fecho"));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="fechamento-diario-vantri-2026-03-01-a-2026-03-03.csv"');
    expect(lines(await res.text())).toEqual([
      "Data;Abertura (R$);Entradas (R$);Saídas (R$);Tarifas (R$);MED (R$);Fechamento (R$)",
      "01/03/2026;0,00;100,00;0,00;1,49;0,00;98,51",
      "02/03/2026;98,51;0,00;30,00;1,00;0,00;67,51",
      "03/03/2026;67,51;0,00;0,00;0,00;-80,00;-12,49",
    ]);
  });

  async function sheetOf(res: Response) {
    const wb = new ExcelJS.Workbook();
    // load() aceita os bytes em runtime; o .d.ts do exceljs tipa o parâmetro com um Buffer próprio que não casa.
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    return wb.worksheets[0];
  }

  it("XLSX do extrato: dinheiro como número em reais (o Excel soma)", async () => {
    const res = await xlsxGET(req("from=2026-03-01&to=2026-03-03", "xlsx"));
    expect(res.headers.get("content-type")).toBe(XLSX_MIME);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="extrato-vantri-2026-03-01-a-2026-03-03.xlsx"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ws = await sheetOf(res);
    expect(ws.name).toBe("Extrato");
    expect(ws.getCell("H1").value).toBe("Saldo após (R$)");
    expect([ws.getCell("F2").value, ws.getCell("H2").value]).toEqual([80, -12.49]);
    expect([ws.getCell("G6").value, ws.getCell("H6").value]).toEqual([1.49, 98.51]);
    expect([ws.getCell("B7").value, ws.getCell("F7").value, ws.getCell("H7").value]).toEqual(["Pix recebido", 100, 100]);
  });

  it("XLSX do fechamento diário", async () => {
    const ws = await sheetOf(await xlsxGET(req("from=2026-03-01&to=2026-03-03&visao=fecho", "xlsx")));
    expect(ws.name).toBe("Fechamento diário");
    expect((ws.getRow(4).values as unknown[]).slice(1)).toEqual(["03/03/2026", 67.51, 0, 0, 0, -80, -12.49]);
  });

  it("filtro inválido volta para a tela (que mostra o erro), CSV e XLSX", async () => {
    await expect(csvGET(req("from=2026-03-05&to=2026-03-01"))).rejects.toThrow(
      "NEXT_REDIRECT /painel/extrato?from=2026-03-05&to=2026-03-01",
    );
    await expect(xlsxGET(req("min=abc&cursor=x", "xlsx"))).rejects.toThrow("NEXT_REDIRECT /painel/extrato?min=abc");
  });

  it("só os lançamentos do lojista da sessão", async () => {
    auth.merchantId = await newMerchant(d, 2);
    expect(lines(await (await csvGET(req("from=2026-03-01&to=2026-03-03"))).text())).toHaveLength(1); // só o cabeçalho
  });

  it("acima do limite de linhas recusa em vez de cortar", async () => {
    expect(await exportSheet(m, valid("from=2026-03-01&to=2026-03-03"), 5)).toBeNull();
    expect((await exportSheet(m, valid("from=2026-03-01&to=2026-03-03"), 6))?.rows).toHaveLength(6);
  });

  it("CSV: texto contra injeção de fórmula; dinheiro com sinal continua número", () => {
    expect(toCsv({ name: "x", title: "x", header: ["=SOMA(A1)"], rows: [["@cmd", -150, ""]] })).toBe("﻿'=SOMA(A1)\r\n'@cmd;-1,50;\r\n");
    expect([0, 5, -50, 99, 100, 123456, -123456].map(reais)).toEqual(["0,00", "0,05", "-0,50", "0,99", "1,00", "1234,56", "-1234,56"]);
  });
});
