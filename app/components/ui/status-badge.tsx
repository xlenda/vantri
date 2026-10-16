import type { ReactNode } from "react";
import type { charges, medCases, merchants, payouts, webhookDeliveries } from "@/lib/db/schema";

const TONES = {
  ok: "bg-ok/10 text-ok ring-ok/25",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  bad: "bg-red-50 text-red-700 ring-red-200",
  info: "bg-brand/5 text-brand ring-brand/20",
  muted: "bg-bg text-muted ring-line",
} as const;
type Tone = keyof typeof TONES;

/** Selo genérico (ex.: "revisão manual"). Para status do banco, use StatusBadge. */
export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONES[tone]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

type StatusOf<T extends { $inferSelect: { status: string } }> = T["$inferSelect"]["status"];
type Labels<T extends { $inferSelect: { status: string } }> = Record<StatusOf<T>, [string, Tone]>;

// Mesmo texto ("pending") muda de sentido por entidade, por isso o rótulo depende de `kind`.
const STATUS = {
  merchant: {
    pending: ["Em análise", "warn"],
    active: ["Ativo", "ok"],
    suspended: ["Suspenso", "bad"],
    rejected: ["Recusado", "muted"],
  } satisfies Labels<typeof merchants>,
  charge: {
    pending: ["Aguardando pagamento", "warn"],
    paid: ["Paga", "ok"],
    expired: ["Expirada", "muted"],
  } satisfies Labels<typeof charges>,
  payout: {
    processing: ["Processando", "warn"],
    completed: ["Concluído", "ok"],
    failed: ["Falhou", "bad"],
  } satisfies Labels<typeof payouts>,
  med: {
    open: ["Aberto", "warn"],
    defended: ["Defesa enviada", "info"],
    merchant_won: ["Encerrado a favor do lojista", "ok"],
    payer_refunded: ["Devolvido ao pagador", "bad"],
  } satisfies Labels<typeof medCases>,
  delivery: {
    pending: ["Na fila", "warn"],
    delivered: ["Entregue", "ok"],
    failed: ["Falhou", "bad"],
  } satisfies Labels<typeof webhookDeliveries>,
};

export function StatusBadge<K extends keyof typeof STATUS>({
  kind,
  status,
}: {
  kind: K;
  status: keyof (typeof STATUS)[K];
}) {
  const [label, tone] = STATUS[kind][status] as [string, Tone];
  return <Badge tone={tone}>{label}</Badge>;
}
