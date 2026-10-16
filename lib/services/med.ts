import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { charges, medCases, medFiles } from "@/lib/db/schema";
import { lockMerchant, postEntries } from "@/lib/money/ledger";
import type { ProviderEvent } from "@/lib/provider/types";
import { emit } from "@/lib/services/events";

export type MedCaseRow = typeof medCases.$inferSelect;
type MedStatus = MedCaseRow["status"];
type MedOpened = Extract<ProviderEvent, { type: "med.opened" }>;
type MedClosed = Extract<ProviderEvent, { type: "med.closed" }>;

export type MedErrorCode = "invalid_request" | "invalid_file" | "not_found" | "deadline_passed" | "invalid_status";

export class MedError extends Error {
  constructor(
    public readonly code: MedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MedError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new MedError("not_found", "Caso de MED não encontrado.");

/** JSON público do caso (API e webhooks): exatamente estes campos. */
export function toMedCaseJson(c: MedCaseRow) {
  return {
    id: c.id,
    charge_id: c.chargeId,
    amount: c.amountCents,
    reason: c.reason,
    status: c.status,
    defense_deadline: c.defenseDeadline.toISOString(),
    created_at: c.createdAt.toISOString(),
    closed_at: c.closedAt ? c.closedAt.toISOString() : null,
  };
}

// Sentinela: o razão já tinha parte do lote → desfaz a transação inteira e trata como repetido.
const DUPLICATE = new Error("lançamento de MED já existia");

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T | "duplicate"> {
  try {
    return await db().transaction(fn);
  } catch (err) {
    if (err === DUPLICATE) return "duplicate";
    throw err;
  }
}

async function post(
  tx: Tx,
  c: MedCaseRow,
  kind: "med_hold" | "med_release" | "med_debit",
  moves: Array<["available" | "blocked", number]>,
) {
  const entries = moves.map(([bucket, amountCents]) => ({
    merchantId: c.merchantId,
    amountCents,
    bucket,
    kind,
    refType: "med_case" as const,
    refId: c.id,
  }));
  if (!(await postEntries(tx, entries))) {
    // Não deveria acontecer (caso novo / transição guardada): razão divergente, merece investigação.
    console.error(`[med] ${kind} já lançado em parte para o caso ${c.id}; transação desfeita`);
    throw DUPLICATE;
  }
}

/** Abre o caso e bloqueia o valor. O disponível pode ficar negativo (lojista já sacou): não limita. */
export async function applyMedOpened(e: MedOpened): Promise<"opened" | "duplicate" | "unknown"> {
  if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) {
    throw new MedError("invalid_request", "Valor do MED inválido.");
  }
  return inTx(async (tx) => {
    const [ch] = await tx
      .select({ id: charges.id, merchantId: charges.merchantId })
      .from(charges)
      .where(eq(charges.providerChargeId, e.providerChargeId));
    if (!ch) return "unknown";
    await lockMerchant(tx, ch.merchantId);
    const [c] = await tx
      .insert(medCases)
      .values({
        merchantId: ch.merchantId,
        chargeId: ch.id,
        providerCaseId: e.providerCaseId,
        amountCents: e.amountCents,
        reason: e.reason,
        status: "open",
        defenseDeadline: e.deadline,
      })
      .onConflictDoNothing({ target: medCases.providerCaseId })
      .returning();
    if (!c) return "duplicate";
    await post(tx, c, "med_hold", [
      ["available", -c.amountCents],
      ["blocked", c.amountCents],
    ]);
    await emit(tx, c.merchantId, "med.opened", toMedCaseJson(c));
    return "opened";
  });
}

/** Encerra só a partir de `open`/`defended`; evento repetido ou tardio é ignorado. */
export async function applyMedClosed(e: MedClosed): Promise<"closed" | "duplicate" | "unknown"> {
  if (e.outcome !== "merchant_won" && e.outcome !== "payer_refunded") {
    throw new MedError("invalid_request", "Desfecho do MED inválido.");
  }
  return inTx(async (tx) => {
    const [found] = await tx
      .select({ id: medCases.id, merchantId: medCases.merchantId })
      .from(medCases)
      .where(eq(medCases.providerCaseId, e.providerCaseId));
    if (!found) return "unknown";
    await lockMerchant(tx, found.merchantId);
    const [c] = await tx
      .update(medCases)
      .set({ status: e.outcome, closedAt: new Date() })
      .where(and(eq(medCases.id, found.id), inArray(medCases.status, ["open", "defended"])))
      .returning();
    if (!c) return "duplicate";
    const x = c.amountCents;
    if (e.outcome === "merchant_won") {
      await post(tx, c, "med_release", [
        ["available", x],
        ["blocked", -x],
      ]);
    } else {
      await post(tx, c, "med_debit", [["blocked", -x]]);
    }
    await emit(tx, c.merchantId, "med.closed", toMedCaseJson(c));
    return "closed";
  });
}

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_NAME = 120;

// O tipo vem só do conteúdo; nome e mime do cliente são ignorados.
const SIGNATURES = [
  { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46], ext: /\.pdf$/i, add: ".pdf" },
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47], ext: /\.png$/i, add: ".png" },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff], ext: /\.jpe?g$/i, add: ".jpg" },
] as const;
type Signature = (typeof SIGNATURES)[number];

/** Só o nome-base, sem caracteres de controle/formatação, com a extensão do tipo real, até 120 caracteres. */
function safeName(raw: string, sig: Signature): string {
  const base = (String(raw ?? "").split(/[\\/]/).pop() ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const m = base.match(sig.ext);
  const ext = m ? m[0] : sig.add;
  const stem = (m ? base.slice(0, m.index) : base).slice(0, MAX_NAME - ext.length).replace(/[\uD800-\uDBFF]$/, "");
  return (stem.trim() || "anexo") + ext;
}

export async function submitDefense(
  merchantId: string,
  caseId: string,
  text: string,
  files: Array<{ name: string; bytes: Uint8Array }>,
): Promise<void> {
  const defense = typeof text === "string" ? text.trim() : "";
  if (defense.length < 20 || defense.length > 5000) {
    throw new MedError("invalid_request", "A defesa precisa ter entre 20 e 5000 caracteres.");
  }
  // Postgres recusa NUL em text: viraria erro 500.
  if (defense.includes("\u0000")) throw new MedError("invalid_request", "A defesa contém caracteres inválidos.");
  if (!Array.isArray(files) || files.length > MAX_FILES) {
    throw new MedError("invalid_file", `Envie no máximo ${MAX_FILES} arquivos.`);
  }
  const rows = files.map((f, i) => {
    const bytes = f?.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
      throw new MedError("invalid_file", `Arquivo ${i + 1}: precisa ter entre 1 byte e 5 MB.`);
    }
    const sig = SIGNATURES.find((s) => s.magic.every((b, j) => bytes[j] === b));
    if (!sig) throw new MedError("invalid_file", `Arquivo ${i + 1}: só aceitamos PDF, PNG ou JPEG.`);
    return { filename: safeName(f.name, sig), mime: sig.mime, sizeBytes: bytes.length, data: bytes };
  });
  if (!UUID.test(caseId)) throw notFound();

  await db().transaction(async (tx) => {
    const own = and(eq(medCases.id, caseId), eq(medCases.merchantId, merchantId));
    const [ok] = await tx
      .update(medCases)
      .set({ status: "defended", defenseText: defense })
      .where(and(own, eq(medCases.status, "open"), gt(medCases.defenseDeadline, new Date())))
      .returning({ id: medCases.id });
    if (!ok) {
      const [c] = await tx.select({ status: medCases.status }).from(medCases).where(own);
      if (!c) throw notFound();
      if (c.status !== "open") throw new MedError("invalid_status", "Este caso não aceita mais defesa.");
      throw new MedError("deadline_passed", "O prazo para enviar a defesa acabou.");
    }
    if (rows.length) await tx.insert(medFiles).values(rows.map((r) => ({ ...r, medCaseId: caseId })));
  });
}

/**
 * `merchantId` null = admin (todos os lojistas). Mais recentes primeiro;
 * `cursor` = id do último item da página anterior.
 */
export async function listMedCases(
  merchantId: string | null,
  opts: { status?: MedStatus; limit?: number; cursor?: string } = {},
): Promise<MedCaseRow[]> {
  const { status, cursor } = opts;
  const limit = Number.isInteger(opts.limit) ? Math.min(Math.max(1, opts.limit!), 100) : 50;
  if (cursor !== undefined && !UUID.test(cursor)) throw new MedError("invalid_request", "Cursor inválido.");
  return db()
    .select()
    .from(medCases)
    .where(
      and(
        merchantId === null ? undefined : eq(medCases.merchantId, merchantId),
        status ? eq(medCases.status, status) : undefined,
        cursor
          ? sql`(${medCases.createdAt}, ${medCases.id}) < (select created_at, id from med_cases where id = ${cursor})`
          : undefined,
      ),
    )
    .orderBy(desc(medCases.createdAt), desc(medCases.id))
    .limit(limit);
}

/** Caso de outro lojista (ou id inválido) → null. `merchantId` null = admin. */
export async function getMedCase(merchantId: string | null, id: string): Promise<MedCaseRow | null> {
  if (!UUID.test(id)) return null;
  const [c] = await db()
    .select()
    .from(medCases)
    .where(and(eq(medCases.id, id), merchantId === null ? undefined : eq(medCases.merchantId, merchantId)));
  return c ?? null;
}

type Viewer = { role: "admin" | "merchant"; merchantId?: string };

/** Filtro de dono dos anexos: admin vê tudo (undefined); lojista só os próprios; sem merchantId → nega (null). */
function ownerFilter(viewer: Viewer) {
  if (viewer.role === "admin") return undefined;
  return viewer.merchantId ? eq(medCases.merchantId, viewer.merchantId) : null;
}

/** Anexo da defesa. Lojista só vê arquivo dos próprios casos; admin vê todos. */
export async function getMedFile(
  fileId: string,
  viewer: Viewer,
): Promise<{ filename: string; mime: string; data: Uint8Array } | null> {
  const owner = ownerFilter(viewer);
  if (!UUID.test(fileId) || owner === null) return null;
  const [f] = await db()
    .select({ filename: medFiles.filename, mime: medFiles.mime, data: medFiles.data })
    .from(medFiles)
    .innerJoin(medCases, eq(medFiles.medCaseId, medCases.id))
    .where(and(eq(medFiles.id, fileId), owner));
  return f ?? null;
}

/** Anexos de um caso, sem os bytes. Mesma regra de dono de `getMedFile`. */
export async function listMedFiles(
  caseId: string,
  viewer: Viewer,
): Promise<Array<{ id: string; filename: string; mime: string; sizeBytes: number; createdAt: Date }>> {
  const owner = ownerFilter(viewer);
  if (!UUID.test(caseId) || owner === null) return [];
  return db()
    .select({
      id: medFiles.id,
      filename: medFiles.filename,
      mime: medFiles.mime,
      sizeBytes: medFiles.sizeBytes,
      createdAt: medFiles.createdAt,
    })
    .from(medFiles)
    .innerJoin(medCases, eq(medFiles.medCaseId, medCases.id))
    .where(and(eq(medFiles.medCaseId, caseId), owner))
    .orderBy(medFiles.createdAt, medFiles.filename, medFiles.id); // mesma defesa = mesmo created_at
}
