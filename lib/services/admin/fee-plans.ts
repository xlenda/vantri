import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { feeHistory as feeHistoryTable, feePlans, users } from "@/lib/db/schema";
import { computeFee } from "@/lib/money/fees";
import { writeAudit } from "@/lib/services/admin/audit-util";
import { updateFees } from "@/lib/services/merchants";
import { parseOr } from "@/lib/validation";

// Planos de tarifa: modelo nomeado e reutilizável. Aplicar a um cliente passa por updateFees (mesma validação,
// auditoria e linha de vigência em fee_history). Plano nunca é apagado nem editado: só arquivado.

export type FeePlanRow = typeof feePlans.$inferSelect;

export class FeePlanError extends Error {
  constructor(
    public readonly code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "FeePlanError";
  }
}

const isUuid = (s: string) => z.uuid().safeParse(s).success;
const notFound = () => new FeePlanError("not_found", "Plano não encontrado ou arquivado.");

// Mesmos tetos de updateFees (bps 0–10000, centavos 0–100000): plano que passa aqui sempre aplica.
const bps = z.int().min(0).max(10_000);
const cents = z.int().min(0).max(100_000);
const planSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^\P{Cc}*$/u), // sem caractere de controle (o Postgres recusa NUL em text)
  feeInBps: bps,
  feeInFixedCents: cents,
  feeOutBps: bps,
  feeOutFixedCents: cents,
});

export async function createFeePlan(input: unknown, actorUserId: string): Promise<{ id: string }> {
  const data = parseOr(
    planSchema,
    input,
    () => new FeePlanError("invalid_request", "Confira o plano: nome com 2 a 60 caracteres e taxas dentro dos limites."),
  );
  return db().transaction(async (tx) => {
    const [p] = await tx.insert(feePlans).values(data).returning({ id: feePlans.id });
    await writeAudit(tx, actorUserId, "fee_plan.create", { planId: p.id, ...data });
    return p;
  });
}

/** Ativos e arquivados, por nome (a tela separa). */
export function listFeePlans(): Promise<FeePlanRow[]> {
  return db().select().from(feePlans).orderBy(asc(feePlans.name), asc(feePlans.createdAt));
}

/** Tira o plano da lista de atribuição. Quem já usa continua com as mesmas taxas (elas moram no cliente). */
export async function archiveFeePlan(planId: string, actorUserId: string): Promise<void> {
  if (!isUuid(planId)) throw notFound();
  await db().transaction(async (tx) => {
    const [p] = await tx
      .update(feePlans)
      .set({ archivedAt: new Date() })
      .where(and(eq(feePlans.id, planId), isNull(feePlans.archivedAt)))
      .returning({ id: feePlans.id });
    if (!p) throw notFound();
    await writeAudit(tx, actorUserId, "fee_plan.archive", { planId });
  });
}

/** Copia as 4 taxas do plano para o cliente via updateFees; o fee_history guarda de qual plano veio. */
export async function assignPlanToMerchant(merchantId: string, planId: string, actorUserId: string): Promise<void> {
  const [p] = isUuid(planId) ? await db().select().from(feePlans).where(eq(feePlans.id, planId)) : [];
  if (!p || p.archivedAt) throw notFound();
  // ponytail: arquivar no meio desta chamada não impede a aplicação; inofensivo, os valores do plano nunca mudam.
  const { feeInBps, feeInFixedCents, feeOutBps, feeOutFixedCents } = p;
  await updateFees(merchantId, { feeInBps, feeInFixedCents, feeOutBps, feeOutFixedCents }, actorUserId, { planId: p.id });
}

/** Vigências do cliente, da mais nova para a mais antiga, com o nome do plano (se veio de um) e o e-mail do autor. */
export async function feeHistory(merchantId: string) {
  if (!isUuid(merchantId)) return [];
  return db()
    .select({
      id: feeHistoryTable.id,
      effectiveFrom: feeHistoryTable.effectiveFrom,
      feeInBps: feeHistoryTable.feeInBps,
      feeInFixedCents: feeHistoryTable.feeInFixedCents,
      feeOutBps: feeHistoryTable.feeOutBps,
      feeOutFixedCents: feeHistoryTable.feeOutFixedCents,
      planId: feeHistoryTable.planId,
      planName: feePlans.name,
      actorEmail: users.email,
    })
    .from(feeHistoryTable)
    .leftJoin(feePlans, eq(feePlans.id, feeHistoryTable.planId))
    .leftJoin(users, eq(users.id, feeHistoryTable.actorUserId))
    .where(eq(feeHistoryTable.merchantId, merchantId))
    .orderBy(desc(feeHistoryTable.effectiveFrom), desc(feeHistoryTable.createdAt));
}

/** Quanto o lojista recebe de uma venda de `amountCents` (mesma conta da cobrança). Negativo: a venda não cobre a tarifa. */
export function simulateFee(amountCents: number, plan: { feeInBps: number; feeInFixedCents: number }): number {
  return amountCents - computeFee(amountCents, plan.feeInBps, plan.feeInFixedCents);
}
