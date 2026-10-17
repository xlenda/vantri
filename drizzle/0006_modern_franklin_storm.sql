ALTER TABLE "users" ADD COLUMN "admin_role" text;--> statement-breakpoint
-- Backfill: todo admin existente vira o papel cheio 'admin'. Lojista fica null (sub-papel só vale para admin).
-- Coluna nova, nenhuma tabela nova: RLS/REVOKE de 0003/0004 continuam cobrindo users.
UPDATE "users" SET "admin_role" = 'admin' WHERE "role" = 'admin';