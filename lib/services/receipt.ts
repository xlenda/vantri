import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { hmacHex } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { payouts } from "@/lib/db/schema";
import type { PayoutRow } from "@/lib/services/payouts";

/**
 * Comprovante de saque: código de autenticação + verificação pública sem dado pessoal.
 *
 * O código **embute o id** do saque (hex do UUID sem hifens) seguido de um HMAC curto
 * derivado da APP_ENCRYPTION_KEY. Assim a URL pública `/comprovante/<code>` se valida
 * sozinha: `decodeReceiptId` tira o id do próprio código, e um id adivinhado falha porque
 * não traz o HMAC certo. Não é IDOR: quem tem o comprovante tem o código; sem ele, nega.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 16 hex = 64 bits de HMAC: inviável adivinhar, e o código todo continua imprimível.
const MAC_LEN = 16;

function mac(payoutId: string): string {
  return hmacHex("receipt", payoutId).slice(0, MAC_LEN);
}

/** Código determinístico: 32 hex do id + 16 hex de HMAC. */
export function receiptCode(payoutId: string): string {
  return payoutId.replace(/-/g, "").toLowerCase() + mac(payoutId);
}

/** Reconstrói o UUID a partir do código (sem conferir o HMAC); null se o formato não bate. */
export function decodeReceiptId(code: string): string | null {
  if (!/^[0-9a-f]{48}$/i.test(code)) return null;
  const h = code.slice(0, 32).toLowerCase();
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return UUID.test(id) ? id : null;
}

/** Comparação timing-safe do código contra o id. Formato/id errado → false, sem lançar. */
export function verifyReceiptCode(payoutId: string, code: string): boolean {
  if (!UUID.test(payoutId)) return false;
  const expected = Buffer.from(receiptCode(payoutId));
  const got = Buffer.from(code.toLowerCase());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export type PublicReceipt = {
  amountCents: number;
  status: PayoutRow["status"];
  endToEndId: string | null;
  completedAt: Date | null;
};

/**
 * Verificação pública: confere o código contra o id embutido e devolve **só** valor, status,
 * E2E e data — nenhum dado pessoal do favorecido (nome/chave/documento = plano 2). `null` se o
 * código não bate ou o saque não existe/não está `completed`.
 */
export async function publicReceipt(code: string, payoutId: string): Promise<PublicReceipt | null> {
  if (!verifyReceiptCode(payoutId, code)) return null;
  const [p] = await db()
    .select({
      amountCents: payouts.amountCents,
      status: payouts.status,
      endToEndId: payouts.endToEndId,
      completedAt: payouts.completedAt,
    })
    .from(payouts)
    .where(eq(payouts.id, payoutId));
  if (!p || p.status !== "completed") return null;
  return p;
}
