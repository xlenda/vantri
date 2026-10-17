import { dateTime } from "@/lib/br/money";
import { deadlineBucket } from "@/lib/services/admin/med-queue";
import type { MedCaseRow } from "@/lib/services/med";

const TONE = { red: "font-semibold text-red-700", amber: "font-semibold text-amber-800", ok: undefined } as const;

/** Prazo da defesa com a cor da fila (vermelho < 24 h ou vencido, âmbar < 72 h), calculada no servidor. */
export function Deadline({ c }: { c: Pick<MedCaseRow, "status" | "defenseDeadline"> }) {
  const now = Date.now();
  const bucket = deadlineBucket(c, now);
  const hint =
    bucket === "ok"
      ? null
      : c.defenseDeadline.getTime() <= now
        ? "Prazo vencido"
        : bucket === "red"
          ? "Vence em menos de 24 h"
          : "Vence em menos de 72 h";
  return (
    <span className={TONE[bucket]}>
      {dateTime(c.defenseDeadline)}
      {hint && <span className="block text-xs">{hint}</span>}
    </span>
  );
}

/** 0,025 → "2,5%". */
export const ratePct = (r: number) => `${(r * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
