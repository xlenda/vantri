import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Convenção: propriedade TS em camelCase, coluna no banco em snake_case (nome explícito).
// Dinheiro sempre em centavos (int). Datas sempre timestamptz.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tstz = (name: string) => timestamp(name, { withTimezone: true });

// drizzle 0.45 não tem bytea nativo. postgres-js devolve Buffer, PGlite devolve Uint8Array.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const merchants = pgTable("merchants", {
  id: id(),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name").notNull(),
  documentType: text("document_type", { enum: ["cpf", "cnpj"] }).notNull(),
  documentEnc: text("document_enc").notNull(),
  documentHash: text("document_hash").notNull().unique(),
  segment: text("segment").notNull(),
  status: text("status", { enum: ["pending", "active", "suspended", "rejected"] })
    .notNull()
    .default("pending"),
  needsManualReview: boolean("needs_manual_review").notNull().default(false),
  providerAccountId: text("provider_account_id"),
  feeInBps: integer("fee_in_bps").notNull().default(149),
  feeInFixedCents: integer("fee_in_fixed_cents").notNull().default(0),
  feeOutBps: integer("fee_out_bps").notNull().default(0),
  feeOutFixedCents: integer("fee_out_fixed_cents").notNull().default(100),
  approvedAt: tstz("approved_at"),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "merchant"] }).notNull(),
    merchantId: uuid("merchant_id").references(() => merchants.id),
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: tstz("locked_until"),
    createdAt: createdAt(),
  },
  (t) => [check("users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 do token; o token em si nunca é guardado
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  mfaPassed: boolean("mfa_passed").notNull().default(false),
  expiresAt: tstz("expires_at").notNull(),
  createdAt: createdAt(),
});

export const apiKeys = pgTable("api_keys", {
  id: id(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes").array().notNull(),
  ipAllowlist: text("ip_allowlist").array().notNull().default(sql`'{}'::text[]`),
  lastUsedAt: tstz("last_used_at"),
  revokedAt: tstz("revoked_at"),
  createdAt: createdAt(),
});

export const charges = pgTable(
  "charges",
  {
    id: id(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    txid: text("txid").notNull().unique(),
    externalRef: text("external_ref").notNull(),
    amountCents: integer("amount_cents").notNull(),
    feeCents: integer("fee_cents").notNull(),
    description: text("description"),
    status: text("status", { enum: ["pending", "paid", "expired"] }).notNull(),
    brcode: text("brcode").notNull(),
    providerChargeId: text("provider_charge_id").notNull().unique(),
    expiresAt: tstz("expires_at").notNull(),
    paidAt: tstz("paid_at"),
    payerName: text("payer_name"),
    payerDocumentMasked: text("payer_document_masked"),
    endToEndId: text("end_to_end_id"),
    createdAt: createdAt(),
  },
  (t) => [unique("charges_merchant_external_ref_unique").on(t.merchantId, t.externalRef)],
);

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    amountCents: integer("amount_cents").notNull(),
    feeCents: integer("fee_cents").notNull(),
    pixKey: text("pix_key").notNull(),
    pixKeyType: text("pix_key_type", { enum: ["cpf", "cnpj", "email", "phone", "evp"] }).notNull(),
    description: text("description"),
    status: text("status", { enum: ["processing", "completed", "failed"] }).notNull(),
    failureCode: text("failure_code"),
    providerPayoutId: text("provider_payout_id").unique(),
    endToEndId: text("end_to_end_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    completedAt: tstz("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [unique("payouts_merchant_idempotency_key_unique").on(t.merchantId, t.idempotencyKey)],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    amountCents: integer("amount_cents").notNull(), // com sinal
    bucket: text("bucket", { enum: ["available", "blocked"] }).notNull(),
    kind: text("kind", {
      enum: [
        "cash_in",
        "fee_in",
        "cash_out",
        "fee_out",
        "cash_out_reversal",
        "med_hold",
        "med_release",
        "med_debit",
        "adjustment",
      ],
    }).notNull(),
    refType: text("ref_type", { enum: ["charge", "payout", "med_case", "manual"] }).notNull(),
    refId: uuid("ref_id").notNull(),
    createdAt: createdAt(),
  },
  // Trava de idempotência do dinheiro: o mesmo evento nunca lança duas vezes.
  (t) => [unique("ledger_entries_idempotency_unique").on(t.merchantId, t.kind, t.refId, t.bucket)],
);

export const medCases = pgTable("med_cases", {
  id: id(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  chargeId: uuid("charge_id")
    .notNull()
    .references(() => charges.id),
  providerCaseId: text("provider_case_id").notNull().unique(),
  amountCents: integer("amount_cents").notNull(),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["open", "defended", "merchant_won", "payer_refunded"] }).notNull(),
  defenseText: text("defense_text"),
  defenseDeadline: tstz("defense_deadline").notNull(),
  closedAt: tstz("closed_at"),
  createdAt: createdAt(),
});

export const medFiles = pgTable("med_files", {
  id: id(),
  medCaseId: uuid("med_case_id")
    .notNull()
    .references(() => medCases.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  createdAt: createdAt(),
});

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: id(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  events: text("events").array().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    // Default now(): entrega nova já nasce vencida (o dispatcher pega na próxima rodada).
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    deliveredAt: tstz("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: tstz("window_start").notNull(),
  count: integer("count").notNull(),
  createdAt: createdAt(),
});

export const auditLog = pgTable("audit_log", {
  id: id(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  meta: jsonb("meta").notNull().default({}),
  createdAt: createdAt(),
});
