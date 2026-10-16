import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { lookupCnpj } from "@/lib/br/cnpj-lookup";
import { isValidCnpj, isValidCpf, normalizeDocument, onlyDigits, SEGMENTS } from "@/lib/br/documents";
import { decrypt, encrypt, hmacHex, randomBase62 } from "@/lib/crypto";
import { db, type Tx } from "@/lib/db/client";
import { auditLog, merchants, users } from "@/lib/db/schema";
import { getProvider } from "@/lib/provider";
import type { PixProvider } from "@/lib/provider/types";
import { parseOr } from "@/lib/validation";

export type MerchantErrorCode =
  | "invalid_request"
  | "invalid_document"
  | "segment_not_allowed"
  | "betting_cnae"
  | "cnpj_inactive"
  | "cnpj_lookup_unavailable"
  | "document_taken"
  | "email_taken"
  | "not_found"
  | "invalid_status"
  | "provider_error";

export class MerchantError extends Error {
  constructor(
    public readonly code: MerchantErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MerchantError";
  }
}

const notFound = () => new MerchantError("not_found", "Cliente não encontrado.");

const merchantFields = {
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(2).max(200),
  documentType: z.enum(["cpf", "cnpj"]),
  document: z.string().max(32),
  segment: z.string().max(64), // conferido contra SEGMENTS para dar o erro segment_not_allowed
  // Minúsculo antes de gravar e de buscar: o banco tem CHECK email = lower(email).
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
};
const signupSchema = z.strictObject({ ...merchantFields, password: z.string().min(12).max(256) });
const adminCreateSchema = z.strictObject(merchantFields);

const bps = z.int().min(0).max(10_000);
const cents = z.int().min(0).max(100_000);
const feesSchema = z.strictObject({ feeInBps: bps, feeInFixedCents: cents, feeOutBps: bps, feeOutFixedCents: cents });
export type Fees = z.infer<typeof feesSchema>;

const parse = <T extends z.ZodType>(schema: T, input: unknown) =>
  parseOr(schema, input, (msg) => new MerchantError("invalid_request", msg));

type MerchantInput = z.output<typeof adminCreateSchema>;

/** Regras de quem pode ser cliente. Devolve o documento normalizado (maiúsculas, sem pontuação). */
async function vet(data: MerchantInput, lookup: typeof lookupCnpj) {
  if (!(SEGMENTS as readonly string[]).includes(data.segment)) {
    throw new MerchantError("segment_not_allowed", "Segmento não atendido.");
  }
  const doc = normalizeDocument(data.document);
  const isCpf = data.documentType === "cpf";
  if (!(isCpf ? isValidCpf(doc) : isValidCnpj(doc))) {
    throw new MerchantError("invalid_document", isCpf ? "CPF inválido." : "CNPJ inválido.");
  }
  if (isCpf) return { doc, needsManualReview: false };

  const r = await lookup(doc);
  if (!r.ok) return { doc, needsManualReview: true }; // BrasilAPI fora do ar: cadastro segue, admin revisa
  if (r.cnaes.some((c) => onlyDigits(c).startsWith("9200"))) {
    throw new MerchantError("betting_cnae", "Não atendemos apostas.");
  }
  if (!r.active) throw new MerchantError("cnpj_inactive", "CNPJ não está ativo na Receita Federal.");
  return { doc, needsManualReview: false };
}

type DbError = { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };

// UNIQUE é a trava de verdade (duas inscrições simultâneas). Drizzle embrulha o erro do driver em `cause`;
// postgres-js chama o campo de constraint_name, PGlite de constraint.
function rethrowTaken(e: unknown): never {
  for (let x = e as DbError | undefined; x; x = x.cause as DbError | undefined) {
    if (x.code !== "23505") continue;
    const c = x.constraint_name ?? x.constraint;
    if (c === "merchants_document_hash_unique") {
      throw new MerchantError("document_taken", "Já existe um cadastro com este documento.");
    }
    if (c === "users_email_unique") throw new MerchantError("email_taken", "Já existe um cadastro com este e-mail.");
  }
  throw e;
}

async function insertMerchant(
  tx: Tx,
  data: MerchantInput,
  v: { doc: string; needsManualReview: boolean },
  user: { passwordHash: string; mustChangePassword: boolean },
) {
  const [m] = await tx
    .insert(merchants)
    .values({
      legalName: data.legalName,
      tradeName: data.tradeName,
      documentType: data.documentType,
      documentEnc: encrypt(v.doc),
      documentHash: hmacHex("document", v.doc),
      segment: data.segment,
      needsManualReview: v.needsManualReview,
    })
    .returning({ id: merchants.id });
  const [u] = await tx
    .insert(users)
    .values({ email: data.email, role: "merchant", merchantId: m.id, ...user })
    .returning({ id: users.id });
  return { merchantId: m.id, userId: u.id };
}

// ponytail: a chamada ao provedor roda dentro da transação (conexão presa pela latência dele). Em troca, falha no
// provedor desfaz tudo e o FOR UPDATE impede abrir duas contas. Status "provisioning" + fila se a latência pesar.
async function provision(tx: Tx, account: Parameters<PixProvider["createAccount"]>[0]) {
  const { providerAccountId } = await getProvider()
    .createAccount(account)
    .catch((cause: unknown) => {
      throw new MerchantError("provider_error", "Não foi possível abrir a conta no parceiro. Tente de novo.", { cause });
    });
  await tx
    .update(merchants)
    .set({ status: "active", providerAccountId, approvedAt: new Date() })
    .where(eq(merchants.id, account.merchantId));
}

const audit = (tx: Tx, actorUserId: string, action: string, meta: Record<string, unknown>) =>
  tx.insert(auditLog).values({ actorUserId, action, meta });

export async function signupMerchant(
  input: unknown,
  deps: { lookup?: typeof lookupCnpj } = {},
): Promise<{ merchantId: string; userId: string }> {
  const data = parse(signupSchema, input);
  const v = await vet(data, deps.lookup ?? lookupCnpj);
  const passwordHash = await hashPassword(data.password);
  return db()
    .transaction((tx) => insertMerchant(tx, data, v, { passwordHash, mustChangePassword: false }))
    .catch(rethrowTaken);
}

export async function adminCreateMerchant(
  input: unknown,
  actorId: string,
  deps: { lookup?: typeof lookupCnpj } = {},
): Promise<{ merchantId: string; email: string; tempPassword: string }> {
  const data = parse(adminCreateSchema, input);
  const v = await vet(data, deps.lookup ?? lookupCnpj);
  // Aqui o cliente já nasce ativo: sem a consulta, a checagem de apostas não rodou.
  if (v.needsManualReview) {
    throw new MerchantError(
      "cnpj_lookup_unavailable",
      "Não foi possível consultar o CNPJ na Receita agora. Tente de novo em instantes.",
    );
  }
  const tempPassword = randomBase62(16);
  const passwordHash = await hashPassword(tempPassword);
  const { merchantId } = await db()
    .transaction(async (tx) => {
      const ids = await insertMerchant(tx, data, v, { passwordHash, mustChangePassword: true });
      await provision(tx, {
        merchantId: ids.merchantId,
        legalName: data.legalName,
        document: v.doc,
        documentType: data.documentType,
        email: data.email,
      });
      await audit(tx, actorId, "merchant.create", { merchantId: ids.merchantId });
      return ids;
    })
    .catch(rethrowTaken);
  return { merchantId, email: data.email, tempPassword };
}

type Status = (typeof merchants.$inferSelect)["status"];

async function lockInStatus(tx: Tx, id: string, from: Status) {
  if (!z.uuid().safeParse(id).success) throw notFound();
  const [m] = await tx.select().from(merchants).where(eq(merchants.id, id)).for("update");
  if (!m) throw notFound();
  if (m.status !== from) throw new MerchantError("invalid_status", "Ação não permitida no status atual do cliente.");
  return m;
}

/** Só a partir de `pending`. Se o provedor falhar, nada muda (continua `pending`). */
export async function approveMerchant(id: string, actorId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const m = await lockInStatus(tx, id, "pending");
    const [u] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.merchantId, id))
      .orderBy(asc(users.createdAt))
      .limit(1);
    if (!u) throw notFound();
    await provision(tx, {
      merchantId: id,
      legalName: m.legalName,
      document: decrypt(m.documentEnc),
      documentType: m.documentType,
      email: u.email,
    });
    await audit(tx, actorId, "merchant.approve", { merchantId: id });
  });
}

const transition = (from: Status, to: Status, action: string) => (id: string, actorId: string) =>
  db().transaction(async (tx) => {
    await lockInStatus(tx, id, from);
    await tx.update(merchants).set({ status: to }).where(eq(merchants.id, id));
    await audit(tx, actorId, action, { merchantId: id });
  });

export const rejectMerchant = transition("pending", "rejected", "merchant.reject");
export const suspendMerchant = transition("active", "suspended", "merchant.suspend");
export const reactivateMerchant = transition("suspended", "active", "merchant.reactivate");

/** bps 0–10000, centavos 0–100000, inteiros. */
export async function updateFees(id: string, fees: Fees, actorId: string): Promise<void> {
  const f = parse(feesSchema, fees);
  if (!z.uuid().safeParse(id).success) throw notFound();
  await db().transaction(async (tx) => {
    const [m] = await tx.update(merchants).set(f).where(eq(merchants.id, id)).returning({ id: merchants.id });
    if (!m) throw notFound();
    await audit(tx, actorId, "merchant.update_fees", { merchantId: id, ...f });
  });
}
