import { and, desc, eq, gt, lte, or, type SQL, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { maskDocument } from "@/lib/br/documents";
import { randomBase62 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { charges, merchants } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { computeFee } from "@/lib/money/fees";
import { lockMerchant, postEntries } from "@/lib/money/ledger";
import { getProvider, SIMULATED_ACCOUNT_MESSAGE, simulatedAccountOutsideSimulator } from "@/lib/provider";
import type { ProviderEvent } from "@/lib/provider/types";
import { emit } from "@/lib/services/events";
import { parseOr } from "@/lib/validation";

export type ChargeRow = typeof charges.$inferSelect;

// merchant_inactive: lojista que não está `active`; simulated_account: conta do simulador com o parceiro real ligado
// (as duas: a API responde 403).
export type ChargeErrorCode =
  | "invalid_request"
  | "idempotency_conflict"
  | "not_found"
  | "provider_error"
  | "merchant_inactive"
  | "simulated_account";

export class ChargeError extends Error {
  constructor(
    public readonly code: ChargeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChargeError";
  }
}

const MIN_AMOUNT = 100;
const MAX_AMOUNT = 10_000_000;

const createSchema = z.strictObject({
  external_ref: z.string().min(1).max(64),
  amount: z.int(),
  description: z.string().max(140).optional(),
  expires_in: z.int().min(300).max(86_400).default(3600),
});

const listSchema = z.strictObject({
  status: z.enum(["pending", "paid", "expired"]).optional(),
  limit: z.int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

const parse = <T extends z.ZodType>(schema: T, input: unknown) =>
  parseOr(schema, input, (msg) => new ChargeError("invalid_request", msg));

const isUuid = (s: string) => z.uuid().safeParse(s).success;

/** JSON público da cobrança (API e webhooks). Webhook usa `withQr: false` e o campo some. */
export async function toChargeJson(c: ChargeRow, { withQr }: { withQr: boolean }) {
  return {
    id: c.id,
    txid: c.txid,
    external_ref: c.externalRef,
    amount: c.amountCents,
    fee: c.feeCents,
    net: c.amountCents - c.feeCents,
    description: c.description,
    status: c.status,
    brcode: c.brcode,
    ...(withQr && { qr_code_base64: (await QRCode.toBuffer(c.brcode)).toString("base64") }),
    expires_at: c.expiresAt.toISOString(),
    paid_at: c.paidAt?.toISOString() ?? null,
    payer:
      c.payerName === null && c.payerDocumentMasked === null
        ? null
        : { name: c.payerName, document_masked: c.payerDocumentMasked },
    end_to_end_id: c.endToEndId,
    created_at: c.createdAt.toISOString(),
  };
}

const findByRef = async (merchantId: string, externalRef: string) =>
  (
    await db()
      .select()
      .from(charges)
      .where(and(eq(charges.merchantId, merchantId), eq(charges.externalRef, externalRef)))
  )[0];

function replay(existing: ChargeRow, amount: number) {
  if (existing.amountCents !== amount) {
    throw new ChargeError("idempotency_conflict", "Já existe uma cobrança com este external_ref e outro valor.");
  }
  return { charge: existing, created: false };
}

export async function createCharge(
  merchantId: string,
  input: unknown,
): Promise<{ charge: ChargeRow; created: boolean }> {
  const data = parse(createSchema, input);
  if (data.amount < MIN_AMOUNT) throw new ChargeError("invalid_request", "O valor mínimo da cobrança é R$ 1,00.");
  if (data.amount > MAX_AMOUNT) {
    throw new ChargeError("invalid_request", "O valor máximo da cobrança é R$ 100.000,00.");
  }

  const [m] = isUuid(merchantId) ? await db().select().from(merchants).where(eq(merchants.id, merchantId)) : [];
  if (m?.status !== "active" || !m.providerAccountId) {
    throw new ChargeError("merchant_inactive", "Sua conta não está ativa para receber cobranças.");
  }
  if (simulatedAccountOutsideSimulator(m.providerAccountId)) {
    throw new ChargeError("simulated_account", SIMULATED_ACCOUNT_MESSAGE);
  }

  const existing = await findByRef(merchantId, data.external_ref);
  if (existing) return replay(existing, data.amount);

  const fee = computeFee(data.amount, m.feeInBps, m.feeInFixedCents);
  if (data.amount <= fee) throw new ChargeError("invalid_request", "O valor da cobrança precisa ser maior que a taxa.");

  const txid = randomBase62(25); // campo 62/05 do BR Code aceita no máximo 25
  let created: { providerChargeId: string; brcode: string };
  try {
    created = await getProvider().createCharge({
      providerAccountId: m.providerAccountId,
      amountCents: data.amount,
      txid,
      description: data.description,
      expiresInSec: data.expires_in,
    });
  } catch (cause) {
    throw new ChargeError("provider_error", "Não foi possível gerar a cobrança no parceiro de Pix. Tente novamente.", {
      cause,
    });
  }

  // Corrida: dois pedidos com o mesmo external_ref passam pela checagem acima juntos. O UNIQUE decide;
  // quem perde não grava e relê a do vencedor.
  // ponytail: a cobrança do perdedor fica órfã no provedor e só expira lá; inofensivo, ninguém recebe o brcode dela.
  const [row] = await db()
    .insert(charges)
    .values({
      merchantId,
      txid,
      externalRef: data.external_ref,
      amountCents: data.amount,
      feeCents: fee,
      description: data.description ?? null,
      status: "pending",
      brcode: created.brcode,
      providerChargeId: created.providerChargeId,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    })
    .onConflictDoNothing({ target: [charges.merchantId, charges.externalRef] })
    .returning();
  if (row) return { charge: row, created: true };
  return replay((await findByRef(merchantId, data.external_ref))!, data.amount);
}

/** Pendente vencida → `expired` + `charge.expired`, numa transação. */
// ponytail: tudo numa transação só, sem limite de linhas; fatiar em lotes se o cron começar a pegar milhares.
async function expire(now: Date, filter?: SQL): Promise<number> {
  return db().transaction(async (tx) => {
    const rows = await tx
      .update(charges)
      .set({ status: "expired" })
      .where(and(eq(charges.status, "pending"), lte(charges.expiresAt, now), filter))
      .returning();
    for (const r of rows) await emit(tx, r.merchantId, "charge.expired", await toChargeJson(r, { withQr: false }));
    return rows.length;
  });
}

export const expireDueCharges = (now = new Date()): Promise<number> => expire(now);

/** De outro lojista (ou id inválido) → null. */
export async function getCharge(merchantId: string, id: string): Promise<ChargeRow | null> {
  if (!isUuid(id)) return null;
  const find = async () =>
    (await db()
      .select()
      .from(charges)
      .where(and(eq(charges.id, id), eq(charges.merchantId, merchantId))))[0] ?? null;
  const c = await find();
  const now = new Date();
  if (c?.status !== "pending" || c.expiresAt > now) return c;
  await expire(now, eq(charges.id, id));
  return find(); // relê: pode ter sido paga no meio
}

/**
 * Filtro por status como a pessoa vê: pendente já vencida conta como `expired` (o cron ou o `getCharge` gravam a
 * mudança depois). Usado na lista do lojista e na do admin.
 */
export function chargeStatusWhere(status: ChargeRow["status"], now: Date): SQL | undefined {
  switch (status) {
    case "pending":
      return and(eq(charges.status, "pending"), gt(charges.expiresAt, now));
    case "expired":
      return or(eq(charges.status, "expired"), and(eq(charges.status, "pending"), lte(charges.expiresAt, now)));
    case "paid":
      return eq(charges.status, "paid");
  }
}

/** A linha como a pessoa vê em `now`: pendente já vencida sai como `expired` (mesma regra de `chargeStatusWhere`). */
export const chargeAsOf = (c: ChargeRow, now: Date): ChargeRow =>
  c.status === "pending" && c.expiresAt <= now ? { ...c, status: "expired" } : c;

/**
 * Mais nova primeiro. `cursor` = id da última da página anterior. Pendente já vencida sai como `expired`
 * (igual a `getCharge`), inclusive no filtro; quem grava a mudança é o cron ou o `getCharge`.
 */
export async function listCharges(
  merchantId: string,
  opts: { status?: ChargeRow["status"]; limit?: number; cursor?: string } = {},
): Promise<{ data: ChargeRow[]; nextCursor: string | null }> {
  const { status, limit, cursor } = parse(listSchema, opts);
  const now = new Date();
  const rows = await db()
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.merchantId, merchantId),
        status ? chargeStatusWhere(status, now) : undefined,
        // Compara no banco: created_at tem microssegundos, Date do JS só milissegundos.
        // Cursor de outro lojista não acha linha → página vazia.
        cursor
          ? sql`(${charges.createdAt}, ${charges.id}) < (select c.created_at, c.id from ${charges} c where c.id = ${cursor} and c.merchant_id = ${merchantId})`
          : undefined,
      ),
    )
    .orderBy(desc(charges.createdAt), desc(charges.id))
    .limit(limit + 1);
  const data = rows.slice(0, limit).map((c) => chargeAsOf(c, now));
  return { data, nextCursor: rows.length > limit ? data[data.length - 1].id : null };
}

const DUPLICATE = Symbol("duplicate");

/** Crédito único: `postEntries` repetido desfaz a transação inteira (nem o status nem o evento mudam). */
export async function applyChargePaid(
  e: Extract<ProviderEvent, { type: "charge.paid" }>,
): Promise<"credited" | "duplicate" | "unknown"> {
  const [c] = await db()
    .select({ id: charges.id, merchantId: charges.merchantId })
    .from(charges)
    .where(eq(charges.providerChargeId, e.providerChargeId));
  if (!c) return "unknown";
  try {
    return await db().transaction(async (tx) => {
      await lockMerchant(tx, c.merchantId);
      const [row] = await tx
        .update(charges)
        .set({
          status: "paid", // inclusive se estava expired: o dinheiro entrou
          paidAt: e.paidAt,
          endToEndId: e.endToEndId,
          payerName: e.payerName ?? null,
          payerDocumentMasked: e.payerDocument ? maskDocument(e.payerDocument) : null,
        })
        .where(eq(charges.id, c.id))
        .returning();
      const ref = { merchantId: c.merchantId, bucket: "available", refType: "charge", refId: c.id } as const;
      const posted = await postEntries(tx, [
        { ...ref, kind: "cash_in", amountCents: row.amountCents },
        { ...ref, kind: "fee_in", amountCents: -row.feeCents },
      ]);
      if (!posted) throw DUPLICATE;
      await emit(tx, c.merchantId, "charge.paid", await toChargeJson(row, { withQr: false }));
      return "credited" as const;
    });
  } catch (err) {
    if (err !== DUPLICATE) throw err;
    // Já paga, e o parceiro manda outro Pix (E2E diferente): não credita de novo, mas pode ser um segundo pagamento
    // da mesma cobrança, que alguém precisa conciliar. Só ids no log.
    const [cur] = await db().select({ endToEndId: charges.endToEndId }).from(charges).where(eq(charges.id, c.id));
    if (cur?.endToEndId && cur.endToEndId !== e.endToEndId) {
      logError(
        "cobrança: charge.paid de novo com outro endToEndId (possível segundo pagamento, conciliar)",
        new Error("e2e divergente"),
        { charge: c.id, endToEndId: e.endToEndId },
      );
    }
    return "duplicate";
  }
}
