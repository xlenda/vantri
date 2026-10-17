import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

// Os valores públicos (site.ts) são lidos ao carregar o módulo: cada teste importa de novo com o env dele.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const privacidade = async () => {
  vi.resetModules();
  const { default: Privacidade } = await import("@/app/(site)/privacidade/page");
  return renderToStaticMarkup(Privacidade());
};

it("privacidade: DPO vem do env; sem ele, pendência explícita (nunca um nome inventado)", async () => {
  vi.stubEnv("NEXT_PUBLIC_DPO_NAME", "");
  vi.stubEnv("NEXT_PUBLIC_DPO_EMAIL", "");
  const pending = await privacidade();
  expect(pending).toContain("<strong>Pendente:</strong> o nome e o e-mail do encarregado ainda não foram definidos");
  expect(pending).not.toContain("a definir antes de operar]");

  vi.stubEnv("NEXT_PUBLIC_DPO_NAME", "Fulana de Tal");
  expect(await privacidade()).toContain("Pendente:"); // só o nome não basta: a LGPD pede o contato também

  vi.stubEnv("NEXT_PUBLIC_DPO_EMAIL", "dpo@exemplo.com");
  const set = await privacidade();
  expect(set).toContain("O encarregado pelo tratamento de dados é Fulana de Tal");
  expect(set).toContain('<a href="mailto:dpo@exemplo.com">dpo@exemplo.com</a>');
  expect(set).not.toContain("Pendente:");
});

it("termos: anexos do MED com o limite do painel (4 MB somados por defesa)", async () => {
  const { default: Termos } = await import("@/app/(site)/termos/page");
  const html = renderToStaticMarkup(Termos());
  expect(html).toContain("de até 4 MB somados por defesa");
  expect(html).not.toContain("5 MB cada");
});

it("produção sem NEXT_PUBLIC_SITE_URL falha alto ao carregar (nunca cai em localhost)", async () => {
  const site = async () => {
    vi.resetModules();
    return import("@/app/(site)/site");
  };
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  expect((await site()).SITE_URL).toBe("http://localhost:3000"); // fora de produção, o padrão local serve
  vi.stubEnv("VERCEL_ENV", "production");
  await expect(site()).rejects.toThrow("NEXT_PUBLIC_SITE_URL não definida: obrigatória em produção (VERCEL_ENV=production).");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", " https://vantri.com.br/ ");
  expect((await site()).SITE_URL).toBe("https://vantri.com.br");
});
