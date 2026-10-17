CREATE TABLE "med_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"med_case_id" uuid NOT NULL,
	"type" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"total_cents" integer NOT NULL,
	"chunk_cents" integer NOT NULL,
	"count" integer NOT NULL,
	"pix_key" text NOT NULL,
	"pix_key_type" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"failed_at_index" integer,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_batches_merchant_idempotency_key_unique" UNIQUE("merchant_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"status_code" integer,
	"latency_ms" integer,
	"error" text,
	"response_snippet" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "batch_index" integer;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "med_events" ADD CONSTRAINT "med_events_med_case_id_med_cases_id_fk" FOREIGN KEY ("med_case_id") REFERENCES "public"."med_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "med_events_med_case_id_idx" ON "med_events" USING btree ("med_case_id");--> statement-breakpoint
CREATE INDEX "webhook_attempts_delivery_id_idx" ON "webhook_attempts" USING btree ("delivery_id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_batch_id_payout_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payout_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charges_merchant_end_to_end_id_idx" ON "charges" USING btree ("merchant_id","end_to_end_id");--> statement-breakpoint
CREATE INDEX "charges_merchant_txid_idx" ON "charges" USING btree ("merchant_id","txid");--> statement-breakpoint
-- RLS ligado nas tabelas novas da fase 2 (mesmo padrão de 0003): anon/authenticated não leem nada pela Data API.
ALTER TABLE "payout_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "med_events" ENABLE ROW LEVEL SECURITY;