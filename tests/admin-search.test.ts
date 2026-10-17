import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as exportSearch } from "@/app/admin/busca/export/route";
import BuscaPage from "@/app/admin/busca/page";
import { csvResponse } from "@/app/admin/admin-lib";
import type { AdminRole, Perm } from "@/lib/auth/perms";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, charges, merchants, payouts, users, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { type Hit, searchCsvRows, searchOperations } from "@/lib/services/admin/search";
import { createTestDb } from "./helpers/db";

// O requireAdmin de verdade (sessão + 2FA + papel) está coberto em auth.test.ts/perms.test.ts. Aqui o guarda simulado
// aplica a MESMA matriz (`pode`): o que se prova é que a tela e a exportação pedem a permissão certa.
const auth = vi.hoisted(() => ({
  user: null as null | { id: string; role: "admin"; adminRole: AdminRole | null; email: string },
}));
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const { pode } = await import("@/lib/auth/perms");
  return {
    ...(await importOriginal<typeof import("@/lib/auth/guards")>()),
    requireAdmin: vi.fn(async ({ perm }: { perm: Perm }) => {
      if (!auth.user) throw new Error("NEXT_REDIRECT");
      if (!pode(auth.user.adminRole, perm)) throw new Error("NEXT_NOT_FOUND");
      return { user: auth.user };
    }),
  };
});

// Valores internos que nenhuma busca/exportação pode devolver.
const SECRETS = {
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$SEGREDO-HASH-SENHA",
  totpSecretEnc: "v1:SEGREDO-TOTP:tag:ct",
  requestHash: "SEGREDO-REQUEST-HASH-0001",
  webhookSecretEnc: "v1:SEGREDO-WHSEC:tag:ct",
  documentEnc: "v1:SEGREDO-DOC:tag:ct",
  documentHash: "SEGREDO-DOC-HASH-0001",
  brcode: "00020126SEGREDO-BRCODE",
  payerName: "Fulano Pagador Secreto",
  pixKey: "chave-secreta@pagador.test",
  rawEmail: "beto.silva@cursos.test",
};

const E2E = "E12345678202610171200SHARED0001";

let d: Db;
let admin: { id: string; email: string };
let seq = 0;

async function merchant(tradeName: string, legalName = `${tradeName} LTDA`) {
  seq++;
  const [m] = await d
    .insert(merchants)
    .values({
      legalName,
      tradeName,
      documentType: "cnpj",
      documentEnc: `${SECRETS.documentEnc}-${seq}`,
      documentHash: `${SECRETS.documentHash}-${seq}`,
      segment: "cursos",
      status: "active",
    })
    .returning();
  return m;
}

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
      description: "Curso de violão",
      status: "paid",
      brcode: SECRETS.brcode,
      providerChargeId: `sim_ch_${seq}`,
      expiresAt: new Date(Date.now() + 3600_000),
      payerName: SECRETS.payerName,
      payerDocumentMasked: "***.456.789-**",
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
      pixKey: SECRETS.pixKey,
      pixKeyType: "email",
      status: "completed",
      providerPayoutId: `sim_po_${seq}`,
      idempotencyKey: `idem-${seq}`,
      requestHash: SECRETS.requestHash,
      ...over,
    })
    .returning();
  return p;
}

async function delivery(merchantId: string, eventId: string) {
  const [e] = await d
    .insert(webhookEndpoints)
    .values({ merchantId, url: "https://loja.test/hook", secretEnc: SECRETS.webhookSecretEnc, events: ["charge.paid"] })
    .returning();
  const [w] = await d
    .insert(webhookDeliveries)
    .values({
      endpointId: e.id,
      eventId,
      eventType: "charge.paid",
      payload: { payer: { name: SECRETS.payerName } },
      status: "delivered",
    })
    .returning();
  return w;
}

/** Um pouco de tudo: dois lojistas com cobrança, saque, entrega de webhook e usuário. */
async function seed() {
  const ana = await merchant("Cursos da Ana", "Ana Educação LTDA");
  const beto = await merchant("Mentoria Beto");
  await d.insert(users).values({
    email: SECRETS.rawEmail,
    passwordHash: SECRETS.passwordHash,
    totpSecretEnc: SECRETS.totpSecretEnc,
    role: "merchant",
    merchantId: beto.id,
  });
  const c = await charge(ana.id, { txid: "TXID-ANA-0001", endToEndId: E2E });
  await charge(beto.id);
  const p = await payout(ana.id, { endToEndId: E2E, idempotencyKey: "idem-ana-saque" });
  await payout(beto.id);
  const w = await delivery(ana.id, "evt_ana_0001");
  await delivery(beto.id, "evt_beto_0001");
  return { ana, beto, c, p, w };
}

/** Nenhum valor interno aparece no que a busca devolve. */
function expectNoLeak(x: unknown) {
  const flat = JSON.stringify(x);
  for (const v of Object.values(SECRETS)) expect(flat).not.toContain(v);
  for (const k of ["password", "secret", "request_hash", "requestHash", "document", "brcode", "pixKey", "payload"]) {
    expect(flat).not.toContain(k);
  }
}

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  [admin] = await d
    .insert(users)
    .values({ email: "admin@vantri.test", passwordHash: SECRETS.passwordHash, role: "admin", adminRole: "admin" })
    .returning({ id: users.id, email: users.email });
  auth.user = { id: admin.id, role: "admin", adminRole: "admin", email: admin.email };
});

const byKind = (hits: Hit[], kind: Hit["kind"]) => hits.filter((h) => h.kind === kind);

describe("searchOperations", () => {
  it("E2E acha a cobrança e o saque (admin vê todos os lojistas), só com o resumo que as telas mostram", async () => {
    const { ana, c, p } = await seed();
    const hits = await searchOperations(E2E);

    expect(byKind(hits, "charge")).toEqual([
      {
        kind: "charge",
        id: c.id,
        merchantId: ana.id,
        tradeName: "Cursos da Ana",
        label: "Curso de violão",
        status: "paid",
        amountCents: 14990,
        createdAt: c.createdAt,
      },
    ]);
    expect(byKind(hits, "payout")).toEqual([
      {
        kind: "payout",
        id: p.id,
        merchantId: ana.id,
        tradeName: "Cursos da Ana",
        label: "Saque Pix",
        status: "completed",
        amountCents: 10000,
        createdAt: p.createdAt,
      },
    ]);
    expect(hits).toHaveLength(2);
    expectNoLeak(hits);
    // Sanidade do detector: um hit que carregasse o request_hash seria pego.
    expect(() => expectNoLeak([{ ...hits[1], requestHash: SECRETS.requestHash }])).toThrow();
  });

  it("txid, id, referência e id no parceiro acham a cobrança; id, id no parceiro e chave de idempotência acham o saque", async () => {
    const { c, p } = await seed();
    for (const term of ["TXID-ANA-0001", c.id, c.externalRef, c.providerChargeId]) {
      expect((await searchOperations(term)).map((h) => [h.kind, h.id])).toEqual([["charge", c.id]]);
    }
    for (const term of [p.id, p.providerPayoutId as string, "idem-ana-saque"]) {
      expect((await searchOperations(term)).map((h) => [h.kind, h.id])).toEqual([["payout", p.id]]);
    }
  });

  it("id do evento acha a entrega de webhook (sem payload nem segredo do endpoint)", async () => {
    const { ana, w } = await seed();
    const hits = await searchOperations("evt_ana_0001");
    expect(hits).toEqual([
      {
        kind: "webhook",
        id: w.id,
        merchantId: ana.id,
        tradeName: "Cursos da Ana",
        eventType: "charge.paid",
        status: "delivered",
        createdAt: w.createdAt,
      },
    ]);
    expectNoLeak(hits);
  });

  it("nome fantasia, razão social e e-mail acham o lojista; o e-mail sai mascarado", async () => {
    const { ana, beto } = await seed();
    expect(await searchOperations("cursos da")).toEqual([
      { kind: "merchant", id: ana.id, tradeName: "Cursos da Ana", emailMasked: null, status: "active" },
    ]);
    expect((await searchOperations("educação")).map((h) => h.id)).toEqual([ana.id]);

    const byEmail = await searchOperations("beto.silva@");
    expect(byEmail).toEqual([
      { kind: "merchant", id: beto.id, tradeName: "Mentoria Beto", emailMasked: "b•••@cursos.test", status: "active" },
    ]);
    // Achar pelo nome também mascara: o e-mail cru nunca sai.
    expect((await searchOperations("mentoria"))[0]).toMatchObject({ emailMasked: "b•••@cursos.test" });
    expectNoLeak(byEmail);
  });

  it("termo curto ou vazio não busca", async () => {
    await seed();
    expect(await searchOperations("")).toEqual([]);
    expect(await searchOperations("  a ")).toEqual([]);
  });

  it("injeção e curingas não quebram a query nem trazem tudo: tudo vai por parâmetro", async () => {
    const log: string[] = [];
    d = await createTestDb({ logger: (q) => log.push(q) });
    setDb(d);
    const { ana } = await seed();
    const from = log.length;

    for (const term of ["' OR 1=1 --", "' OR '1'='1", "%", "%%", "__", "\\", "Cursos%", "x'; DROP TABLE charges; --"]) {
      expect(await searchOperations(term)).toEqual([]);
    }
    // O SQL que foi ao banco nunca carrega o termo: ele viaja como parâmetro ($n).
    const sent = log.slice(from).join("\n");
    expect(sent).toContain('"merchants"."trade_name" ilike $'); // o log pegou as consultas da busca (não é vazio)
    expect(sent).not.toContain("1=1");
    expect(sent).not.toContain("DROP TABLE");
    // Sanidade: a tabela continua lá e o termo legítimo acha.
    expect((await searchOperations("Cursos da Ana")).map((h) => h.id)).toEqual([ana.id]);
  });

  it("limite por tipo", async () => {
    // A mesma referência em lojistas diferentes (é única só dentro do lojista).
    for (let i = 0; i < 4; i++) await charge((await merchant(`Loja ${i}`)).id, { externalRef: "REF-REPETIDA" });
    expect(await searchOperations("REF-REPETIDA", 3)).toHaveLength(3);
  });
});

describe("searchCsvRows + exportar resumo", () => {
  it("linhas legíveis por tipo; célula que começa com = sai neutralizada no CSV", async () => {
    const evil = await merchant("=HYPERLINK(1) Cursos");
    const c = await charge(evil.id, { txid: "TXID-EVIL", description: "=1+1" });
    const hits = await searchOperations("TXID-EVIL");
    const { header, rows } = searchCsvRows(hits);
    expect(header).toEqual(["Tipo", "ID", "Cliente", "Descrição", "Status", "Valor (R$)", "Criado em"]);
    expect(rows).toEqual([["Cobrança", c.id, "=HYPERLINK(1) Cursos", "=1+1", "Paga", "149,90", expect.any(String)]]);

    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await csvResponse("x.csv", header, rows).arrayBuffer(),
    );
    expect(text).toContain(`Cobrança;${c.id};'=HYPERLINK(1) Cursos;'=1+1;Paga;149,90;`);
  });

  it("rota de exportação: CSV neutro, no-store, auditoria export.search sem o termo; suporte não exporta", async () => {
    const { ana } = await seed();
    const res = await exportSearch(new Request("http://localhost/admin/busca/export?q=cursos%20da"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="busca-vantri-\d{4}-\d{2}-\d{2}\.csv"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith("﻿Tipo;ID;Cliente;")).toBe(true);
    expect(text).toContain(`Cliente;${ana.id};Cursos da Ana;`);
    expectNoLeak(text);

    const logs = await d.select().from(auditLog).where(eq(auditLog.action, "export.search"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorUserId: admin.id,
      meta: { rows: 1, sha256: createHash("sha256").update(bytes).digest("hex") },
    });
    expect(JSON.stringify(logs[0].meta)).not.toContain("cursos");

    auth.user = { ...auth.user!, adminRole: "suporte" };
    await expect(exportSearch(new Request("http://localhost/admin/busca/export?q=cursos"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

describe("/admin/busca", () => {
  const page = (sp: Record<string, string>) => BuscaPage({ searchParams: Promise.resolve(sp) });

  it("mostra o histórico operacional agrupado, com link para a tela certa e e-mail mascarado", async () => {
    const { ana, beto, c, p, w } = await seed();
    const html = renderToStaticMarkup(await page({ q: E2E }));
    expect(html).toContain("Histórico operacional");
    expect(html).toContain(`/admin/transacoes?tipo=cobrancas&amp;cliente=${ana.id}`);
    expect(html).toContain(`/admin/saques/${p.id}`);
    expect(html).toContain(`/admin/busca/export?q=${E2E}`);
    expect(html).toContain(c.id);
    expectNoLeak(html);

    const hook = renderToStaticMarkup(await page({ q: "evt_ana_0001" }));
    expect(hook).toContain(`/admin/webhooks/${w.id}`);

    const people = renderToStaticMarkup(await page({ q: "beto.silva@" }));
    expect(people).toContain(`/admin/clientes/${beto.id}`);
    expect(people).toContain("b•••@cursos.test");
    expect(people).not.toContain(SECRETS.rawEmail);
  });

  it("suporte consulta mas não vê Exportar nem links de telas que não abre; sem papel → 404", async () => {
    const { p, w } = await seed();
    auth.user = { ...auth.user!, adminRole: "suporte" };
    const html = renderToStaticMarkup(await page({ q: E2E }));
    expect(html).toContain("Histórico operacional");
    expect(html).not.toContain("/admin/busca/export");
    // /admin/saques/[id] abre com transacoes:ler (o suporte lê; as ações de saque pedem mais): o link aparece.
    expect(html).toContain(`/admin/saques/${p.id}`);
    expect(renderToStaticMarkup(await page({ q: "evt_ana_0001" }))).not.toContain(`/admin/webhooks/${w.id}`);

    auth.user = { ...auth.user!, adminRole: null };
    await expect(page({ q: E2E })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
