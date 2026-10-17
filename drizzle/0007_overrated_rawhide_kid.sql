CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"fee_in_bps" integer NOT NULL,
	"fee_in_fixed_cents" integer NOT NULL,
	"fee_out_bps" integer NOT NULL,
	"fee_out_fixed_cents" integer NOT NULL,
	"plan_id" uuid,
	"effective_from" timestamp with time zone NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"fee_in_bps" integer NOT NULL,
	"fee_in_fixed_cents" integer NOT NULL,
	"fee_out_bps" integer NOT NULL,
	"fee_out_fixed_cents" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"amount_cents" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"result_ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "med_events" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "cnpj_lookup" jsonb;--> statement-breakpoint
ALTER TABLE "fee_history" ADD CONSTRAINT "fee_history_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_history" ADD CONSTRAINT "fee_history_plan_id_fee_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."fee_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_history" ADD CONSTRAINT "fee_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cron_runs_step_started_at_idx" ON "cron_runs" USING btree ("step","started_at");--> statement-breakpoint
CREATE INDEX "pending_approvals_status_created_at_idx" ON "pending_approvals" USING btree ("status","created_at");--> statement-breakpoint
-- RLS ligado nas tabelas novas do backoffice (mesmo padrão de 0003/0005): anon/authenticated não leem nada pela Data API.
ALTER TABLE "pending_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cron_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_history" ENABLE ROW LEVEL SECURITY;