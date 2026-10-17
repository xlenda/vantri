import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRole } from "@/lib/auth/perms";
import { sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, charges, payouts, sessions, users } from "@/lib/db/schema";
import { createTestDb } from "@/tests/helpers/db";
import { newMerchant } from "@/tests/helpers/factories";
import { todayDate } from "../format";
import { GET } from "./export/route";
import { exportTransactions } from "./lib";
import TransacoesPage from "./page";

// Guarda de verdade (requireAdmin + matriz de papéis); o único ponto simulado é o cookie da requisição.
const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vantri_session" && cookieJar.token ? { name, value: cookieJar.token } : undefined),
  }),
}));

let d: Db;
let seq = 0;

beforeEach(async () => {
  vi.stubEnv("PIX_PROVIDER", "simulator");
  d = await createTestDb();
  setDb(d);
  cookieJar.token = undefined;
});

afterEach(() => vi.unstubAllEnvs());

/** Admin logado, com 2FA feito, no sub-papel dado. Devolve o id do usuário. */
async function loginAs(adminRole: AdminRole) {
  const [u] = await d
    .insert(users)
    .values({ email: `${adminRole}${++seq}@vantri.test`, passwordHash: "x", role: "admin", adminRole, totpEnabled: true })
    .returning({ id: users.id });
  const token = randomBytes(32).toString("hex");
  await d
    .insert(sessions)
    .values({ id: sha256Hex(token), userId: u.id, mfaPassed: true, expiresAt: new Date(Date.now() + 3_600_000) });
  cookieJar.token = token;
  return u.id;
}

const merchant = () => newMerchant(d, ++seq);
const day = (s: string) => new Date(`${s}-03:00`);

async function charge(merchantId: string, o: Partial<typeof charges.$inferInsert> = {}) {
  const n = ++seq;
  const [c] = await d
    .insert(charges)
    .values({
      merchantId,
      txid: `tx${n}`,
      externalRef: `ref${n}`,
      amountCents: 10000,
      feeCents: 149,
      status: "paid",
      brcode: "000201",
      providerChargeId: `sim_ch_${n}`,
      expiresAt: new Date(Date.now() + 3600_000),
      paidAt: new Date(),
      ...o,
    })
    .returning();
  return c;
}

async function payout(merchantId: string, o: Partial<typeof payouts.$inferInsert> = {}) {
  const n = ++seq;
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId,
      amountCents: 1000,
      feeCents: 100,
      pixKey: "pix@exemplo.com",
      pixKeyType: "email",
      status: "processing",
      idempotencyKey: `k${n}`,
      requestHash: "h",
      ...o,
    })
    .returning();
  return p;
}

const exportUrl = (q: string) => new Request(`http://localhost/admin/transacoes/export?${q}`);
// .text() descarta o BOM (spec do fetch); lemos os bytes com ignoreBOM para ver o arquivo como ele é.
const body = async (res: Response) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
const lines = (text: string) => text.replace(/^﻿/, "").trimEnd().split("\r\n");
const page = async (sp: Record<string, string>) =>
  renderToStaticMarkup(await TransacoesPage({ searchParams: Promise.resolve(sp) }));
const digest = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { digest?: string }) => e.digest ?? String(e),
  );

describe("exportação de transações", () => {
  it("cobranças: só o filtro de cliente e período, todas as páginas, sem campo interno, e audita", async () => {
    const a = await merchant();
    const b = await merchant();
    const early = await charge(a, { createdAt: day("2026-10-10T00:00:00"), description: "=1+1", providerChargeId: "sim_ch_INTERNO" });
    const late = await charge(a, { createdAt: day("2026-10-10T23:59:00"), status: "pending", paidAt: null });
    const nextDay = await charge(a, { createdAt: day("2026-10-11T00:00:00") });
    const other = await charge(b, { createdAt: day("2026-10-10T12:00:00") });
    const actor = await loginAs("operador"); // operador exporta

    const res = await GET(exportUrl(`tipo=cobrancas&cliente=${a}&de=2026-10-10&ate=2026-10-10&pagina=2`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="cobrancas-vantri-2026-10-10-a-2026-10-10.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await body(res);
    expect(text.startsWith("﻿")).toBe(true);
    const [header, ...rows] = lines(text);
    expect(header.split(";")).toContain("ID da cobrança");
    // a página da tela (pagina=2) não corta a exportação; mais novas primeiro
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(late.id);
    expect(rows[1]).toContain(early.id);
    expect(text).not.toContain(nextDay.id);
    expect(text).not.toContain(other.id);
    // nada interno: id no parceiro e o lojista (documento cifrado/hash) não saem
    expect(text).not.toContain("sim_ch_INTERNO");
    expect(text).not.toContain("hash-");
    expect(rows[1]).toContain("'=1+1"); // injeção de CSV neutralizada
    expect(rows[1]).toContain("100,00;1,49;98,51");

    const logs = await d.select().from(auditLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorUserId: actor,
      action: "export.transactions",
      meta: { tipo: "cobrancas", merchantId: a, from: "2026-10-10", to: "2026-10-10", rows: 2 },
    });
  });

  it("saques: chave CPF mascarada e nada interno (request_hash, idempotência, id no parceiro)", async () => {
    const a = await merchant();
    const done = await payout(a, {
      pixKey: "52998224725",
      pixKeyType: "cpf",
      status: "completed",
      requestHash: "HASH_INTERNO",
      idempotencyKey: "IDEMP_INTERNA",
      providerPayoutId: "sim_po_INTERNO",
      endToEndId: "E2ESAQUE1",
      completedAt: new Date(),
    });
    const processing = await payout(a);
    await loginAs("admin");

    const res = await GET(exportUrl("tipo=saques&status=completed"));
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="saques-vantri-${todayDate()}.csv"`);
    const text = await body(res);
    const [, ...rows] = lines(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(done.id);
    expect(rows[0]).toContain("***.982.247-**");
    expect(rows[0]).toContain("E2ESAQUE1");
    expect(text).not.toContain(processing.id);
    for (const secret of ["52998224725", "529.982.247-25", "HASH_INTERNO", "IDEMP_INTERNA", "sim_po_INTERNO"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("acima do teto recusa (422), sem arquivo cortado e sem auditoria", async () => {
    const a = await merchant();
    for (let i = 0; i < 3; i++) await charge(a);
    const actor = await loginAs("admin");

    const over = await exportTransactions({ tipo: "cobrancas", page: 1 }, actor, 2);
    expect(over.status).toBe(422);
    expect(over.headers.get("content-disposition")).toBeNull();
    expect(await over.text()).toMatch(/^Transações demais para um arquivo só/);
    expect(await d.select().from(auditLog)).toHaveLength(0);

    const fits = await exportTransactions({ tipo: "cobrancas", page: 1 }, actor, 3);
    expect(fits.status).toBe(200);
    expect(lines(await body(fits))).toHaveLength(4); // cabeçalho + 3
  });

  it("suporte não exporta (404) e sem sessão redireciona; nada na auditoria", async () => {
    await charge(await merchant());
    await loginAs("suporte");
    expect(await digest(GET(exportUrl("tipo=cobrancas")))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    cookieJar.token = undefined;
    expect(await digest(GET(exportUrl("tipo=cobrancas")))).toMatch(/^NEXT_REDIRECT/);
    expect(await d.select().from(auditLog)).toHaveLength(0);
  });
});

describe("detalhe de transações", () => {
  it("cobrança: pagador mascarado mesmo se o documento vier completo, E2E e datas; suporte lê mas não vê exportar", async () => {
    const c = await charge(await merchant(), {
      payerName: "Ana Pagadora",
      payerDocumentMasked: "52998224725", // gravação errada: a tela mascara de novo
      endToEndId: "E2ECOBRANCA1",
    });
    await loginAs("suporte");
    const html = await page({ tipo: "cobrancas" });
    expect(html).toContain("Ana Pagadora");
    expect(html).toContain("***.982.247-**");
    expect(html).not.toContain("52998224725");
    expect(html).not.toContain("529.982.247-25");
    expect(html).toContain("E2ECOBRANCA1");
    expect(html).toContain(c.txid);
    expect(html).toContain("Vence em");
    expect(html).not.toContain("/admin/transacoes/export");
  });

  it("saque: link para a operação do saque, chave mascarada; exportar leva o filtro da tela", async () => {
    const p = await payout(await merchant(), { pixKey: "52998224725", pixKeyType: "cpf" });
    await loginAs("operador");
    const html = await page({ tipo: "saques", status: "processing", pagina: "1" });
    expect(html).toContain(`href="/admin/saques/${p.id}"`);
    expect(html).toContain("***.982.247-**");
    expect(html).not.toContain("52998224725");
    expect(html).toContain('href="/admin/transacoes/export?tipo=saques&amp;status=processing"');
  });

  it("sem sessão de admin a página não abre", async () => {
    await expect(page({})).rejects.toThrow("NEXT_REDIRECT");
  });
});
