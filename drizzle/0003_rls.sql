-- RLS ligado em todas as tabelas, sem policy: anon/authenticated do Supabase não leem nada pela Data API.
-- O app conecta como vantri_app, dono das tabelas, e o dono não é filtrado pelo RLS (sem FORCE).
ALTER TABLE "merchants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "med_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "med_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
