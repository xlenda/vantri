import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import { type Db, setDb } from "@/lib/db/client";
import { charges, ledgerEntries, medCases, medFiles, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { getBalance, postEntries } from "@/lib/money/ledger";
import { simulator } from "@/lib/provider/simulator";
import {
  applyMedClosed,
  applyMedOpened,
  getMedCase,
  getMedFile,
  listMedCases,
  listMedFiles,
  MedError,
  submitDefense,
  toMedCaseJson,
} from "@/lib/services/med";
import { createTestDb } from "./helpers/db";
import { newMerchant } from "./helpers/factories";

let d: Db;

beforeEach(async () => {
  d = await createTestDb();
  setDb(d);
});

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
const TEXT = "O cliente recebeu o produto, segue comprovante de entrega.";

let seq = 0;
/** Lojista com uma cobrança paga de 14990 (líquido 14767 creditado) e webhook ouvindo MED. */
async function paidMerchant(n = 1) {
  const merchantId = await newMerchant(d, n);
  const providerChargeId = `sim_ch_${++seq}`;
  const [ch] = await d
    .insert(charges)
    .values({
      merchantId,
      txid: `tx${seq}`,
      externalRef: `pedido-${seq}`,
      amountCents: 14990,
      feeCents: 223,
      status: "paid",
      brcode: "000201",
      providerChargeId,
      expiresAt: new Date(Date.now() + 3600_000),
      paidAt: new Date(),
    })
    .returning({ id: charges.id });
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId, amountCents: 14990, bucket: "available", kind: "cash_in", refType: "charge", refId: ch.id },
      { merchantId, amountCents: -223, bucket: "available", kind: "fee_in", refType: "charge", refId: ch.id },
    ]),
  );
  await d
    .insert(webhookEndpoints)
    .values({ merchantId, url: "https://loja.example.com/h", secretEnc: "x", events: ["med.opened", "med.closed"] });
  return { merchantId, chargeId: ch.id, providerChargeId };
}

async function openMed(amount = 5000, n = 1) {
  const m = await paidMerchant(n);
  const e = simulator.simulateMed(m.providerChargeId, amount);
  expect(await applyMedOpened(e)).toBe("opened");
  const [c] = await d.select().from(medCases).where(eq(medCases.providerCaseId, e.providerCaseId));
  return { ...m, e, caseId: c.id };
}

const caseRow = async (id: string) => (await d.select().from(medCases).where(eq(medCases.id, id)))[0];
const deliveries = async (type: string) =>
  (await d.select().from(webhookDeliveries)).filter((w) => w.eventType === type);
const closedPayload = async () => {
  const [w] = await deliveries("med.closed");
  return (w.payload as { data: Record<string, unknown> }).data;
};

async function medError(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MedError);
  return (err as MedError).code;
}

it("opened holds amount in blocked", async () => {
  const { merchantId, chargeId, caseId } = await openMed(5000);
  expect(await getBalance(merchantId)).toEqual({ available: 9767, blocked: 5000, total: 14767 });
  const c = await caseRow(caseId);
  expect(c).toMatchObject({ merchantId, chargeId, amountCents: 5000, status: "open" });
  const [w] = await deliveries("med.opened");
  expect((w.payload as { data: unknown }).data).toEqual(JSON.parse(JSON.stringify(toMedCaseJson(c))));
});

it("opened twice holds once", async () => {
  const { merchantId, e } = await openMed(5000);
  expect(await applyMedOpened(e)).toBe("duplicate");
  expect(await getBalance(merchantId)).toEqual({ available: 9767, blocked: 5000, total: 14767 });
  expect(await d.select().from(medCases)).toHaveLength(1);
  expect(await deliveries("med.opened")).toHaveLength(1);
});

it("opened for unknown charge is a no-op", async () => {
  expect(await applyMedOpened(simulator.simulateMed("sim_ch_nao_existe", 5000))).toBe("unknown");
  expect(await d.select().from(medCases)).toHaveLength(0);
});

it("hold may push available negative (merchant already withdrew)", async () => {
  const { merchantId } = await openMed(14990);
  expect(await getBalance(merchantId)).toEqual({ available: -223, blocked: 14990, total: 14767 });
});

it("merchant_won releases", async () => {
  const { merchantId, e, caseId } = await openMed(5000);
  const close = { type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" } as const;
  expect(await applyMedClosed(close)).toBe("closed");
  expect(await getBalance(merchantId)).toEqual({ available: 14767, blocked: 0, total: 14767 });
  const c = await caseRow(caseId);
  expect(c.status).toBe("merchant_won");
  expect(c.closedAt).toBeInstanceOf(Date);
  const closedAt = c.closedAt!.toISOString();
  expect(await closedPayload()).toMatchObject({ id: caseId, status: "merchant_won", closed_at: closedAt });
  // Repetido ou tardio (outro desfecho): ignorado, sem lançamento nem evento.
  expect(await applyMedClosed(close)).toBe("duplicate");
  expect(await applyMedClosed({ ...close, outcome: "payer_refunded" })).toBe("duplicate");
  expect(await getBalance(merchantId)).toEqual({ available: 14767, blocked: 0, total: 14767 });
  expect((await caseRow(caseId)).status).toBe("merchant_won");
  expect(await deliveries("med.closed")).toHaveLength(1);
});

it("payer_refunded debits blocked", async () => {
  const { merchantId, e, caseId } = await openMed(5000);
  await submitDefense(merchantId, caseId, TEXT, []);
  // Fecha também a partir de `defended`.
  const refund = { type: "med.closed", providerCaseId: e.providerCaseId, outcome: "payer_refunded" } as const;
  expect(await applyMedClosed(refund)).toBe("closed");
  expect(await getBalance(merchantId)).toEqual({ available: 9767, blocked: 0, total: 9767 });
  const c = await caseRow(caseId);
  expect(c.status).toBe("payer_refunded");
  expect(await closedPayload()).toMatchObject({ status: "payer_refunded", closed_at: c.closedAt!.toISOString() });
  expect(
    await applyMedClosed({ type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" }),
  ).toBe("duplicate");
  expect(await getBalance(merchantId)).toEqual({ available: 9767, blocked: 0, total: 9767 });
});

it("closed for unknown case is a no-op", async () => {
  expect(await applyMedClosed({ type: "med.closed", providerCaseId: "sim_med_x", outcome: "merchant_won" })).toBe(
    "unknown",
  );
});

it("closed rolls back everything when the ledger already has part of the batch", async () => {
  const { merchantId, e, caseId } = await openMed(5000);
  await d.transaction((tx) =>
    postEntries(tx, [
      { merchantId, amountCents: 5000, bucket: "available", kind: "med_release", refType: "med_case", refId: caseId },
    ]),
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await applyMedClosed({ type: "med.closed", providerCaseId: e.providerCaseId, outcome: "merchant_won" })).toBe(
    "duplicate",
  );
  expect((await caseRow(caseId)).status).toBe("open");
  const blocked = await d.select().from(ledgerEntries).where(eq(ledgerEntries.kind, "med_release"));
  expect(blocked.map((r) => r.bucket)).toEqual(["available"]);
  expect(await deliveries("med.closed")).toHaveLength(0);
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0][0])).toContain(caseId);
  log.mockRestore();
});

it("defense stores files with detected mime and sanitized name, status defended", async () => {
  const { merchantId, caseId } = await openMed();
  await submitDefense(merchantId, caseId, `   ${TEXT}   `, [
    { name: "../../etc/compro\u0000vante.pdf", bytes: PDF },
    { name: "foto.pdf", bytes: PNG },
    { name: "C:\\Users\\a\\nota.JPEG", bytes: JPEG },
    { name: `${"a".repeat(300)}.pdf`, bytes: PDF },
    // U+202E (RTL override) mostraria "fatura" + "exe.pdf" invertido; 4 bytes "%PDF" exatos bastam.
    { name: "fatura\u202Efdp.exe", bytes: PDF.slice(0, 4) },
  ]);
  const c = await caseRow(caseId);
  expect(c.status).toBe("defended");
  expect(c.defenseText).toBe(TEXT);
  const files = await d.select().from(medFiles).where(eq(medFiles.medCaseId, caseId));
  const byName = Object.fromEntries(files.map((f) => [f.filename, f]));
  const names = ["a".repeat(116) + ".pdf", "comprovante.pdf", "faturafdp.exe.pdf", "foto.pdf.png", "nota.JPEG"];
  expect(Object.keys(byName).sort()).toEqual(names);
  expect(byName["foto.pdf.png"].mime).toBe("image/png");
  expect(byName["nota.JPEG"].mime).toBe("image/jpeg");
  expect(byName["faturafdp.exe.pdf"]).toMatchObject({ mime: "application/pdf", sizeBytes: 4 });
  expect(byName["comprovante.pdf"]).toMatchObject({ mime: "application/pdf", sizeBytes: PDF.length });
  expect([...byName["comprovante.pdf"].data]).toEqual([...PDF]);
});

it("defense rejects .exe renamed to .pdf", async () => {
  const { merchantId, caseId } = await openMed();
  const code = await medError(
    submitDefense(merchantId, caseId, TEXT, [
      { name: "ok.pdf", bytes: PDF },
      { name: "contrato.pdf", bytes: EXE },
    ]),
  );
  expect(code).toBe("invalid_file");
  expect((await caseRow(caseId)).status).toBe("open");
  expect(await d.select().from(medFiles)).toHaveLength(0);
});

it("defense rejects bad text and bad file sets", async () => {
  const { merchantId, caseId } = await openMed();
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  big.set(PDF);
  const edge = new Uint8Array(5 * 1024 * 1024);
  edge.set(PDF);
  const pdf = (name: string) => ({ name, bytes: PDF });
  expect(await medError(submitDefense(merchantId, caseId, `   ${"x".repeat(19)}   `, []))).toBe("invalid_request");
  expect(await medError(submitDefense(merchantId, caseId, "x".repeat(5001), []))).toBe("invalid_request");
  expect(await medError(submitDefense(merchantId, caseId, `${TEXT}\u0000fim`, []))).toBe("invalid_request");
  expect(await medError(submitDefense(merchantId, caseId, TEXT, [1, 2, 3, 4, 5, 6].map((i) => pdf(`${i}.pdf`))))).toBe(
    "invalid_file",
  );
  expect(await medError(submitDefense(merchantId, caseId, TEXT, [{ name: "g.pdf", bytes: big }]))).toBe("invalid_file");
  expect(await medError(submitDefense(merchantId, caseId, TEXT, [{ name: "v.pdf", bytes: new Uint8Array() }]))).toBe(
    "invalid_file",
  );
  for (const short of [[0x25, 0x50, 0x44], [0xff, 0xd8]]) {
    const files = [{ name: "curto.pdf", bytes: new Uint8Array(short) }];
    expect(await medError(submitDefense(merchantId, caseId, TEXT, files))).toBe("invalid_file");
  }
  expect((await caseRow(caseId)).status).toBe("open");
  // Limites exatos passam: 5000 caracteres, 5 arquivos, 5 MB.
  const five = [edge, PDF, PDF, PDF, PDF].map((bytes) => ({ name: "a.pdf", bytes }));
  await submitDefense(merchantId, caseId, "x".repeat(5000), five);
  expect(await d.select({ id: medFiles.id }).from(medFiles)).toHaveLength(5);
});

it("defense only once, only while open", async () => {
  const { merchantId, caseId } = await openMed();
  await submitDefense(merchantId, caseId, TEXT, []);
  expect(await medError(submitDefense(merchantId, caseId, TEXT, []))).toBe("invalid_status");
});

it("defense after deadline rejected", async () => {
  const { merchantId, caseId } = await openMed();
  await d.update(medCases).set({ defenseDeadline: new Date(Date.now() - 1000) }).where(eq(medCases.id, caseId));
  expect(await medError(submitDefense(merchantId, caseId, TEXT, [{ name: "a.pdf", bytes: PDF }]))).toBe(
    "deadline_passed",
  );
  expect((await caseRow(caseId)).status).toBe("open");
  expect(await d.select().from(medFiles)).toHaveLength(0);
});

it("defense on another merchant's case is not_found", async () => {
  const { caseId } = await openMed(5000, 1);
  const other = await newMerchant(d, 2);
  expect(await medError(submitDefense(other, caseId, TEXT, []))).toBe("not_found");
  expect(await medError(submitDefense(other, "nao-e-uuid", TEXT, []))).toBe("not_found");
  expect((await caseRow(caseId)).status).toBe("open");
});

it("other merchant cannot read file", async () => {
  const { merchantId, caseId } = await openMed(5000, 1);
  const other = await newMerchant(d, 2);
  await submitDefense(merchantId, caseId, TEXT, [{ name: "prova.pdf", bytes: PDF }]);
  const [{ id }] = await d.select({ id: medFiles.id }).from(medFiles);
  expect(await getMedFile(id, { role: "merchant", merchantId: other })).toBeNull();
  expect(await getMedFile(id, { role: "merchant" })).toBeNull();
  expect(await getMedFile("nao-e-uuid", { role: "admin" })).toBeNull();
  const own = await getMedFile(id, { role: "merchant", merchantId });
  expect(own).toMatchObject({ filename: "prova.pdf", mime: "application/pdf" });
  expect([...own!.data]).toEqual([...PDF]);
  expect(await getMedFile(id, { role: "admin" })).toMatchObject({ filename: "prova.pdf" });
});

it("listMedFiles respects the owner and never returns bytes", async () => {
  const { merchantId, caseId } = await openMed(5000, 1);
  const other = await newMerchant(d, 2);
  await submitDefense(merchantId, caseId, TEXT, [
    { name: "prova.pdf", bytes: PDF },
    { name: "foto.png", bytes: PNG },
  ]);
  expect(await listMedFiles(caseId, { role: "merchant", merchantId: other })).toEqual([]);
  expect(await listMedFiles(caseId, { role: "merchant" })).toEqual([]);
  expect(await listMedFiles("nao-e-uuid", { role: "admin" })).toEqual([]);
  const own = await listMedFiles(caseId, { role: "merchant", merchantId });
  expect(own.map((f) => [f.filename, f.mime, f.sizeBytes])).toEqual([
    ["foto.png", "image/png", PNG.length],
    ["prova.pdf", "application/pdf", PDF.length],
  ]);
  for (const f of own) {
    expect(Object.keys(f).sort()).toEqual(["createdAt", "filename", "id", "mime", "sizeBytes"]);
    expect(await getMedFile(f.id, { role: "merchant", merchantId })).not.toBeNull();
  }
  expect(await listMedFiles(caseId, { role: "admin" })).toHaveLength(2);
});

it("list and get respect the merchant; admin sees all; json has exact fields", async () => {
  const a = await openMed(1000, 1);
  const b = await openMed(2000, 2);
  const e2 = simulator.simulateMed(a.providerChargeId, 3000);
  await applyMedOpened(e2);

  const amounts = (r: { data: Array<{ amountCents: number }> }) => r.data.map((c) => c.amountCents);
  const mine = await listMedCases(a.merchantId);
  expect(amounts(mine)).toEqual([3000, 1000]);
  expect(mine.nextCursor).toBeNull();
  expect(amounts(await listMedCases(null))).toEqual([3000, 2000, 1000]);
  expect(amounts(await listMedCases(null, { status: "open", limit: 1 }))).toEqual([3000]);
  expect(await listMedCases(null, { status: "defended" })).toEqual({ data: [], nextCursor: null });
  // limit não inteiro cai no padrão (50); fora da faixa é limitado a 1–100.
  for (const limit of [Number.NaN, 1.5, Infinity]) expect((await listMedCases(null, { limit })).data).toHaveLength(3);
  expect((await listMedCases(null, { limit: 0 })).data).toHaveLength(1);
  const page1 = await listMedCases(a.merchantId, { limit: 1 });
  expect(page1.nextCursor).toBe(mine.data[0].id);
  const page2 = await listMedCases(a.merchantId, { limit: 1, cursor: page1.nextCursor! });
  expect(amounts(page2)).toEqual([1000]);
  expect(page2.nextCursor).toBeNull(); // página cheia na última: sem página vazia depois
  // Caso de outro lojista (mais novo que o de 1000 de `a`) não serve de cursor para `a`.
  expect(await listMedCases(a.merchantId, { cursor: b.caseId })).toEqual({ data: [], nextCursor: null });
  expect(amounts(await listMedCases(null, { cursor: b.caseId }))).toEqual([1000]); // admin: cursor global

  expect(await getMedCase(a.merchantId, b.caseId)).toBeNull();
  expect(await getMedCase(a.merchantId, "nao-e-uuid")).toBeNull();
  expect((await getMedCase(null, b.caseId))?.amountCents).toBe(2000);

  const json = toMedCaseJson((await getMedCase(a.merchantId, a.caseId))!);
  expect(Object.keys(json).sort()).toEqual(
    ["amount", "charge_id", "closed_at", "created_at", "defense_deadline", "id", "reason", "status"].sort(),
  );
  expect(json).toMatchObject({ id: a.caseId, charge_id: a.chargeId, amount: 1000, status: "open", closed_at: null });
  expect(json.defense_deadline).toBe(a.e.deadline.toISOString());
});

it("MED fora da regra (cobrança não paga ou soma acima do valor) é aplicado e vai para o log, só com ids", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const { merchantId, chargeId, providerChargeId } = await paidMerchant();
  expect(await applyMedOpened(simulator.simulateMed(providerChargeId, 10_000))).toBe("opened");
  expect(err).not.toHaveBeenCalled(); // dentro do valor da cobrança (14990)

  const over = simulator.simulateMed(providerChargeId, 5_000); // 15.000 > 14.990
  expect(await applyMedOpened(over)).toBe("opened");
  expect(await getBalance(merchantId)).toMatchObject({ blocked: 15_000 }); // o razão espelha o parceiro
  const overCase = (await d.select().from(medCases).where(eq(medCases.providerCaseId, over.providerCaseId)))[0];
  expect(err).toHaveBeenCalledTimes(1);
  expect(err.mock.calls[0][0]).toMatch(/soma dos MEDs passa do valor/);
  expect(JSON.parse(err.mock.calls[0][1])).toEqual({ medCase: overCase.id, charge: chargeId, error: "Error" });

  await d.update(charges).set({ status: "pending", paidAt: null }).where(eq(charges.id, chargeId));
  expect(await applyMedOpened(simulator.simulateMed(providerChargeId, 1))).toBe("opened");
  expect(err).toHaveBeenCalledTimes(2);
  expect(err.mock.calls[1][0]).toMatch(/cobrança que não está paga/);
  expect(err.mock.calls.flat().join(" ")).not.toContain("Suspeita de fraude"); // nada do motivo nem do pagador
  err.mockRestore();
});
