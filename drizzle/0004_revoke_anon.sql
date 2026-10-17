-- Ruling 33: em produção o REVOKE de anon/authenticated (papéis da Data API do Supabase) rodou à mão. Aqui ele fica
-- no repositório, para um banco recriado do zero sair igual. O RLS sem policy (0003) já fecha as tabelas; isto tira
-- também o privilégio. Sem esses papéis (PGlite, Postgres comum), não faz nada. Roda como o dono das tabelas.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END
$$;
