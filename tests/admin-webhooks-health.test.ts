import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cronHealth, providerHealth } from "@/app/admin/saude/cron-health";
import SaudePage from "@/app/admin/saude/page";
import DeliveryPage from "@/app/admin/webhooks/[id]/page";
import { disableEndpointAction, resendFailedBatchAction, resendOneAction } from "@/app/admin/webhooks/actions";
import {
  deliveryDetail,
  disableEndpoint,
  endpointSuccessRates,
  listDeliveries,
  overallSuccessRates,
  parseDeliveryFilters,
  resendFailedBatch,
  resendOne,
} from "@/app/admin/webhooks/monitor";
import WebhooksPage from "@/app/admin/webhooks/page";
import { GET as tick } from "@/app/api/cron/tick/route";
import { encrypt, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import {
  accessLogs,
  auditLog,
  cronRuns,
  sessions,
  users,
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
} from "@/lib/db/schema";
import { WebhookError } from "@/lib/services/events";
import { dispatchDue } from "@/lib/webhooks/dispatch";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// requireAdmin de verdade (sessão no banco + matriz de papéis): só o cookie da requisição é simulado.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vantri_session" && jar.token ? { name, value: jar.token } : undefined),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// `after` real só existe dentro de uma requisição do Next; aqui guarda a tarefa para o teste conferir.
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void afterTasks.push(task),
}));

const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";
const UNKNOWN = "6c0b1d3e-9f1a-4f7e-8a9b-1c2d3e4f5a6b";

let d: Db;
let seq = 0;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  vi.stubEnv("PIX_PROVIDER", "simulator");
  vi.stubEnv("CRON_SECRET", "segredo-cron");
  afterTasks.length = 0;
  jar.token = undefined;
  d = await createTestDb();
  setDb(d);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Admin com sessão real (2FA feito) e o sub-papel dado; o cookie passa a ser o dele. Devolve o id. */
async function loginAs(adminRole: "admin" | "operador" | "suporte"): Promise<string> {
  const n = ++seq;
  const [u] = await d
    .insert(users)
    .values({ email: `${adminRole}${n}@vantri.test`, passwordHash: "x", role: "admin", adminRole, totpEnabled: true })
    .returning({ id: users.id });
  await d
    .insert(sessions)
    .values({ id: sha256Hex(`token-${n}`), userId: u.id, mfaPassed: true, expiresAt: new Date(Date.now() + 3_600_000) });
  jar.token = `token-${n}`;
  return u.id;
}

async function endpoint(merchantId: string, o: Partial<typeof webhookEndpoints.$inferInsert> = {}) {
  const [e] = await d
    .insert(webhookEndpoints)
    .values({
      merchantId,
      url: `https://loja${++seq}.example.com/webhook`,
      secretEnc: encrypt("whsec_teste"),
      events: ["charge.paid"],
      ...o,
    })
    .returning();
  return e;
}

/** Entrega fora da rodada do dispatcher (próxima tentativa amanhã), salvo quando o teste quer enviar. */
async function delivery(endpointId: string, o: Partial<typeof webhookDeliveries.$inferInsert> = {}) {
  const eventId = `evt_${++seq}`;
  const [r] = await d
    .insert(webhookDeliveries)
    .values({
      endpointId,
      eventId,
      eventType: "charge.paid",
      payload: { id: eventId, type: "charge.paid", data: { id: `ch_${seq}`, payer: { name: "Fulana Pagadora" } } },
      status: "pending",
      nextAttemptAt: new Date(Date.now() + 86_400_000),
      ...o,
    })
    .returning();
  return r;
}

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const audits = () => d.select().from(auditLog).orderBy(asc(auditLog.createdAt));
const row = async (id: string) => (await d.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)))[0];
const day = (s: string) => new Date(`${s}-03:00`);
const ids = (r: { rows: Array<{ delivery: { id: string } }> }) => r.rows.map((x) => x.delivery.id);

describe("monitor de webhooks (todos os lojistas)", () => {
  it("listDeliveries cruza lojistas e filtra por status, lojista, endpoint, evento e período", async () => {
    const [a, b] = [await newMerchant(d, 1), await newMerchant(d, 2)];
    const [ea, eb] = [await endpoint(a), await endpoint(b)];
    const a1 = await delivery(ea.id, { status: "failed", attempts: 7, createdAt: day("2026-10-01T10:00:00") });
    const a2 = await delivery(ea.id, { status: "delivered", attempts: 1, createdAt: day("2026-10-10T23:59:00") });
    const b1 = await delivery(eb.id, {
      status: "failed",
      attempts: 7,
      eventType: "payout.failed",
      createdAt: day("2026-10-10T08:00:00"),
    });
    const b2 = await delivery(eb.id, { createdAt: day("2026-10-11T00:00:00") });

    const all = await listDeliveries({ page: 1 });
    expect(ids(all)).toEqual([b2.id, a2.id, b1.id, a1.id]);
    expect(all.rows.map((r) => r.tradeName)).toEqual(["Loja 2", "Loja 1", "Loja 2", "Loja 1"]);
    expect(all.rows[0].url).toBe(eb.url);
    expect(all.hasNext).toBe(false);

    expect(ids(await listDeliveries({ page: 1, status: "failed" }))).toEqual([b1.id, a1.id]);
    expect(ids(await listDeliveries({ page: 1, merchantId: a }))).toEqual([a2.id, a1.id]);
    expect(ids(await listDeliveries({ page: 1, endpointId: eb.id, status: "failed" }))).toEqual([b1.id]);
    expect(ids(await listDeliveries({ page: 1, eventType: "payout.failed" }))).toEqual([b1.id]);
    // Dias de Brasília, `to` inclusivo.
    expect(ids(await listDeliveries({ page: 1, from: "2026-10-10", to: "2026-10-10" }))).toEqual([a2.id, b1.id]);

    const p1 = await listDeliveries({ page: 1 }, 3);
    expect([p1.rows.length, p1.hasNext]).toEqual([3, true]);
    expect(ids(await listDeliveries({ page: 2 }, 3))).toEqual([a1.id]);
  });

  it("filtros da URL: só a lista branca; valor inválido é ignorado", () => {
    expect(
      parseDeliveryFilters({
        cliente: "x",
        endpoint: "1",
        evento: "'; drop table x; --",
        status: "hack",
        de: "2026-13-01",
        ate: "ontem",
        pagina: "-1",
        extra: "1",
      }),
    ).toEqual({ page: 1 });
    expect(
      parseDeliveryFilters({
        cliente: UNKNOWN,
        endpoint: UNKNOWN,
        evento: "webhook.test",
        status: "failed",
        de: "2026-10-01",
        ate: "2026-10-02",
        pagina: ["3", "9"],
      }),
    ).toEqual({
      merchantId: UNKNOWN,
      endpointId: UNKNOWN,
      eventType: "webhook.test",
      status: "failed",
      from: "2026-10-01",
      to: "2026-10-02",
      page: 3,
    });
  });

  it("deliveryDetail traz o payload e as tentativas em ordem, com a categoria do erro e nunca a mensagem crua", async () => {
    const ep = await endpoint(await newMerchant(d, 1));
    const dl = await delivery(ep.id, { nextAttemptAt: new Date(Date.now() - 1000) });
    const t0 = new Date();
    const resolve = async () => [{ address: "93.184.216.34" }];
    const refused = async () => {
      const cause = Object.assign(new Error("connect ECONNREFUSED 10.9.8.7:443 segredo-interno"), { code: "ECONNREFUSED" });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    };
    await dispatchDue(50, t0, refused as typeof fetch, resolve);
    await dispatchDue(50, new Date(t0.getTime() + 61_000), (async () => new Response("ok")) as typeof fetch, resolve);

    const det = await deliveryDetail(dl.id);
    expect(det?.tradeName).toBe("Loja 1");
    expect(det?.delivery).toMatchObject({ id: dl.id, status: "delivered", attempts: 2, payload: dl.payload });
    expect(det?.attempts.map((x) => [x.n, x.statusCode, x.error])).toEqual([
      [1, null, "conexão recusada"],
      [2, 200, null],
    ]);
    expect(JSON.stringify(det)).not.toMatch(/ECONNREFUSED|10\.9\.8\.7|segredo-interno/);
    expect(await deliveryDetail(UNKNOWN)).toBeNull();
    expect(await deliveryDetail("não-é-uuid")).toBeNull();
  });

  it("taxa de sucesso por tentativa em 24 h e 7 d, por endpoint (o pior primeiro) e somando todos os lojistas", async () => {
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const [a, b] = [await newMerchant(d, 1), await newMerchant(d, 2)];
    const [e1, e2, e3] = [await endpoint(a), await endpoint(b), await endpoint(b)];
    const attempts = async (endpointId: string, list: Array<[hoursAgo: number, ok: boolean]>) => {
      const dl = await delivery(endpointId);
      await d.insert(webhookAttempts).values(
        list.map(([h, ok], i) => ({
          deliveryId: dl.id,
          n: i + 1,
          statusCode: ok ? 200 : 500,
          error: ok ? null : "resposta HTTP 500",
          createdAt: ago(h),
        })),
      );
    };
    await attempts(e1.id, [[1, true], [2, true], [3, true], [4, false], [72, false], [73, false], [74, false], [75, false]]);
    await attempts(e2.id, [[48, true]]);
    await attempts(e3.id, [[200, false]]); // fora dos 7 dias: não entra

    const rates = await endpointSuccessRates(undefined, now);
    expect(rates.map((r) => [r.endpointId, r.tradeName, r.url, r.rate24h, r.rate7d])).toEqual([
      [e1.id, "Loja 1", e1.url, 0.75, 3 / 8],
      [e2.id, "Loja 2", e2.url, null, 1],
    ]);
    expect((await endpointSuccessRates(b, now)).map((r) => r.endpointId)).toEqual([e2.id]);
    expect(await overallSuccessRates(now)).toEqual({ rate24h: 0.75, rate7d: 4 / 9, attempts24h: 4, attempts7d: 9 });
  });

  it("resendOne volta a entrega para a fila agora e audita com o autor", async () => {
    const actor = await loginAs("operador");
    const m = await newMerchant(d, 1);
    const ep = await endpoint(m);
    const dl = await delivery(ep.id, { status: "failed", attempts: 7 });
    const before = Date.now();
    await resendOne(dl.id, actor);
    const r = await row(dl.id);
    expect(r.status).toBe("pending");
    expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await audits()).toMatchObject([
      { actorUserId: actor, action: "webhook.resend", meta: { deliveryId: dl.id, endpointId: ep.id, merchantId: m } },
    ]);
    await expect(resendOne(UNKNOWN, actor)).rejects.toMatchObject({ code: "not_found" });
    await expect(resendOne("x", actor)).rejects.toBeInstanceOf(WebhookError);
  });

  it("resendOne não manda para endpoint desativado", async () => {
    const actor = await loginAs("admin");
    const ep = await endpoint(await newMerchant(d, 1), { active: false });
    const dl = await delivery(ep.id, { status: "failed", attempts: 7 });
    await expect(resendOne(dl.id, actor)).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/desativado/) });
    expect((await row(dl.id)).status).toBe("failed");
    expect(await audits()).toHaveLength(0);
  });

  it("resendFailedBatch: só as falhas do filtro (de endpoint ativo) voltam para a fila; o resto fica", async () => {
    const actor = await loginAs("admin");
    const [a, b] = [await newMerchant(d, 1), await newMerchant(d, 2)];
    const [ea, off, eb] = [await endpoint(a), await endpoint(a, { active: false }), await endpoint(b)];
    const fa1 = await delivery(ea.id, { status: "failed", attempts: 7 });
    const fa2 = await delivery(ea.id, { status: "failed", attempts: 7, eventType: "payout.failed" });
    const ok = await delivery(ea.id, { status: "delivered", attempts: 1 });
    const foff = await delivery(off.id, { status: "failed", attempts: 7 });
    const fb = await delivery(eb.id, { status: "failed", attempts: 7 });

    expect(await resendFailedBatch({ page: 1, merchantId: a, eventType: "payout.failed" }, actor)).toBe(1);
    expect([(await row(fa2.id)).status, (await row(fa1.id)).status]).toEqual(["pending", "failed"]);
    // O status do filtro não vale aqui: só o que falhou de vez volta.
    expect(await resendFailedBatch({ page: 1, merchantId: a, status: "delivered" }, actor)).toBe(1);
    expect((await row(fa1.id)).status).toBe("pending");
    expect((await row(ok.id)).status).toBe("delivered");
    expect((await row(foff.id)).status).toBe("failed"); // endpoint desativado não recebe
    expect((await row(fb.id)).status).toBe("failed"); // outro lojista, fora do filtro
    expect(await resendFailedBatch({ page: 1 }, actor)).toBe(1); // sem filtro: a fila inteira (sobrou a de b)
    expect((await row(fb.id)).status).toBe("pending");
    expect(await resendFailedBatch({ page: 1 }, actor)).toBe(0);

    expect((await audits()).map((x) => [x.actorUserId, x.action, x.meta])).toEqual([
      [actor, "webhook.resend_batch", { count: 1, merchantId: a, eventType: "payout.failed" }],
      [actor, "webhook.resend_batch", { count: 1, merchantId: a }],
      [actor, "webhook.resend_batch", { count: 1 }],
    ]);
  });

  it("disableEndpoint desliga o endpoint e audita; id desconhecido → not_found", async () => {
    const actor = await loginAs("admin");
    const m = await newMerchant(d, 1);
    const [ep, other] = [await endpoint(m), await endpoint(m)];
    await disableEndpoint(ep.id, actor);
    const active = async (id: string) => (await d.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)))[0].active;
    expect([await active(ep.id), await active(other.id)]).toEqual([false, true]);
    expect(await audits()).toMatchObject([
      { actorUserId: actor, action: "webhook.endpoint_disable", meta: { endpointId: ep.id, merchantId: m } },
    ]);
    await expect(disableEndpoint(UNKNOWN, actor)).rejects.toMatchObject({ code: "not_found" });
    await expect(disableEndpoint("x", actor)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("ações do monitor (papel conferido no servidor)", () => {
  async function scenario() {
    const ep = await endpoint(await newMerchant(d, 1));
    return { ep, dl: await delivery(ep.id, { status: "failed", attempts: 7 }) };
  }

  it("suporte não reenvia nem desativa, nem forjando o POST: 404 e nada muda", async () => {
    const { ep, dl } = await scenario();
    await loginAs("suporte");
    await expect(resendOneAction(undefined, form({ id: dl.id }))).rejects.toThrow(NOT_FOUND);
    await expect(resendFailedBatchAction(undefined, form({}))).rejects.toThrow(NOT_FOUND);
    await expect(disableEndpointAction(undefined, form({ id: ep.id }))).rejects.toThrow(NOT_FOUND);
    expect((await row(dl.id)).status).toBe("failed");
    expect((await d.select().from(webhookEndpoints))[0].active).toBe(true);
    expect(await audits()).toHaveLength(0);
    expect(afterTasks).toHaveLength(0);
  });

  it("sem sessão nada roda (vai para o login)", async () => {
    const { dl } = await scenario();
    await expect(resendOneAction(undefined, form({ id: dl.id }))).rejects.toThrow("NEXT_REDIRECT");
    expect((await row(dl.id)).status).toBe("failed");
  });

  it("operador reenvia uma, reenvia a fila em lote e desativa; o envio sai na hora (after)", async () => {
    const { ep, dl } = await scenario();
    const dl2 = await delivery(ep.id, { status: "failed", attempts: 7 });
    const actor = await loginAs("operador");

    expect(await resendOneAction(undefined, form({ id: dl.id }))).toEqual({ ok: "Entrega colocada na fila de novo." });
    expect((await row(dl.id)).status).toBe("pending");
    expect(afterTasks).toHaveLength(1);

    expect(await resendFailedBatchAction(undefined, form({ cliente: ep.merchantId, evento: "charge.paid" }))).toEqual({
      ok: "1 entrega voltou para a fila.",
    });
    expect((await row(dl2.id)).status).toBe("pending");
    expect(afterTasks).toHaveLength(2);
    expect(await resendFailedBatchAction(undefined, form({}))).toEqual({ ok: "Nenhuma entrega com falha neste filtro." });
    expect(afterTasks).toHaveLength(2);

    expect(await disableEndpointAction(undefined, form({ id: ep.id }))).toEqual({
      ok: "Endpoint desativado. Novos eventos não são mais enfileirados para ele.",
    });
    expect(await resendOneAction(undefined, form({ id: dl.id }))).toEqual({
      error: "O endpoint desta entrega está desativado. Reative-o antes de reenviar.",
    });
    expect(await resendOneAction(undefined, form({ id: "x" }))).toEqual({ error: "Pedido inválido." });
    expect((await audits()).map((a) => a.actorUserId)).toEqual([actor, actor, actor]);
  });
});

describe("telas", () => {
  it("monitor e detalhe abrem para o operador; suporte recebe 404", async () => {
    const ep = await endpoint(await newMerchant(d, 1));
    const dl = await delivery(ep.id, { status: "failed", attempts: 7, lastError: "tempo esgotado" });
    await d.insert(webhookAttempts).values({ deliveryId: dl.id, n: 1, latencyMs: 10_000, error: "tempo esgotado" });
    await loginAs("operador");

    const list = renderToStaticMarkup(await WebhooksPage({ searchParams: Promise.resolve({ status: "failed" }) }));
    for (const text of ["Loja 1", ep.url, "Reenviar todas as falhas deste filtro", `/admin/webhooks/${dl.id}`]) {
      expect(list).toContain(text);
    }
    const detail = renderToStaticMarkup(await DeliveryPage({ params: Promise.resolve({ id: dl.id }) }));
    for (const text of ["tempo esgotado", "Fulana Pagadora", "Reenviar", "Desativar endpoint"]) expect(detail).toContain(text);
    await expect(DeliveryPage({ params: Promise.resolve({ id: "x" }) })).rejects.toThrow(NOT_FOUND);

    await loginAs("suporte");
    await expect(WebhooksPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(NOT_FOUND);
    await expect(DeliveryPage({ params: Promise.resolve({ id: dl.id }) })).rejects.toThrow(NOT_FOUND);
  });

  it("saúde abre para o suporte: alerta de cron parado, provedor simulado e passos depois do tick", async () => {
    await loginAs("suporte");
    const before = renderToStaticMarkup(await SaudePage());
    expect(before).toContain("O cron ainda não rodou");
    expect(before).toContain("requer parceiro");
    await tick(new Request("http://localhost/api/cron/tick", { headers: { authorization: "Bearer segredo-cron" } }));
    const after = renderToStaticMarkup(await SaudePage());
    expect(after).not.toContain("O cron ainda não rodou");
    expect(after).not.toContain("não roda há");
    expect(after).toContain("Expirar cobranças vencidas");
    expect(after).toContain("Limpar registros de acesso");
  });
});

describe("saúde do cron", () => {
  const get = () =>
    tick(new Request("http://localhost/api/cron/tick", { headers: { authorization: "Bearer segredo-cron" } }));
  const STEPS = [
    "expired_charges",
    "settled_payouts",
    "webhooks",
    "deleted_rate_limits",
    "deleted_sessions",
    "deleted_webhook_deliveries",
    "deleted_access_logs",
    "deleted_cron_runs",
  ];

  it("o tick grava uma linha por passo (início, fim, resultado) e devolve o mesmo resultado", async () => {
    const before = Date.now();
    const body = await (await get()).json();
    expect(Object.keys(body)).toEqual([...STEPS, "errors"]);
    expect(body.errors).toEqual({});
    const runs = await d.select().from(cronRuns);
    expect(runs.map((r) => r.step).sort()).toEqual([...STEPS].sort());
    for (const r of runs) {
      expect(r.error).toBeNull();
      expect(r.result).toEqual(body[r.step]);
      expect(r.startedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(r.finishedAt!.getTime()).toBeGreaterThanOrEqual(r.startedAt.getTime());
    }
  });

  it("passo que falha grava só a categoria do erro; os outros seguem", async () => {
    vi.stubEnv("PIX_PROVIDER", ""); // pollProcessingPayouts lança em getProvider()
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await get()).json();
    expect(body.errors).toEqual({ settled_payouts: "falha ao consultar saques no provedor" });
    const runs = await d.select().from(cronRuns);
    expect(runs).toHaveLength(STEPS.length);
    expect(runs.filter((r) => r.error !== null)).toEqual([
      expect.objectContaining({ step: "settled_payouts", error: "falha ao consultar saques no provedor", result: null }),
    ]);
    expect(JSON.stringify(runs)).not.toContain("não configurado"); // a mensagem crua só vai (sem texto) para o log
  });

  it("gravar o histórico falhar não muda a resposta do tick", async () => {
    await d.execute(sql`create function boom() returns trigger language plpgsql as $$ begin raise exception 'falha forçada'; end $$`);
    await d.execute(sql`create trigger boom before insert on cron_runs for each row execute function boom()`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).errors).toEqual({});
    expect(err.mock.calls.flat().join(" ")).toContain("cron_runs");
  });

  it("cronHealth: última rodada de cada passo; parado quando passa de 5 min ou nunca rodou", async () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const min = (m: number) => new Date(now.getTime() - m * 60_000);
    expect(await cronHealth(now)).toEqual({ steps: [], stale: true });

    await d.insert(cronRuns).values([
      { step: "webhooks", startedAt: min(10), finishedAt: min(10), error: "falha ao enviar webhooks" },
      { step: "webhooks", startedAt: min(6), finishedAt: min(6), result: { delivered: 1, failed: 0 } },
      { step: "expired_charges", startedAt: min(6), finishedAt: min(6), result: 2, error: null },
    ]);
    const h = await cronHealth(now);
    expect(h.stale).toBe(true);
    expect(h.steps).toEqual([
      expect.objectContaining({ step: "expired_charges", lastAt: min(6), agoSec: 360, error: null, result: 2 }),
      expect.objectContaining({ step: "webhooks", lastAt: min(6), agoSec: 360, error: null }),
    ]);

    await d.insert(cronRuns).values({ step: "webhooks", startedAt: min(1), finishedAt: min(1), error: "falha ao enviar webhooks" });
    const fresh = await cronHealth(now);
    expect(fresh.stale).toBe(false);
    expect(fresh.steps.find((s) => s.step === "webhooks")).toMatchObject({ agoSec: 60, error: "falha ao enviar webhooks" });
    // Exatamente 5 min desde a última rodada ainda não é parado; 1 s depois, é.
    expect((await cronHealth(new Date(min(1).getTime() + 300_000))).stale).toBe(false);
    expect((await cronHealth(new Date(min(1).getTime() + 301_000))).stale).toBe(true);
  });

  it("providerHealth diz o provedor ativo e se é simulado", () => {
    expect(providerHealth()).toEqual({ provider: "simulator", simulated: true });
    vi.stubEnv("PIX_PROVIDER", "parceiro");
    expect(providerHealth()).toEqual({ provider: "parceiro", simulated: false });
    vi.stubEnv("PIX_PROVIDER", "");
    expect(providerHealth()).toEqual({ provider: "não configurado", simulated: false });
  });

  it("limpeza do Marco Civil: só registro de acesso com mais de 6 meses sai", async () => {
    await d.insert(accessLogs).values([
      { ip: "10.0.0.1", event: "login", createdAt: sql`now() - interval '6 months' - interval '1 day'` },
      { ip: "10.0.0.2", event: "login", createdAt: sql`now() - interval '6 months' + interval '1 day'` },
      { ip: "10.0.0.3", event: "api_call" },
    ]);
    expect(await (await get()).json()).toMatchObject({ deleted_access_logs: 1, errors: {} });
    expect((await d.select({ ip: accessLogs.ip }).from(accessLogs)).map((r) => r.ip).sort()).toEqual(["10.0.0.2", "10.0.0.3"]);
  });

  it("o histórico do cron guarda 7 dias", async () => {
    await d.insert(cronRuns).values([
      { step: "velha", startedAt: sql`now() - interval '7 days' - interval '1 minute'` },
      { step: "recente", startedAt: sql`now() - interval '7 days' + interval '1 minute'` },
    ]);
    expect(await (await get()).json()).toMatchObject({ deleted_cron_runs: 1, errors: {} });
    const steps = (await d.select({ step: cronRuns.step }).from(cronRuns)).map((r) => r.step);
    expect(steps).toContain("recente");
    expect(steps).not.toContain("velha");
  });
});
