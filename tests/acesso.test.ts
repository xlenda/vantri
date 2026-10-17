import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { signupAction } from "@/app/cadastro/actions";
import { clientIp, totpCode } from "@/app/conta/acesso";
import { setDb } from "@/lib/db/client";
import { createTestDb } from "./helpers/db";

// Fora do Next não há requisição: os cabeçalhos vêm deste mapa; redirect lança como o de verdade.
const req = vi.hoisted(() => ({ headers: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => req.headers.get(k) ?? null }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
const signupMerchant = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/merchants", async (orig) => ({ ...(await orig<object>()), signupMerchant }));

beforeAll(async () => setDb(await createTestDb()));

afterEach(() => {
  req.headers.clear();
  signupMerchant.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("clientIp: 1º valor do x-forwarded-for, senão x-real-ip", async () => {
  req.headers.set("x-forwarded-for", " 203.0.113.7 , 10.0.0.1");
  req.headers.set("x-real-ip", "198.51.100.2");
  expect(await clientIp()).toBe("203.0.113.7");
  req.headers.set("x-forwarded-for", " , 10.0.0.1"); // 1º valor vazio não conta
  expect(await clientIp()).toBe("198.51.100.2");
  req.headers.delete("x-forwarded-for");
  expect(await clientIp()).toBe("198.51.100.2");
});

it("clientIp: sem IP é null em produção e 'local' fora dela; nunca string vazia", async () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(await clientIp()).toBeNull();
  req.headers.set("x-forwarded-for", " ,10.0.0.1");
  req.headers.set("x-real-ip", "  ");
  expect(await clientIp()).toBeNull();
  vi.stubEnv("NODE_ENV", "development");
  expect(await clientIp()).toBe("local");
});

it("totpCode aceita só 6 dígitos (espaços ignorados)", () => {
  const fd = (code: string) => {
    const f = new FormData();
    f.set("code", code);
    return f;
  };
  expect(totpCode(fd("123 456"))).toBe("123456");
  for (const bad of ["12345", "1234567", "12345a", ""]) expect(totpCode(fd(bad))).toBeNull();
  expect(totpCode(new FormData())).toBeNull();
});

const signupForm = (extra: Record<string, string> = {}) => {
  const fd = new FormData();
  const fields = {
    legalName: "Maria da Silva",
    tradeName: "Curso da Maria",
    documentType: "cpf",
    document: "529.982.247-25",
    segment: "cursos",
    email: "maria@example.com",
    password: "senha-forte-maria-1",
    passwordConfirm: "senha-forte-maria-1",
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

it("cadastro sem a declaração de não operar apostas é recusado no servidor", async () => {
  const r = await signupAction(undefined, signupForm());
  expect(r?.error).toBe("Para criar a conta, declare que não opera apostas nem jogos de azar.");
  expect(r?.values).toMatchObject({ email: "maria@example.com", noBetting: false });
  expect(r?.values).not.toHaveProperty("password");
  expect(signupMerchant).not.toHaveBeenCalled();
});

it("cadastro em produção sem IP é recusado com o erro genérico", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const r = await signupAction(undefined, signupForm({ noBetting: "sim" }));
  expect(r?.error).toBe("Não foi possível concluir agora. Tente de novo em instantes.");
  expect(signupMerchant).not.toHaveBeenCalled();
});

it("cadastro com a declaração manda ao serviço só os campos da lista branca", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); // Turnstile sem chave avisa uma vez
  req.headers.set("x-forwarded-for", "203.0.113.9");
  const fd = signupForm({ noBetting: "sim", status: "active", $ACTION_KEY: "x" });
  await expect(signupAction(undefined, fd)).rejects.toThrow("NEXT_REDIRECT /cadastro?enviado=1");
  expect(signupMerchant).toHaveBeenCalledWith({
    legalName: "Maria da Silva",
    tradeName: "Curso da Maria",
    documentType: "cpf",
    document: "529.982.247-25",
    segment: "cursos",
    email: "maria@example.com",
    password: "senha-forte-maria-1",
  });
});
