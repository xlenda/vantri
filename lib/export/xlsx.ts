import ExcelJS from "exceljs";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Neutraliza injeção de fórmula em célula de texto: começo que planilha lê como fórmula (= + - @ tab CR)
 * ganha aspa simples na frente (mesma regra do `csvCell` em app/painel/lib.ts). Número vai intacto — some no Excel.
 */
const safeCell = (v: string | number): string | number =>
  typeof v === "number" ? v : /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;

/**
 * Monta uma planilha XLSX em memória e devolve o Buffer. Cabeçalho e textos protegidos contra injeção de fórmula;
 * números vão como número (o Excel soma). Nome do sheet aparado para ≤ 31 chars (limite do Excel).
 */
export async function buildXlsx(
  sheetName: string,
  header: string[],
  rows: Array<Array<string | number>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.addRow(header.map((h) => safeCell(h)));
  for (const row of rows) ws.addRow(row.map(safeCell));
  // writeBuffer() entrega um Buffer de Node em runtime; o .d.ts do exceljs o tipa com um Buffer próprio que não casa.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}
