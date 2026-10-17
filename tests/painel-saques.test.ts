import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ComprovantePublicoPage from "@/app/comprovante/[codigo]/page";
import ComprovanteSaquePage from "@/app/painel/saques/[id]/comprovante/page";
import SaqueDetalhePage from "@/app/painel/saques/[id]/page";
import SaquesPage from "@/app/painel/saques/page";
import { brl, dateTime } from "@/lib/br/money";
import { encrypt, sha256Hex } from "@/lib/crypto";
import { type Db, setDb } from "@/lib/db/client";
import { merchants, payouts, sessions, users } from "@/lib/db/schema";
import { receiptCode } from "@/lib/services/receipt";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

// Guarda de verdade (requireUser → checkAccess no banco); só o cookie da requisição é simulado. notFound lança.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vantri_session" && jar.token ? { name, value: jar.token } : undefined),
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

const CPF = "52998224725";
const E2E = "E00000000AbCdEfGhIjKlMnOpQrStUvW";
let d: Db;
let lojaA: string;
let lojaB: string;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.PIX_PROVIDER = "simulator";
});

/** Lojista ativo com usuário de 2FA ligado e sessão aberta pelo `token`; devolve o id do lojista. */
async function loja(n: number, token: string): Promise<string> {
  const merchantId = await newMerchant(d, n);
  await d.update(merchants).set({ status: "active" }).where(eq(merchants.id, merchantId));
  const [u] = await d
    .insert(users)
    .values({
      email: `loja${n}@exemplo.com`,
      passwordHash: "x",
      role: "merchant",
      merchantId,
      totpSecretEnc: encrypt("JBSWY3DPEHPK3PXP"),
      totpEnabled: true,
    })
    .returning({ id: users.id });
  await d.insert(sessions).values({ id: sha256Hex(token), userId: u.id, mfaPassed: true, expiresAt: new Date(Date.now() + 3_600_000) });
  return merchantId;
}

async function saque(merchantId: string, over: Partial<typeof payouts.$inferInsert> = {}) {
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId,
      amountCents: 10000,
      feeCents: 100,
      pixKey: CPF,
      pixKeyType: "cpf",
      status: "completed",
      endToEndId: E2E,
      completedAt: new Date("2026-10-16T15:07:00Z"),
      idempotencyKey: randomUUID(),
      requestHash: "hash",
      ...over,
    })
    .returning();
  return p;
}
const falhou = { status: "failed", endToEndId: null, completedAt: null, failureCode: "pix_key_not_found" } as const;
const processando = { status: "processing", endToEndId: null, completedAt: null } as const;

const detalhe = async (id: string) => renderToStaticMarkup(await SaqueDetalhePage({ params: Promise.resolve({ id }) }));
const comprovante = async (id: string) => renderToStaticMarkup(await ComprovanteSaquePage({ params: Promise.resolve({ id }) }));
const publico = async (codigo: string) => renderToStaticMarkup(await ComprovantePublicoPage({ params: Promise.resolve({ codigo }) }));
const lista = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await SaquesPage({ searchParams: Promise.resolve(sp) }));

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
  lojaA = await loja(1, "tok-a");
  lojaB = await loja(2, "tok-b");
  jar.token = "tok-a";
});

describe("detalhe e comprovante do saque (painel)", () => {
  it("saque de outro lojista ou id malformado → 404, nunca o dado", async () => {
    const deB = await saque(lojaB);
    for (const id of [deB.id, "nao-e-uuid", randomUUID()]) {
      await expect(detalhe(id)).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(comprovante(id)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    jar.token = "tok-b";
    expect(await detalhe(deB.id)).toContain(brl(10000)); // o dono vê
  });

  it("detalhe: chave mascarada, motivo da falha em PT (sem o código cru) e comprovante só quando concluído", async () => {
    const ok = await saque(lojaA);
    const html = await detalhe(ok.id);
    expect(html).toContain("***.982.247-**");
    expect(html).not.toContain(CPF);
    expect(html).toContain(E2E);
    expect(html).toContain(`href="/painel/saques/${ok.id}/comprovante"`);
    expect(html).toContain('class="valor-sensivel"');

    const ruim = await detalhe((await saque(lojaA, { ...falhou, pixKey: "falha@teste.com", pixKeyType: "email" })).id);
    expect(ruim).toContain("Chave Pix não encontrada");
    expect(ruim).not.toContain("pix_key_not_found");
    expect(ruim).not.toContain("falha@teste.com");
    expect(ruim).not.toContain("/comprovante");
  });

  it("comprovante: código de autenticação + URL pública; não concluído mostra o porquê, sem código", async () => {
    const ok = await saque(lojaA);
    const html = await comprovante(ok.id);
    expect(html).toContain(receiptCode(ok.id));
    expect(html).toContain(`/comprovante/${receiptCode(ok.id)}`);
    expect(html).toContain("disponíveis com o parceiro de Pix (plano 2)");
    expect(html).toContain("@media print");
    expect(html).not.toContain(CPF);
    expect(html).not.toContain("***.982.247-**"); // nem mascarada: comprovante sem dado pessoal do favorecido

    const pend = await saque(lojaA, processando);
    const htmlPend = await comprovante(pend.id);
    expect(htmlPend).toContain("O comprovante fica disponível quando o saque for concluído.");
    expect(htmlPend).not.toContain(receiptCode(pend.id));

    const ruim = await comprovante((await saque(lojaA, falhou)).id);
    expect(ruim).toContain("Motivo: Chave Pix não encontrada.");
  });
});

describe("verificação pública /comprovante/[codigo]", () => {
  it("código válido: só valor, status, E2E e data — sem chave, lojista ou id", async () => {
    jar.token = undefined; // sem login
    const ok = await saque(lojaA);
    const html = await publico(receiptCode(ok.id));
    expect(html).toContain("Comprovante autêntico");
    expect(html).toContain(brl(10000));
    expect(html).toContain(E2E);
    expect(html).toContain(`${dateTime(ok.completedAt!)} (horário de Brasília)`);
    expect(html).toContain("Comprovante de demonstração"); // Pix simulado
    for (const leak of [CPF, "***.982.247-**", "Loja 1", ok.id, brl(100)]) expect(html).not.toContain(leak);
  });

  it("código adulterado, id cru, saque não concluído ou lixo → não encontrado", async () => {
    jar.token = undefined;
    const ok = await saque(lojaA);
    const code = receiptCode(ok.id);
    const pend = await saque(lojaA, processando);
    for (const c of [`${code.slice(0, -1)}${code.endsWith("a") ? "b" : "a"}`, ok.id, ok.id.replace(/-/g, ""), receiptCode(pend.id), "x"]) {
      const html = await publico(c);
      expect(html, c).toContain("Comprovante não encontrado");
      expect(html, c).not.toContain(brl(10000));
    }
  });
});

describe("lista de saques", () => {
  it("contadores do histórico inteiro (não da página), abas, busca e link para o detalhe", async () => {
    for (let i = 0; i < 21; i++) await saque(lojaA);
    const ruim = await saque(lojaA, falhou);
    await saque(lojaA, { ...processando, pixKey: "+5511987654321", pixKeyType: "phone" });
    await saque(lojaB); // outro lojista não conta

    const html = await lista();
    expect(html).toContain("Todos <span class=\"tabular-nums\">(23)</span>");
    expect(html).toContain("Concluídos <span class=\"tabular-nums\">(21)</span>");
    expect(html).toContain("Falhou <span class=\"tabular-nums\">(1)</span>");
    expect(html.match(/href="\/painel\/saques\/[0-9a-f-]{36}"/g)).toHaveLength(20); // página de 20, contagem de 23
    expect(html).toContain("Próxima página");
    expect(html).not.toContain(CPF);

    const soFalhas = await lista({ status: "failed" });
    expect(soFalhas.match(/href="\/painel\/saques\/[0-9a-f-]{36}"/g)).toEqual([`href="/painel/saques/${ruim.id}"`]);
    expect(soFalhas).toContain("Chave Pix não encontrada");
    expect(soFalhas).not.toContain("pix_key_not_found");

    const busca = await lista({ q: "(11) 98765-4321" });
    expect(busca).toContain("Todos <span class=\"tabular-nums\">(1)</span>");
    expect(busca).toContain("Em processamento <span class=\"tabular-nums\">(1)</span>");
    expect(busca).toContain("+5511•••••21");
  });

  it("aviso depois do envio: motivo da falha em PT; saque de outro lojista não vira aviso", async () => {
    const ruim = await saque(lojaA, falhou);
    const aviso = await lista({ feito: ruim.id });
    expect(aviso).toContain("Motivo: Chave Pix não encontrada. O valor e a tarifa voltaram para o seu saldo.");
    expect(aviso).not.toContain("pix_key_not_found");
    expect(await lista({ feito: (await saque(lojaB, falhou)).id })).not.toContain('role="alert"');
  });
});
