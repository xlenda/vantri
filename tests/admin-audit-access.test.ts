import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as exportAccess } from "@/app/admin/acessos/export/route";
import AcessosPage from "@/app/admin/acessos/page";
import { GET as exportAudit } from "@/app/admin/auditoria/export/route";
import AuditoriaPage from "@/app/admin/auditoria/page";
import type { AdminRole, Perm } from "@/lib/auth/perms";
import { type Db, setDb } from "@/lib/db/client";
import { accessLogs, auditLog, users } from "@/lib/db/schema";
import {
  accessCsvRows,
  deleteAccessLogsOlderThan6Months,
  listAccess,
  parseAccessFilters,
} from "@/lib/services/admin/access";
import { auditCsvRows, listAudit, parseAuditFilters } from "@/lib/services/admin/audit";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// O requireAdmin de verdade (sessão + 2FA + papel) está coberto em auth.test.ts/perms.test.ts. Aqui o guarda simulado
// aplica a MESMA matriz (`pode`): o que se prova é que cada tela/rota pede a permissão certa.
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

// Campos internos que nenhuma tela/exportação pode levar.
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$segredo-do-hash";
const TOTP_ENC = "v1:segredo-totp:tag:ct";

let d: Db;
let admin: { id: string; email: string };

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  [admin] = await d
    .insert(users)
    .values({
      email: "ana@vantri.test",
      passwordHash: PASSWORD_HASH,
      role: "admin",
      adminRole: "admin",
      totpSecretEnc: TOTP_ENC,
      totpEnabled: true,
    })
    .returning({ id: users.id, email: users.email });
  auth.user = { id: admin.id, role: "admin", adminRole: "admin", email: admin.email };
});

async function otherAdmin(email = "beto@vantri.test") {
  const [u] = await d
    .insert(users)
    .values({ email, passwordHash: PASSWORD_HASH, role: "admin", adminRole: "operador" })
    .returning({ id: users.id });
  return u.id;
}

async function audit(action: string, meta: Record<string, unknown>, o: { actor?: string | null; at?: string } = {}) {
  const [r] = await d
    .insert(auditLog)
    .values({
      actorUserId: o.actor === undefined ? admin.id : o.actor,
      action,
      meta,
      ...(o.at && { createdAt: new Date(o.at) }),
    })
    .returning();
  return r;
}

const access = (userId: string | null, ip: string, event: (typeof accessLogs.$inferSelect)["event"], at: string) =>
  d.insert(accessLogs).values({ userId, ip, event, createdAt: new Date(at) });

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());
// .text() descartaria o BOM (spec do fetch): lemos os bytes.
const textOf = (b: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const req = (path: string) => new Request(`http://localhost${path}`);

describe("auditoria (audit_log)", () => {
  const ids = (r: Awaited<ReturnType<typeof listAudit>>) => r.rows.map((x) => x.log.id);

  it("filtra por ação, autor, cliente (meta.merchantId) e período de Brasília; mais novos primeiro; paginada", async () => {
    const m1 = await newMerchant(d, 1);
    const m2 = await newMerchant(d, 2);
    const beto = await otherAdmin();
    const a = await audit("merchant.approve", { merchantId: m1 }, { at: "2026-10-10T02:59:00Z" }); // 09/10 23:59 BRT
    const b = await audit("merchant.update_fees", { merchantId: m1, feeInBps: 199 }, { at: "2026-10-10T03:00:00Z" }); // 10/10 00:00
    const c = await audit("merchant.suspend", { merchantId: m2 }, { actor: beto, at: "2026-10-11T12:00:00Z" });
    const s = await audit("med.close", { merchantId: m2, outcome: "merchant_won" }, { actor: null, at: "2026-10-12T12:00:00Z" });

    const all = await listAudit({ page: 1 });
    expect(ids(all)).toEqual([s.id, c.id, b.id, a.id]);
    expect(all.rows.map((r) => r.actorEmail)).toEqual([null, "beto@vantri.test", "ana@vantri.test", "ana@vantri.test"]);
    expect(all.rows[1].merchant).toEqual({ id: m2, tradeName: "Loja 2" });
    expect(all.hasNext).toBe(false);

    expect(ids(await listAudit({ page: 1, action: "merchant.update_fees" }))).toEqual([b.id]);
    expect(ids(await listAudit({ page: 1, actorUserId: beto }))).toEqual([c.id]);
    expect(ids(await listAudit({ page: 1, merchantId: m1 }))).toEqual([b.id, a.id]);
    // `to` inclusivo, dia civil de Brasília
    expect(ids(await listAudit({ page: 1, from: "2026-10-10", to: "2026-10-11" }))).toEqual([c.id, b.id]);

    const p1 = await listAudit({ page: 1 }, 3);
    expect([ids(p1), p1.hasNext]).toEqual([[s.id, c.id, b.id], true]);
    const p2 = await listAudit({ page: 2 }, 3);
    expect([ids(p2), p2.hasNext]).toEqual([[a.id], false]);
  });

  it("filtro de cliente e de ação é parametrizado: aspas e curinga não quebram nem vazam", async () => {
    const m1 = await newMerchant(d, 1);
    await audit("merchant.approve", { merchantId: m1 });
    for (const term of ["' OR '1'='1", `${m1}' OR 'a'='a`, "%", "_", "\\", `${m1}%`]) {
      expect((await listAudit({ page: 1, merchantId: term })).rows).toEqual([]);
      expect((await listAudit({ page: 1, action: term })).rows).toEqual([]);
    }
    expect((await listAudit({ page: 1, merchantId: m1 })).rows).toHaveLength(1);
  });

  it("filtros da URL: lista branca; valor inválido vira sem filtro", () => {
    expect(
      parseAuditFilters({ quem: "x", acao: "DROP TABLE x", cliente: "1", de: "2026-02-30", ate: "ontem", pagina: "0", extra: "1" }),
    ).toEqual({ page: 1 });
    const id = "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b";
    expect(
      parseAuditFilters({ quem: id, acao: "merchant.approve", cliente: [id, "x"], de: "2026-10-01", ate: "2026-10-31", pagina: "3" }),
    ).toEqual({ actorUserId: id, action: "merchant.approve", merchantId: id, from: "2026-10-01", to: "2026-10-31", page: 3 });
  });

  it("CSV: todas as páginas do filtro, UTC e Brasília, autor (ou Sistema), ação em PT e meta como JSON; nada de segredo", async () => {
    const m1 = await newMerchant(d, 1);
    await audit("merchant.update_fees", { merchantId: m1, feeInBps: 199, feeInFixedCents: 0 }, { at: "2026-10-15T15:00:00Z" });
    await audit("med.close", { merchantId: m1, outcome: "merchant_won" }, { actor: null, at: "2026-10-16T15:00:00Z" });

    const { header, rows } = await auditCsvRows({ page: 2 }); // exportação ignora a página: leva tudo do filtro
    expect(header).toEqual(["Data/hora (UTC)", "Data/hora (Brasília)", "Autor", "Ação", "Descrição", "Cliente", "Detalhes"]);
    // jsonb reordena as chaves: o meta é conferido já lido de volta
    expect(rows.map((r) => [...r.slice(0, 6), JSON.parse(r[6])])).toEqual([
      ["2026-10-16T15:00:00.000Z", "16/10/2026, 12:00:00", "Sistema", "med.close", "MED encerrado", "Loja 1", { merchantId: m1, outcome: "merchant_won" }],
      [
        "2026-10-15T15:00:00.000Z",
        "15/10/2026, 12:00:00",
        "ana@vantri.test",
        "merchant.update_fees",
        "Taxas do cliente alteradas",
        "Loja 1",
        { merchantId: m1, feeInBps: 199, feeInFixedCents: 0 },
      ],
    ]);
    const flat = JSON.stringify({ header, rows }).toLowerCase();
    for (const leak of ["segredo", "argon2", "password", "secret", "totp"]) expect(flat).not.toContain(leak);
  });

  it("exportar auditoria: CSV neutro contra injeção, nome com o período e export.audit_log com o SHA-256 do arquivo", async () => {
    const evil = await otherAdmin("=hyperlink@vantri.test");
    await audit("merchant.approve", { merchantId: "x" }, { actor: evil, at: "2026-10-15T15:00:00Z" });

    const res = await exportAudit(req("/admin/auditoria/export?de=2026-10-01&ate=2026-10-31&pagina=9"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="auditoria_2026-10-01_a_2026-10-31.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = await bytesOf(res);
    const text = textOf(bytes);
    expect(text.startsWith("﻿Data/hora (UTC);Data/hora (Brasília);Autor;")).toBe(true);
    expect(text).toContain(";'=hyperlink@vantri.test;merchant.approve;");

    const logs = await d.select().from(auditLog).where(eq(auditLog.action, "export.audit_log"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorUserId: admin.id,
      meta: { from: "2026-10-01", to: "2026-10-31", sha256: sha256(bytes) },
    });
  });

  it("tela: rótulo em PT, autor, cliente, detalhe JSON só leitura, sem apagar; Exportar só com a permissão", async () => {
    const m1 = await newMerchant(d, 1);
    await audit("merchant.update_fees", { merchantId: m1, feeInBps: 199 });
    await audit("acao.nova_sem_rotulo", {});
    const page = async (sp: Record<string, string> = {}) =>
      renderToStaticMarkup(await AuditoriaPage({ searchParams: Promise.resolve(sp) }));

    const html = await page();
    expect(html).toContain("Taxas do cliente alteradas");
    expect(html).toContain("acao.nova_sem_rotulo"); // sem rótulo: mostra o código
    expect(html).toContain("ana@vantri.test");
    expect(html).toContain(`href="/admin/clientes/${m1}"`);
    expect(html).toContain("&quot;feeInBps&quot;: 199");
    expect(html).toContain('href="/admin/auditoria/export"');
    expect(html).not.toMatch(/apagar|excluir/i);
    // o filtro vai junto para a exportação
    expect(await page({ acao: "merchant.update_fees" })).toContain('href="/admin/auditoria/export?acao=merchant.update_fees"');

    auth.user = { ...auth.user!, adminRole: "suporte" }; // lê, mas não exporta
    const support = await page();
    expect(support).toContain("Taxas do cliente alteradas");
    expect(support).not.toContain("/admin/auditoria/export");

    auth.user = { ...auth.user!, adminRole: null };
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("registros de acesso (Marco Civil)", () => {
  it("filtra por e-mail (exato, sem caixa), usuário, IP e período; e-mail quando houver usuário", async () => {
    const beto = await otherAdmin();
    await access(admin.id, "10.0.0.1", "login", "2026-10-10T12:00:00Z");
    await access(beto, "10.0.0.2", "login_failed", "2026-10-11T12:00:00Z");
    await access(null, "10.0.0.1", "login_failed", "2026-10-12T12:00:00Z"); // e-mail que não existe

    const all = await listAccess({ page: 1 });
    expect(all.rows.map((r) => [r.email, r.ip, r.event])).toEqual([
      [null, "10.0.0.1", "login_failed"],
      ["beto@vantri.test", "10.0.0.2", "login_failed"],
      ["ana@vantri.test", "10.0.0.1", "login"],
    ]);
    expect(all.rows[2].createdAt).toEqual(new Date("2026-10-10T12:00:00Z"));

    const ips = async (f: Parameters<typeof listAccess>[0]) => (await listAccess(f)).rows.map((r) => r.ip);
    expect(await ips(parseAccessFilters({ email: " ANA@vantri.test " }))).toEqual(["10.0.0.1"]);
    expect(await ips({ page: 1, email: "ana@" })).toEqual([]); // exato: nada de curinga
    expect(await ips({ page: 1, email: "%" })).toEqual([]);
    expect(await ips({ page: 1, userId: beto })).toEqual(["10.0.0.2"]);
    expect(await ips({ page: 1, ip: "10.0.0.1" })).toEqual(["10.0.0.1", "10.0.0.1"]);
    expect(await ips({ page: 1, ip: "10.0.0.%" })).toEqual([]);
    expect(await ips({ page: 1, from: "2026-10-11", to: "2026-10-11" })).toEqual(["10.0.0.2"]);

    const p1 = await listAccess({ page: 1 }, 2);
    expect([p1.rows.length, p1.hasNext]).toEqual([2, true]);
  });

  it("filtros da URL: lista branca; valor inválido vira sem filtro", () => {
    const id = "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b";
    expect(parseAccessFilters({ email: "  Ana@Vantri.TEST ", ip: " 10.0.0.1 ", usuario: id, de: "2026-10-01", pagina: "2" })).toEqual({
      email: "ana@vantri.test",
      ip: "10.0.0.1",
      userId: id,
      from: "2026-10-01",
      page: 2,
    });
    expect(parseAccessFilters({ email: "", ip: "   ", usuario: "x", ate: "2026-13-01", pagina: "abc" })).toEqual({ page: 1 });
  });

  it("CSV: data em UTC e em Brasília, e-mail, IP e evento em PT; nada de segredo", async () => {
    await access(admin.id, "2001:db8::1", "login", "2026-10-15T02:30:00Z");
    await access(null, "10.0.0.9", "login_failed", "2026-10-15T03:30:00Z");
    const { header, rows } = await accessCsvRows({ page: 3 });
    expect(header).toEqual(["Data/hora (UTC)", "Data/hora (Brasília)", "E-mail", "IP", "Evento"]);
    expect(rows).toEqual([
      ["2026-10-15T03:30:00.000Z", "15/10/2026, 00:30:00", "", "10.0.0.9", "Login recusado"],
      ["2026-10-15T02:30:00.000Z", "14/10/2026, 23:30:00", "ana@vantri.test", "2001:db8::1", "Login"],
    ]);
    const flat = JSON.stringify({ header, rows }).toLowerCase();
    for (const leak of ["segredo", "argon2", "password", "secret", "totp"]) expect(flat).not.toContain(leak);
  });

  it("exportar acessos: CSV neutro contra injeção e export.access_logs com { from, to, sha256 } do arquivo", async () => {
    await access(admin.id, "=1+1", "login", "2026-10-15T15:00:00Z"); // x-forwarded-for vem de fora
    await access(admin.id, "10.0.0.3", "login", "2026-09-15T15:00:00Z"); // fora do período

    const res = await exportAccess(req("/admin/acessos/export?de=2026-10-01&ate=2026-10-31"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="acessos_2026-10-01_a_2026-10-31.csv"');
    const bytes = await bytesOf(res);
    expect(textOf(bytes)).toBe(
      "﻿Data/hora (UTC);Data/hora (Brasília);E-mail;IP;Evento\r\n" +
        "2026-10-15T15:00:00.000Z;15/10/2026, 12:00:00;ana@vantri.test;'=1+1;Login\r\n",
    );

    const logs = await d.select().from(auditLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorUserId: admin.id,
      action: "export.access_logs",
      meta: { from: "2026-10-01", to: "2026-10-31", sha256: sha256(bytes) },
    });
    // nenhum dado pessoal no meta (o filtro por e-mail/IP não vai para a auditoria)
    await exportAccess(req("/admin/acessos/export?email=ana%40vantri.test&ip=10.0.0.3"));
    const [, second] = await d.select().from(auditLog).orderBy(auditLog.createdAt, auditLog.id);
    expect(Object.keys(second.meta as object).sort()).toEqual(["from", "sha256", "to"]);
    expect(second.meta).toMatchObject({ from: null, to: null });
    expect(JSON.stringify(second.meta)).not.toMatch(/ana@|10\.0\.0\.3/);
  });

  it("suporte vê os acessos mas não exporta nada: a rota recusa no servidor e não grava auditoria", async () => {
    await access(admin.id, "10.0.0.1", "login", "2026-10-15T02:30:00Z");
    auth.user = { ...auth.user!, adminRole: "suporte" };
    await expect(exportAccess(req("/admin/acessos/export"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(exportAudit(req("/admin/auditoria/export"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await d.select().from(auditLog)).toHaveLength(0);

    const html = renderToStaticMarkup(await AcessosPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("2026-10-15T02:30:00.000Z");
    expect(html).toContain("14/10/2026, 23:30:00");
    expect(html).toContain("ana@vantri.test");
    expect(html).toContain("10.0.0.1");
    expect(html).toContain("Login");
    expect(html).not.toContain("/admin/acessos/export");

    auth.user = { ...auth.user!, adminRole: "admin" };
    const full = renderToStaticMarkup(await AcessosPage({ searchParams: Promise.resolve({ ip: "10.0.0.1" }) }));
    expect(full).toContain('href="/admin/acessos/export?ip=10.0.0.1"');

    auth.user = { ...auth.user!, adminRole: null };
    await expect(AcessosPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("limpeza de 6 meses (Marco Civil, art. 15): apaga só o que passou de 6 meses", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const monthsAgo = (n: number, deltaMs = 0) => {
      const x = new Date(now);
      x.setUTCMonth(x.getUTCMonth() - n);
      return new Date(x.getTime() + deltaMs).toISOString();
    };
    await access(admin.id, "5m", "login", monthsAgo(5));
    await access(admin.id, "7m", "login", monthsAgo(7));
    await access(admin.id, "6m-1min", "login", monthsAgo(6, 60_000)); // ainda dentro dos 6 meses
    await access(admin.id, "6m+1min", "login", monthsAgo(6, -60_000));

    expect(await deleteAccessLogsOlderThan6Months(now)).toBe(2);
    expect((await d.select().from(accessLogs)).map((r) => r.ip).sort()).toEqual(["5m", "6m-1min"]);
  });

  it("limpeza no fim do mês: 31/08 menos 6 meses é 28/02 (nunca apaga registro com menos de 6 meses)", async () => {
    // Conta de mês no JS (setUTCMonth) daria 03/03 e apagaria o de 01/03, que tem 5 meses e 30 dias.
    await access(admin.id, "01-03", "login", "2026-03-01T00:00:00Z");
    await access(admin.id, "27-02", "login", "2026-02-27T12:00:00Z");
    expect(await deleteAccessLogsOlderThan6Months(new Date("2026-08-31T12:00:00Z"))).toBe(1);
    expect((await d.select().from(accessLogs)).map((r) => r.ip)).toEqual(["01-03"]);
  });
});
