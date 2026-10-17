import { describe, expect, it } from "vitest";
import { csvCell, parseReais, phoneKey, rfc8187 } from "@/app/painel/lib";

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
