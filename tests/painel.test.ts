import { describe, expect, it } from "vitest";
import { chargeInput, formInput, idInput, keyInput, payoutInput, webhookInput } from "@/app/painel/input";
import { csvCell, FAILURE_LABEL, failureReason, maskPixKey, phoneKey, rfc8187 } from "@/app/painel/lib";
import { attachmentsTooBig, MED_UPLOAD_MAX_BYTES } from "@/app/painel/med/limits";
import { parseReais } from "@/lib/br/money";
import { pixKeyProblem } from "@/lib/services/payouts";

it("rfc8187 escapa acento, espaço, aspas, ; e ' ( ) *", () => {
  expect(rfc8187(`comprovante d'água (1)*; "x".pdf`)).toBe("comprovante%20d%27%C3%A1gua%20%281%29%2A%3B%20%22x%22.pdf");
});

describe("phoneKey", () => {
  it.each([
    ["(11) 98765-4321", "+5511987654321"],
    ["11 3456-7890", "+551134567890"],
    ["+55 11 98765-4321", "+5511987654321"],
    ["5511987654321", "+5511987654321"],
    ["  123 ", "123"],
  ])("%s → %s", (a, b) => expect(phoneKey(a)).toBe(b));
});

describe("parseReais (texto pt-BR → centavos)", () => {
  it.each([
    ["1.234,56", 123456],
    ["1234,56", 123456],
    ["1234.56", 123456],
    ["R$ 10", 1000],
    ["r$10,5", 1050],
    ["  0,99 ", 99],
    ["1.234.567,00", 123456700],
    ["7", 700],
    ["12.3", 1230],
  ])("%s → %i", (txt, cents) => expect(parseReais(txt)).toBe(cents));

  it.each([
    "", "abc", "-10", "10,", ",50", "1,234", "1.234", "1,2,3", "1.23.4", "12,345", "1 234,56", "1e3", "10,5x",
    "1.2345,00", "Infinity", "9999999999",
  ])("recusa %j", (txt) => expect(parseReais(txt)).toBeNull());
});

describe("csvCell", () => {
  it("neutraliza fórmula com aspa simples", () => {
    for (const c of ["=1+1", "+5", "-2", "@SOMA(A1)", "\tx", "\rx"]) expect(csvCell(c).replace(/^"|"$/g, "")[0]).toBe("'");
  });
  it("põe entre aspas o que tem ; aspas ou quebra de linha", () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("\rx")).toBe(`"'\rx"`);
  });
  it("deixa o resto igual", () => expect(csvCell("12,34")).toBe("12,34"));
});

// Fix 1 da revisão: entrada de toda ação passa por zod estrito (lista branca) e a chave Pix é conferida antes do 2FA.
const form = (o: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
};
const errOf = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0].message;

describe("entrada das ações (lista branca + zod estrito)", () => {
  it("cobrança: converte e ignora campo fora da lista", () => {
    const r = formInput(chargeInput, form({ amount: "1.234,56", description: " Curso ", expiresIn: "3600", merchantId: "x" }));
    expect(r.success && r.data).toEqual({ amount: 123456, description: "Curso", expiresIn: 3600 });
  });
  it.each([
    [{ amount: "1.234", description: "", expiresIn: "3600" }, "Valor inválido"],
    [{ amount: "10", description: "", expiresIn: "999" }, "Escolha uma validade da lista."],
    [{ amount: "10", description: "a\u0000b", expiresIn: "3600" }, "A descrição tem caracteres inválidos."],
    [{ amount: "10", description: "x".repeat(141), expiresIn: "3600" }, "A descrição pode ter até 140 caracteres."],
  ])("cobrança recusa %j", (o, msg) => expect(errOf(formInput(chargeInput, form(o)))).toContain(msg));

  const PAYOUT = { idempotencyKey: "a".repeat(24), amount: "150,00", pixKeyType: "phone", pixKey: "(11) 98765-4321", description: "" };
  it("saque: celular normalizado, chave conferida", () => {
    const r = formInput(payoutInput, form(PAYOUT));
    expect(r.success && r.data).toMatchObject({ amount: 15000, pixKeyType: "phone", pixKey: "+5511987654321" });
  });
  it.each([
    [{ pixKeyType: "cpf", pixKey: "529.982.247-24" }, "Chave Pix inválida para CPF"],
    [{ pixKeyType: "email", pixKey: "sem-arroba" }, "Chave Pix inválida para E-mail"],
    [{ pixKeyType: "aleatoria" }, "Escolha o tipo da chave Pix."],
    [{ amount: "0,99" }, "O valor mínimo do saque é R$ 1,00."],
    [{ amount: "50.000,01" }, "O valor máximo por saque é R$ 50.000,00."],
    [{ idempotencyKey: "curta" }, "Formulário expirado"],
  ])("saque recusa %j", (o, msg) => expect(errOf(formInput(payoutInput, form({ ...PAYOUT, ...o })))).toContain(msg));

  it("chave de API: escopos da lista e IPs em lista", () => {
    const r = formInput(keyInput, form({ name: "Loja", scopes: ["charges:read", "balance:read"], ips: "1.2.3.4\n5.6.7.8, " }));
    expect(r.success && r.data).toEqual({ name: "Loja", scopes: ["charges:read", "balance:read"], ips: ["1.2.3.4", "5.6.7.8"] });
    expect(errOf(formInput(keyInput, form({ name: "Loja", scopes: ["admin:all"] })))).toBe("Escopo inválido.");
    expect(errOf(formInput(keyInput, form({ name: "Loja" })))).toBe("Escolha ao menos um escopo.");
  });
  it("webhook e id", () => {
    expect(errOf(formInput(webhookInput, form({ url: "https://a.com/h" })))).toBe("Escolha ao menos um evento.");
    expect(errOf(formInput(webhookInput, form({ url: "https://a.com/h", events: ["charge.paid", "x"] })))).toBe("Evento inválido.");
    expect(formInput(idInput, form({ id: "nao-e-uuid" })).success).toBe(false);
  });
});

it("pixKeyProblem (serviço de saque): formato por tipo", () => {
  expect(pixKeyProblem("cpf", "529.982.247-25")).toBeNull();
  expect(pixKeyProblem("phone", "+5511987654321")).toBeNull();
  expect(pixKeyProblem("phone", "11987654321")).toBe("Chave Pix inválida para o tipo phone.");
  expect(pixKeyProblem("evp", "not-a-uuid")).toBe("Chave Pix inválida para o tipo evp.");
});

it("FAILURE_LABEL: os 12 códigos de falha do cash-out em PT; desconhecido nunca sai cru", () => {
  const codes = [
    "pix_key_not_found", "pix_key_invalid", "pix_key_validation_failed", "recipient_bank_rejected",
    "recipient_account_invalid", "amount_not_allowed", "recipient_timeout", "returned_by_recipient",
    "temporarily_unavailable", "duplicate_request", "under_review", "processing_failed",
  ];
  expect(Object.keys(FAILURE_LABEL).sort()).toEqual([...codes].sort());
  expect(FAILURE_LABEL.pix_key_not_found).toBe("Chave Pix não encontrada");
  for (const c of codes) expect(failureReason(c)).toBe(FAILURE_LABEL[c]);
  for (const c of [null, "", "codigo_novo", "constructor", "__proto__"]) {
    expect(failureReason(c)).toBe("Não informado pelo banco");
  }
});

it("maskPixKey: nenhuma chave aparece inteira", () => {
  expect(maskPixKey("cpf", "52998224725")).toBe("***.982.247-**");
  expect(maskPixKey("cnpj", "11222333000181")).toBe("11.222.333/****-**");
  expect(maskPixKey("email", "falha@teste.com")).toBe("f•••@teste.com");
  expect(maskPixKey("phone", "+5511987654321")).toBe("+5511•••••21");
  expect(maskPixKey("evp", "123e4567-e89b-42d3-a456-426614174000")).toBe("123e4567…4000");
});

it("anexos do MED: 4 MB somados (menos folga do multipart)", () => {
  expect(MED_UPLOAD_MAX_BYTES).toBe(4 * 1024 * 1024 - 64 * 1024);
  expect(attachmentsTooBig([MED_UPLOAD_MAX_BYTES])).toBe(false);
  expect(attachmentsTooBig([MED_UPLOAD_MAX_BYTES - 10, 11])).toBe(true);
});
