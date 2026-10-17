import { csvCell, maskPixKey } from "@/app/painel/lib";

/** E-mail na tela: "a•••@dominio" (mesma regra da chave Pix de e-mail). Malformado vira "•••", nunca o cru. */
export const maskEmail = (email: string): string => maskPixKey("email", email);

/**
 * Resposta de exportação CSV neutra contra injeção (reusa csvCell): BOM, separador ";",
 * CRLF, anexo com Cache-Control no-store. O nome do arquivo deve vir de dados já validados.
 */
export function csvResponse(filename: string, header: string[], rows: string[][]): Response {
  const body = `﻿${[header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
