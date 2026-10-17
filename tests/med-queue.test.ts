import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ReactElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MedCasePage from "@/app/admin/med/[id]/page";
import { addMedNoteAction, closeMedAction, openTestMedAction } from "@/app/admin/med/actions";
import MedPage from "@/app/admin/med/page";
import { sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { auditLog, charges, medCases, medEvents, sessions, users } from "@/lib/db/schema";
import { simulator } from "@/lib/provider/simulator";
import { addMedNote, listMedByDeadline, medCaseDetail, medKpis } from "@/lib/services/admin/med-queue";
import { applyMedOpened, listMedEvents, MedError, submitDefense } from "@/lib/services/med";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Guarda de verdade (requireAdmin → checkAccess → pode): só o cookie da requisição é simulado.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vantri_session" && jar.token ? { name, value: jar.token } : undefined),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const H = 3_600_000;
const DAY = 24 * H;
const TEXT = "O cliente recebeu o produto, segue comprovante de entrega.";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const NO_CASE = "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b";

let d: Db;
let seq = 0;

beforeEach(async () => {
  vi.stubEnv("PIX_PROVIDER", "simulator");
  d = await createTestDb();
  setDb(d);
  jar.token = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
      expiresAt: new Date(Date.now() + H),
      paidAt: new Date(),
      ...o,
    })
    .returning();
  return c;
}

/** Caso direto no banco (cada um com a sua cobrança paga, salvo `ch`). */
async function medCase(merchantId: string, o: Partial<typeof medCases.$inferInsert> = {}, ch?: { id: string }) {
  const chargeId = (ch ?? (await charge(merchantId))).id;
  const [c] = await d
    .insert(medCases)
    .values({
      merchantId,
      chargeId,
      providerCaseId: `sim_med_${++seq}`,
      amountCents: 5000,
      reason: "Suspeita de fraude",
      status: "open",
      defenseDeadline: new Date(Date.now() + 7 * DAY),
      ...o,
    })
    .returning();
  return c;
}

async function adminUser(adminRole: "admin" | "operador" | "suporte") {
  const [u] = await d
    .insert(users)
    .values({ email: `${adminRole}-${++seq}@vantri.test`, passwordHash: "x", role: "admin", adminRole, totpEnabled: true })
    .returning({ id: users.id });
  return u.id;
}

/** Sessão de admin já com 2FA, no cookie simulado. */
async function signIn(adminRole: "admin" | "operador" | "suporte") {
  const id = await adminUser(adminRole);
  const token = randomBytes(16).toString("hex");
  await d.insert(sessions).values({ id: sha256Hex(token), userId: id, mfaPassed: true, expiresAt: new Date(Date.now() + H) });
  jar.token = token;
  return id;
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const digest = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { digest?: string }) => e.digest ?? String(e),
  );

// Renderiza também os componentes assíncronos (os cartões da lista buscam anexos).
async function html(el: ReactElement) {
  const { prelude } = await prerenderToNodeStream(el);
  const chunks: Buffer[] = [];
  for await (const c of prelude) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

/** Fila com prazos variados, abertos e encerrados, de um lojista ("Loja 1"). */
async function seedQueue() {
  const m = await newMerchant(d, 1);
  const at = (ms: number) => new Date(Date.now() + ms);
  const later = await medCase(m, { defenseDeadline: at(5 * DAY) });
  const soon = await medCase(m, { defenseDeadline: at(2 * H) });
  const defended = await medCase(m, { status: "defended", defenseDeadline: at(48 * H) });
  const late = await medCase(m, { defenseDeadline: at(-H) });
  // Encerrado nunca fica vermelho, mesmo com o prazo perto.
  const closedOld = await medCase(m, { status: "merchant_won", createdAt: at(-3 * DAY), closedAt: at(-2 * DAY), defenseDeadline: at(H) });
  const closedNew = await medCase(m, { status: "payer_refunded", createdAt: at(-DAY), closedAt: at(-H), defenseDeadline: at(H) });
  return { m, later, soon, defended, late, closedOld, closedNew };
}

describe("listMedByDeadline", () => {
  it("abertos por prazo (o mais urgente primeiro) com red/amber; encerrados depois, mais novos primeiro", async () => {
    const q = await seedQueue();
    const all = await listMedByDeadline({});
    expect(all.data.map((c) => [c.id, c.deadlineBucket])).toEqual([
      [q.late.id, "red"], // prazo já passou
      [q.soon.id, "red"], // < 24 h
      [q.defended.id, "amber"], // < 72 h (defesa ainda não foi ao parceiro)
      [q.later.id, "ok"],
      [q.closedNew.id, "ok"],
      [q.closedOld.id, "ok"],
    ]);
    expect(all.data.every((c) => c.tradeName === "Loja 1")).toBe(true);
    expect(all.nextCursor).toBeNull();

    const open = await listMedByDeadline({ onlyOpen: true });
    expect(open.data.map((c) => c.id)).toEqual([q.late.id, q.soon.id, q.defended.id, q.later.id]);
  });

  it("pagina pelo cursor, passando dos abertos para os encerrados", async () => {
    const q = await seedQueue();
    const ids = (r: { data: Array<{ id: string }> }) => r.data.map((c) => c.id);

    const p1 = await listMedByDeadline({ limit: 2 });
    expect(ids(p1)).toEqual([q.late.id, q.soon.id]);
    const p2 = await listMedByDeadline({ limit: 2, cursor: p1.nextCursor! });
    expect(ids(p2)).toEqual([q.defended.id, q.later.id]);
    expect(p2.nextCursor).toBe(q.later.id); // ainda há encerrados
    const p3 = await listMedByDeadline({ limit: 2, cursor: p2.nextCursor! });
    expect(ids(p3)).toEqual([q.closedNew.id, q.closedOld.id]);
    expect(p3.nextCursor).toBeNull();
    expect(ids(await listMedByDeadline({ limit: 1, cursor: q.closedNew.id }))).toEqual([q.closedOld.id]);

    // Só os abertos: a fila acaba no último aberto.
    const o2 = await listMedByDeadline({ limit: 2, onlyOpen: true, cursor: p1.nextCursor! });
    expect(ids(o2)).toEqual([q.defended.id, q.later.id]);
    expect(o2.nextCursor).toBeNull();

    // Cursor desconhecido ou inválido: página vazia.
    expect(await listMedByDeadline({ cursor: NO_CASE })).toEqual({ data: [], nextCursor: null });
    expect(await listMedByDeadline({ cursor: "nao-e-uuid" })).toEqual({ data: [], nextCursor: null });
  });
});

describe("medKpis", () => {
  it("em aberto, bloqueado, vencem hoje, prazo vencido, defesas a enviar e tempo médio até o desfecho", async () => {
    const now = Date.parse("2026-10-16T15:00:00Z"); // 12:00 em Brasília; o dia acaba às 03:00Z de 17/10
    const at = (ms: number) => new Date(now + ms);
    const m = await newMerchant(d, 1);
    await medCase(m, { amountCents: 1000, defenseDeadline: at(2 * H) }); // vence hoje
    await medCase(m, { status: "defended", amountCents: 2000, defenseDeadline: at(20 * H) }); // amanhã; defesa a enviar
    const sent = await medCase(m, { status: "defended", amountCents: 3000, defenseDeadline: at(5 * DAY) });
    await d.insert(medEvents).values({ medCaseId: sent.id, type: "defense_sent", source: "admin" }); // já foi ao parceiro
    await medCase(m, { amountCents: 4000, defenseDeadline: at(-H) }); // prazo vencido
    await medCase(m, { status: "merchant_won", amountCents: 5000, createdAt: at(-10 * H), closedAt: at(-4 * H) }); // 6 h
    await medCase(m, { status: "payer_refunded", amountCents: 6000, createdAt: at(-30 * H), closedAt: at(-6 * H) }); // 24 h
    await medCase(m, { status: "payer_refunded", amountCents: 7000, createdAt: at(-40 * DAY), closedAt: at(-35 * DAY) }); // fora dos 30 dias

    expect(await medKpis(now)).toEqual({
      open: 4,
      blockedCents: 10000,
      dueToday: 1,
      overdue: 1,
      defensePendingSend: 1,
      avgResolutionMs: 15 * H,
    });
  });

  it("banco vazio: zeros e sem tempo médio", async () => {
    expect(await medKpis()).toEqual({
      open: 0,
      blockedCents: 0,
      dueToday: 0,
      overdue: 0,
      defensePendingSend: 0,
      avgResolutionMs: null,
    });
  });
});

describe("medCaseDetail", () => {
  it("cobrança de origem, linha do tempo em ordem com a origem, anexos e taxa de MED do lojista (30 dias)", async () => {
    const m = await newMerchant(d, 1);
    const ch = await charge(m, { amountCents: 14990 });
    const e = simulator.simulateMed(ch.providerChargeId, 5000);
    expect(await applyMedOpened(e)).toBe("opened");
    const [c] = await d.select().from(medCases).where(eq(medCases.providerCaseId, e.providerCaseId));
    await submitDefense(m, c.id, TEXT, [{ name: "comprovante.pdf", bytes: PDF }]);
    await addMedNote(c.id, await adminUser("operador"), "  Lojista mandou o rastreio por e-mail.  ");
    // Taxa: 1 MED nos 30 dias ÷ 4 cobranças pagas nos 30 dias. A cobrança paga há 40 dias e o MED antigo não contam.
    await charge(m);
    await charge(m);
    await charge(m);
    const old = await charge(m, { paidAt: new Date(Date.now() - 40 * DAY) });
    await medCase(m, { status: "merchant_won", createdAt: new Date(Date.now() - 40 * DAY), closedAt: new Date() }, old);

    const det = await medCaseDetail(c.id);
    expect(det).toMatchObject({
      case: { id: c.id, amountCents: 5000, status: "defended", defenseText: TEXT },
      tradeName: "Loja 1",
      charge: { id: ch.id, amountCents: 14990, status: "paid" },
      merchantMedRate: 0.25,
    });
    expect(det!.events.map((x) => `${x.type}:${x.source}`)).toEqual([
      "opened:provider",
      "funds_blocked:provider",
      "defense_submitted:merchant",
      "note:admin",
    ]);
    expect(det!.events[3].meta).toEqual({ note: "Lojista mandou o rastreio por e-mail." });
    expect(det!.files.map((f) => f.filename)).toEqual(["comprovante.pdf"]);

    expect(await medCaseDetail(NO_CASE)).toBeNull();
    expect(await medCaseDetail("nao-e-uuid")).toBeNull();
  });
});

describe("addMedNote", () => {
  it("grava a anotação na linha do tempo e a auditoria só com ids; o lojista não vê anotação interna", async () => {
    const m = await newMerchant(d, 1);
    const c = await medCase(m);
    const op = await adminUser("operador");
    await addMedNote(c.id, op, "Ligar para o lojista amanhã");

    expect(await d.select().from(medEvents).where(eq(medEvents.medCaseId, c.id))).toMatchObject([
      { type: "note", source: "admin", meta: { note: "Ligar para o lojista amanhã" } },
    ]);
    expect(
      await d.select({ actorUserId: auditLog.actorUserId, action: auditLog.action, meta: auditLog.meta }).from(auditLog),
    ).toEqual([{ actorUserId: op, action: "med.note", meta: { merchantId: m, medCaseId: c.id } }]);
    expect(await listMedEvents(c.id, { role: "merchant", merchantId: m })).toEqual([]);
    expect((await listMedEvents(c.id, { role: "admin" })).map((e) => e.type)).toEqual(["note"]);
  });

  it("recusa anotação vazia, longa demais ou com NUL e caso inexistente, sem gravar nada", async () => {
    const c = await medCase(await newMerchant(d, 1));
    const admin = await adminUser("admin");
    for (const bad of ["", "   ", "x".repeat(2001), "a\u0000b"]) {
      await expect(addMedNote(c.id, admin, bad)).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(addMedNote(NO_CASE, admin, "ok")).rejects.toMatchObject({ code: "not_found" });
    await expect(addMedNote("nao-e-uuid", admin, "ok")).rejects.toBeInstanceOf(MedError);
    expect(await d.$count(medEvents)).toBe(0);
    expect(await d.$count(auditLog)).toBe(0);
  });
});

describe("ações de MED com o papel conferido no servidor", () => {
  it("suporte forjando o POST não anota, não abre nem encerra MED (404) e nada é gravado", async () => {
    const m = await newMerchant(d, 1);
    const ch = await charge(m);
    const c = await medCase(m, {}, ch);
    await signIn("suporte");
    const notFound = /^NEXT_HTTP_ERROR_FALLBACK;404/;
    expect(await digest(addMedNoteAction(undefined, form({ caseId: c.id, note: "forjado" })))).toMatch(notFound);
    expect(await digest(openTestMedAction(undefined, form({ chargeId: ch.id, amount: "1,00" })))).toMatch(notFound);
    expect(await digest(closeMedAction(undefined, form({ caseId: c.id, outcome: "merchant_won" })))).toMatch(notFound);
    expect(await d.$count(medEvents)).toBe(0);
    expect(await d.$count(auditLog)).toBe(0);
    expect((await d.select().from(medCases)).map((x) => x.status)).toEqual(["open"]);
  });

  it("operador anota pela ação: evento e auditoria com o autor da sessão; erro em PT", async () => {
    const c = await medCase(await newMerchant(d, 1));
    const op = await signIn("operador");
    expect(await addMedNoteAction(undefined, form({ caseId: c.id, note: "Pedir a nota fiscal" }))).toEqual({
      ok: "Anotação salva.",
    });
    expect(await addMedNoteAction(undefined, form({ caseId: c.id, note: "   " }))).toEqual({
      error: "A anotação precisa ter entre 1 e 2000 caracteres.",
    });
    expect(await addMedNoteAction(undefined, form({ caseId: "x", note: "a" }))).toEqual({ error: "Pedido inválido." });
    expect(await d.select({ actorUserId: auditLog.actorUserId, action: auditLog.action }).from(auditLog)).toEqual([
      { actorUserId: op, action: "med.note" },
    ]);
  });

  it("MED de teste aberto e encerrado pelo admin: a linha do tempo marca 'admin' e a auditoria tem o autor", async () => {
    const ch = await charge(await newMerchant(d, 1));
    const admin = await signIn("admin");
    expect(await openTestMedAction(undefined, form({ chargeId: ch.id, amount: "30,00" }))).toMatchObject({
      ok: expect.any(String),
    });
    const [c] = await d.select().from(medCases);
    expect(await closeMedAction(undefined, form({ caseId: c.id, outcome: "merchant_won" }))).toEqual({
      ok: "MED encerrado a favor do lojista.",
    });
    expect((await listMedEvents(c.id, { role: "admin" })).map((e) => `${e.type}:${e.source}`)).toEqual([
      "opened:admin",
      "funds_blocked:admin",
      "closed_merchant_won:admin",
    ]);
    expect(await d.select({ actorUserId: auditLog.actorUserId, action: auditLog.action }).from(auditLog)).toEqual([
      { actorUserId: admin, action: "med.open_test" },
      { actorUserId: admin, action: "med.close" },
    ]);
  });
});

describe("telas", () => {
  it("lista: KPIs no topo e a fila por prazo com a cor do prazo; quem só lê não vê abrir/encerrar", async () => {
    const m = await newMerchant(d, 1);
    const soon = await medCase(m, { defenseDeadline: new Date(Date.now() + 2 * H) });
    const later = await medCase(m, { defenseDeadline: new Date(Date.now() + 5 * DAY) }); // mais novo
    const page = async (sp: Record<string, string>) => html(await MedPage({ searchParams: Promise.resolve(sp) }));

    await signIn("operador");
    const op = await page({ ordem: "prazo" });
    for (const s of ["Em aberto", "Bloqueado", "Vencem hoje", "Prazo vencido", "Defesas a enviar", "Tempo médio até o desfecho"]) {
      expect(op).toContain(s);
    }
    expect(op.indexOf(`/admin/med/${soon.id}`)).toBeGreaterThan(-1);
    expect(op.indexOf(`/admin/med/${soon.id}`)).toBeLessThan(op.indexOf(`/admin/med/${later.id}`));
    expect(op).toContain("Vence em menos de 24 h");
    expect(op).toContain("Taxa de MED (30 dias)");
    expect(op).toContain("Abrir MED de teste");
    expect(op).toContain("Encerrar MED");
    // Sem a ordem por prazo, o mais novo vem primeiro (como antes).
    const recent = await page({});
    expect(recent.indexOf(`/admin/med/${later.id}`)).toBeLessThan(recent.indexOf(`/admin/med/${soon.id}`));

    await signIn("suporte");
    const ro = await page({ ordem: "prazo" });
    expect(ro).toContain("Vence em menos de 24 h");
    expect(ro).not.toContain("Abrir MED de teste");
    expect(ro).not.toContain("Encerrar MED");
  });

  it("detalhe: rótulo em PT por evento, origem de cada um, 'requer parceiro' e anotação só para quem opera", async () => {
    const m = await newMerchant(d, 1);
    const ch = await charge(m);
    const e = simulator.simulateMed(ch.providerChargeId, 5000);
    await applyMedOpened(e);
    const [c] = await d.select().from(medCases);
    await submitDefense(m, c.id, TEXT, []);
    const page = async (id: string) => html(await MedCasePage({ params: Promise.resolve({ id }) }));

    await signIn("operador");
    const op = await page(c.id);
    for (const s of [
      "MED aberto",
      "Valor bloqueado no saldo",
      "Defesa enviada pelo lojista",
      "Parceiro",
      "Lojista",
      "Enviar defesa ao parceiro",
      "requer parceiro",
      'name="note"',
      "Taxa de MED (30 dias)",
    ]) {
      expect(op).toContain(s);
    }

    await signIn("suporte");
    const ro = await page(c.id);
    expect(ro).toContain("Valor bloqueado no saldo");
    expect(ro).not.toContain('name="note"');

    expect(await digest(page(NO_CASE))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});
