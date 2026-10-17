import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { payouts } from "@/lib/db/schema";
import { decodeReceiptId, publicReceipt, receiptCode, verifyReceiptCode } from "@/lib/services/receipt";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

/** Insere um saque e devolve a linha. `status` default "completed" (o que o comprovante exige). */
async function newPayout(over: Partial<typeof payouts.$inferInsert> = {}) {
  const merchantId = await newMerchant(d, Math.floor(Math.random() * 1e9));
  const [p] = await d
    .insert(payouts)
    .values({
      merchantId,
      amountCents: 10000,
      feeCents: 100,
      pixKey: "52998224725",
      pixKeyType: "cpf",
      status: "completed",
      endToEndId: "E12345678202601011200abcdef0001",
      completedAt: new Date("2026-01-01T12:00:00Z"),
      idempotencyKey: randomUUID(),
      requestHash: "hash",
      ...over,
    })
    .returning();
  return p;
}

it("receiptCode is deterministic and verifies", async () => {
  const p = await newPayout();
  const code = receiptCode(p.id);
  expect(receiptCode(p.id)).toBe(code); // determinístico
  expect(code).toMatch(/^[0-9a-f]{48}$/);
  expect(decodeReceiptId(code)).toBe(p.id); // URL se valida sozinha: o id sai do código
  expect(verifyReceiptCode(p.id, code)).toBe(true);
});

it("verifyReceiptCode rejects wrong code (timing-safe)", async () => {
  const p = await newPayout();
  const code = receiptCode(p.id);
  // HMAC adulterado (último hex trocado) falha.
  const tampered = code.slice(0, -1) + (code.at(-1) === "a" ? "b" : "a");
  expect(verifyReceiptCode(p.id, tampered)).toBe(false);
  // Código de outro saque (id diferente) não vale para este id.
  const other = await newPayout();
  expect(verifyReceiptCode(p.id, receiptCode(other.id))).toBe(false);
  // Lixo e formato errado não lançam.
  for (const bad of ["", "xyz", code.slice(0, 40), `${code}00`]) {
    expect(verifyReceiptCode(p.id, bad)).toBe(false);
  }
});

it("publicReceipt returns only non-personal fields", async () => {
  const p = await newPayout();
  const r = await publicReceipt(receiptCode(p.id), p.id);
  expect(r).toEqual({
    amountCents: 10000,
    status: "completed",
    endToEndId: "E12345678202601011200abcdef0001",
    completedAt: new Date("2026-01-01T12:00:00Z"),
  });
  // Sem nenhum dado pessoal do favorecido nem id interno.
  expect(Object.keys(r!).sort()).toEqual(["amountCents", "completedAt", "endToEndId", "status"]);
  for (const leak of ["pixKey", "pix_key", "pixKeyType", "merchantId", "id", "description"]) {
    expect(r).not.toHaveProperty(leak);
  }
});

it("publicReceipt null for wrong code, non-completed, or nonexistent payout", async () => {
  const p = await newPayout();
  expect(await publicReceipt("f".repeat(48), p.id)).toBeNull(); // código errado

  const processing = await newPayout({ status: "processing", endToEndId: null, completedAt: null });
  expect(await publicReceipt(receiptCode(processing.id), processing.id)).toBeNull(); // não completado

  const failed = await newPayout({ status: "failed", endToEndId: null, completedAt: null });
  expect(await publicReceipt(receiptCode(failed.id), failed.id)).toBeNull();

  // Código válido para um id que não existe no banco.
  const ghost = randomUUID();
  const r = await publicReceipt(receiptCode(ghost), ghost);
  expect(r).toBeNull();

  // Garantia: quando bate, não é null (não é um stub que sempre nega).
  expect(await publicReceipt(receiptCode(p.id), p.id)).not.toBeNull();
});
