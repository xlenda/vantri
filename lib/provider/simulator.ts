import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { buildBrCode } from "@/lib/br/brcode";
import type { PixProvider, ProviderEvent } from "./types";

// Simulador: mesmo contrato do parceiro real; os eventos que ele gera seguem o mesmo caminho de um webhook.
const SIM_PIX_KEY = "00000000-0000-4000-8000-000000000000";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MED_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

type PayoutResult = Awaited<ReturnType<PixProvider["getPayout"]>>;

// ponytail: memória do processo; em serverless outra instância não acha o saque e getPayout lança. Basta para o simulador.
const payouts = new Map<string, PayoutResult>();

const newId = (prefix: string) => prefix + randomUUID().replaceAll("-", "");
const newEndToEndId = () => "E00000000" + Array.from({ length: 23 }, () => ALNUM[randomInt(ALNUM.length)]).join("");

const id = z.string().min(1);
// z.coerce.date aceitaria null e 0 como 1970: só data ISO em UTC.
const isoDate = z.iso.datetime().transform((s) => new Date(s));
const webhookBody = z.strictObject({
  events: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("charge.paid"),
        providerChargeId: id,
        paidAt: isoDate,
        endToEndId: id,
        payerName: z.string().optional(),
        payerDocument: z.string().optional(),
      }),
      z.strictObject({ type: z.literal("payout.completed"), providerPayoutId: id, endToEndId: id }),
      z.strictObject({ type: z.literal("payout.failed"), providerPayoutId: id, failureCode: id }),
      z.strictObject({
        type: z.literal("med.opened"),
        providerChargeId: id,
        providerCaseId: id,
        amountCents: z.number().int().positive(),
        reason: z.string(),
        deadline: isoDate,
      }),
      z.strictObject({
        type: z.literal("med.closed"),
        providerCaseId: id,
        outcome: z.enum(["merchant_won", "payer_refunded"]),
      }),
    ]),
  ),
});

/** Segredo ausente, vazio ou errado: a rota responde 401 (qualquer outro erro do parse vira 400). */
export class WebhookAuthError extends Error {}

function secretOk(got: string | null): boolean {
  const expected = process.env.SIMULATOR_WEBHOOK_SECRET;
  if (!expected || got === null) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const provider = {
  name: "simulator",

  async createAccount() {
    return { providerAccountId: newId("sim_acc_") };
  },

  async createCharge(i) {
    return {
      providerChargeId: newId("sim_ch_"),
      brcode: buildBrCode({
        pixKey: SIM_PIX_KEY,
        amountCents: i.amountCents,
        merchantName: "VANTRI SIMULADOR",
        merchantCity: "SAO PAULO",
        txid: i.txid,
      }),
    };
  },

  async createPayout(i) {
    const providerPayoutId = newId("sim_po_");
    const r: PayoutResult =
      i.pixKey.toLowerCase() === "falha@teste.com"
        ? { status: "failed", failureCode: "pix_key_not_found" }
        : { status: "completed", endToEndId: newEndToEndId() };
    payouts.set(providerPayoutId, r);
    return { providerPayoutId, ...r };
  },

  async getPayout(providerPayoutId) {
    const r = payouts.get(providerPayoutId);
    if (!r) throw new Error(`saque ${providerPayoutId} não encontrado no simulador`);
    return r;
  },

  async parseWebhook(req) {
    if (!secretOk(req.headers.get("x-simulator-secret"))) throw new WebhookAuthError("segredo do webhook do simulador inválido");
    let json: unknown;
    try {
      json = JSON.parse(req.rawBody);
    } catch {
      throw new Error("corpo do webhook do simulador inválido");
    }
    const r = webhookBody.safeParse(json);
    if (!r.success) throw new Error("corpo do webhook do simulador inválido");
    return r.data.events;
  },
} satisfies PixProvider;

export const simulator = {
  ...provider,

  // Fora da interface: só o painel/admin chamam, quando PIX_PROVIDER=simulator.
  simulatePaid(providerChargeId: string): Extract<ProviderEvent, { type: "charge.paid" }> {
    return {
      type: "charge.paid",
      providerChargeId,
      paidAt: new Date(),
      endToEndId: newEndToEndId(),
      payerName: "Pagador Simulado",
      payerDocument: "52998224725",
    };
  },

  simulateMed(providerChargeId: string, amountCents: number): Extract<ProviderEvent, { type: "med.opened" }> {
    return {
      type: "med.opened",
      providerChargeId,
      providerCaseId: newId("sim_med_"),
      amountCents,
      reason: "Suspeita de fraude (simulação)",
      deadline: new Date(Date.now() + MED_DEADLINE_MS),
    };
  },
};
