import { and, asc, desc, eq, exists, ilike, or, sql } from "drizzle-orm";
import { maskEmail } from "@/app/admin/admin-lib";
import { reais } from "@/app/admin/format";
import { eventName } from "@/app/admin/webhooks/monitor";
import { dateTime } from "@/lib/br/money";
import { db } from "@/lib/db/client";
import { charges, merchants, payouts, users, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { chargeAsOf } from "@/lib/services/charges";

// Busca global "Localizar operação" do admin (/admin/busca). Quem chama já passou por
// requireAdmin({ perm: "transacoes:ler" }); o admin vê todos os lojistas (sem filtro de merchant).
// Tudo vai por parâmetro (eq / ILIKE com placeholder do Drizzle), nunca por string concatenada.
// Cada Hit é um RESUMO montado campo a campo: nada de request_hash, segredo cifrado, hash de senha, payload,
// brcode, chave Pix ou dado do pagador.

type Base = { id: string; merchantId: string; tradeName: string; createdAt: Date };
export type Hit =
  | (Base & { kind: "charge"; label: string; status: (typeof charges.$inferSelect)["status"]; amountCents: number })
  | (Base & { kind: "payout"; label: string; status: (typeof payouts.$inferSelect)["status"]; amountCents: number })
  | (Base & { kind: "webhook"; eventType: string; status: (typeof webhookDeliveries.$inferSelect)["status"] })
  | {
      kind: "merchant";
      id: string;
      tradeName: string;
      emailMasked: string | null;
      status: (typeof merchants.$inferSelect)["status"];
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Escapa os curingas do LIKE: "a%" procura o texto literal "a%", não "a" + qualquer coisa.
const likeContains = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Acha cobrança (id/txid/id no parceiro/referência/E2E), saque (id/id no parceiro/E2E/chave de idempotência),
 * entrega de webhook (id/id do evento) e lojista (id, nome fantasia ou razão social contendo o termo, e-mail de
 * usuário contendo o termo). Termo aparado, mínimo 2 caracteres; `limit` por tipo, entre 1 e 50; mais novos primeiro.
 */
export async function searchOperations(term: string, limit = 20): Promise<Hit[]> {
  const q = term.trim();
  if (q.length < 2) return [];
  const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  // Coluna uuid comparada com texto que não é uuid estoura no Postgres: só compara id quando tem cara de uuid.
  const isUuid = UUID.test(q);
  const like = likeContains(q);
  const now = new Date();

  // ponytail: E2E/referência/chave de idempotência só têm índice composto com merchant_id e os ILIKE '%…%' não usam
  // índice: sem lojista no filtro, cada busca varre charges/payouts/merchants. Índice próprio (ou pg_trgm) se crescer.
  const [chargeRows, payoutRows, webhookRows, merchantRows] = await Promise.all([
    db()
      .select({ charge: charges, tradeName: merchants.tradeName })
      .from(charges)
      .innerJoin(merchants, eq(merchants.id, charges.merchantId))
      .where(
        or(
          isUuid ? eq(charges.id, q) : undefined,
          eq(charges.txid, q),
          eq(charges.providerChargeId, q),
          eq(charges.externalRef, q),
          eq(charges.endToEndId, q),
        ),
      )
      .orderBy(desc(charges.createdAt), desc(charges.id))
      .limit(take),
    db()
      .select({
        id: payouts.id,
        merchantId: payouts.merchantId,
        tradeName: merchants.tradeName,
        description: payouts.description,
        status: payouts.status,
        amountCents: payouts.amountCents,
        createdAt: payouts.createdAt,
      })
      .from(payouts)
      .innerJoin(merchants, eq(merchants.id, payouts.merchantId))
      .where(
        or(
          isUuid ? eq(payouts.id, q) : undefined,
          eq(payouts.providerPayoutId, q),
          eq(payouts.endToEndId, q),
          eq(payouts.idempotencyKey, q),
        ),
      )
      .orderBy(desc(payouts.createdAt), desc(payouts.id))
      .limit(take),
    db()
      .select({
        id: webhookDeliveries.id,
        merchantId: merchants.id,
        tradeName: merchants.tradeName,
        eventType: webhookDeliveries.eventType,
        status: webhookDeliveries.status,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .innerJoin(merchants, eq(merchants.id, webhookEndpoints.merchantId))
      .where(or(isUuid ? eq(webhookDeliveries.id, q) : undefined, eq(webhookDeliveries.eventId, q)))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(take),
    db()
      .select({
        id: merchants.id,
        tradeName: merchants.tradeName,
        status: merchants.status,
        // E-mail do primeiro usuário do lojista (só sai mascarado).
        email: sql<string | null>`(${db()
          .select({ email: users.email })
          .from(users)
          .where(eq(users.merchantId, merchants.id))
          .orderBy(asc(users.createdAt), asc(users.id))
          .limit(1)})`,
      })
      .from(merchants)
      .where(
        or(
          isUuid ? eq(merchants.id, q) : undefined,
          ilike(merchants.tradeName, like),
          ilike(merchants.legalName, like),
          exists(
            db()
              .select({ one: sql`1` })
              .from(users)
              .where(and(eq(users.merchantId, merchants.id), ilike(users.email, like))),
          ),
        ),
      )
      .orderBy(desc(merchants.createdAt), desc(merchants.id))
      .limit(take),
  ]);

  return [
    ...merchantRows.map(
      (m): Hit => ({
        kind: "merchant",
        id: m.id,
        tradeName: m.tradeName,
        emailMasked: m.email === null ? null : maskEmail(m.email),
        status: m.status,
      }),
    ),
    ...chargeRows.map(({ charge, tradeName }): Hit => {
      const c = chargeAsOf(charge, now);
      return {
        kind: "charge",
        id: c.id,
        merchantId: c.merchantId,
        tradeName,
        label: c.description || `Ref. ${c.externalRef}`,
        status: c.status,
        amountCents: c.amountCents,
        createdAt: c.createdAt,
      };
    }),
    ...payoutRows.map(
      ({ description, ...p }): Hit => ({ kind: "payout", ...p, label: description || "Saque Pix" }),
    ),
    ...webhookRows.map((w): Hit => ({ kind: "webhook", ...w })),
  ];
}

const KIND_PT = { merchant: "Cliente", charge: "Cobrança", payout: "Saque", webhook: "Webhook" } as const;
// Mesmos rótulos do StatusBadge das telas.
const STATUS_PT: Record<Hit["kind"], Record<string, string>> = {
  merchant: { pending: "Em análise", active: "Ativo", suspended: "Suspenso", rejected: "Recusado" },
  charge: { pending: "Aguardando pagamento", paid: "Paga", expired: "Expirada" },
  payout: { processing: "Processando", completed: "Concluído", failed: "Falhou" },
  webhook: { pending: "Na fila", delivered: "Entregue", failed: "Falhou" },
};

/** "Exportar resumo": uma linha por hit, só o que a tela mostra. Células cruas: `csvResponse` neutraliza a injeção. */
export function searchCsvRows(hits: Hit[]): { header: string[]; rows: string[][] } {
  return {
    header: ["Tipo", "ID", "Cliente", "Descrição", "Status", "Valor (R$)", "Criado em"],
    rows: hits.map((h) => {
      const head = [KIND_PT[h.kind], h.id, h.tradeName];
      const status = STATUS_PT[h.kind][h.status] ?? h.status;
      switch (h.kind) {
        case "merchant":
          return [...head, h.emailMasked ?? "", status, "", ""];
        case "webhook":
          return [...head, eventName(h.eventType), status, "", dateTime(h.createdAt)];
        default:
          return [...head, h.label, status, reais(h.amountCents), dateTime(h.createdAt)];
      }
    }),
  };
}
