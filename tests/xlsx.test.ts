import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildXlsx, XLSX_MIME } from "@/lib/export/xlsx";

/** Reabre o Buffer com o próprio exceljs e devolve a primeira planilha. */
async function reopen(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  // load() aceita os bytes em runtime; o .d.ts do exceljs tipa o parâmetro com um Buffer próprio que não casa.
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0];
}

describe("buildXlsx", () => {
  it("prefixa com apóstrofo célula de texto que começa com = + - @ tab CR", async () => {
    const ws = await reopen(
      await buildXlsx("S", ["Col"], [["=1+1"], ["+1"], ["-1"], ["@x"], ["\tx"], ["\rx"]]),
    );
    expect(ws.getCell("A2").value).toBe("'=1+1");
    expect(ws.getCell("A3").value).toBe("'+1");
    expect(ws.getCell("A4").value).toBe("'-1");
    expect(ws.getCell("A5").value).toBe("'@x");
    expect(ws.getCell("A6").value).toBe("'\tx");
    // CR: o apóstrofo neutraliza; o XLSX normaliza \r para \n ao gravar, então só exigimos o prefixo.
    expect(String(ws.getCell("A7").value).startsWith("'")).toBe(true);
  });

  it("texto comum e cabeçalho perigoso", async () => {
    const ws = await reopen(await buildXlsx("S", ["=mau"], [["normal"]]));
    expect(ws.getCell("A1").value).toBe("'=mau"); // header também é texto protegido
    expect(ws.getCell("A2").value).toBe("normal");
  });

  it("número continua número (soma no Excel)", async () => {
    const ws = await reopen(await buildXlsx("S", ["Valor"], [[1234], [-50]]));
    expect(ws.getCell("A2").value).toBe(1234);
    expect(typeof ws.getCell("A2").value).toBe("number");
    expect(ws.getCell("A3").value).toBe(-50);
  });

  it("gera um zip válido (assinatura PK) e reabre com as mesmas linhas", async () => {
    const buf = await buildXlsx("Extrato", ["Data", "Entrada (R$)"], [["17/10/2026", 1000], ["18/10/2026", 2550]]);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
    const ws = await reopen(buf);
    expect([ws.getCell("A1").value, ws.getCell("B1").value]).toEqual(["Data", "Entrada (R$)"]);
    expect([ws.getCell("A2").value, ws.getCell("B2").value]).toEqual(["17/10/2026", 1000]);
    expect([ws.getCell("A3").value, ws.getCell("B3").value]).toEqual(["18/10/2026", 2550]);
  });

  it("nome do sheet aparado para 31 chars", async () => {
    const ws = await reopen(await buildXlsx("x".repeat(40), ["Col"], [["a"]]));
    expect(ws.name).toBe("x".repeat(31));
    expect(ws.name.length).toBe(31);
  });

  it("XLSX_MIME é o content-type oficial", () => {
    expect(XLSX_MIME).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});
