# Vantri Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gateway Pix "Vantri" para venda digital — vitrine, painel do lojista, painel admin e API REST v1 — rodando na Vercel com provedor Pix plugável (simulador agora, parceiro real no plano 2).

**Architecture:** Um app Next.js 15 (App Router) com quatro áreas: `/` (vitrine), `/painel` (lojista), `/admin`, `/api/v1` (API pública). Toda regra de dinheiro mora em `lib/` (serviços puros + Drizzle), testada com Vitest contra PGlite; as telas só chamam serviços via Server Actions. O Pix passa por uma interface `PixProvider`; o simulador implementa essa interface e entrega eventos pelo mesmo caminho que o webhook do parceiro real.

**Tech Stack:** next@15.5.28, react 19, typescript, tailwindcss 4, drizzle-orm 0.45 + drizzle-kit 0.31, postgres (postgres-js 3.4) em produção, @electric-sql/pglite 0.5 nos testes, zod 4, otplib 13 (API funcional), @node-rs/argon2 2, qrcode 1.5, motion 14 (`motion/react`), vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-16-vantri-gateway-design.md`

## Global Constraints

- Idioma de toda a interface, mensagens de erro da API e textos: português do Brasil. Nomes de código e JSON em inglês snake_case (JSON) / camelCase (TS).
- Dinheiro: inteiros em centavos em todo lugar (DB, serviços, JSON). Nunca float. Taxa percentual em pontos-base (`149` = 1,49%).
- `computeFee(amountCents, bps, fixedCents) = Math.round(amountCents * bps / 10000) + fixedCents`.
- Defaults de taxa de lojista novo: Pix recebido `fee_in_bps=149`, `fee_in_fixed_cents=0`; Pix enviado `fee_out_bps=0`, `fee_out_fixed_cents=100`.
- Limites: cobrança mínima 100 centavos **e** maior que a taxa; cobrança máxima 10_000_000; saque máximo por pedido 5_000_000; expiração de cobrança 300–86400 s (padrão 3600).
- Antes de usar qualquer API de biblioteca, conferir no README/tipos da versão instalada (otplib 13 é funcional: `generateSecret`, `generate`, `verify`, `generateURI`; zod 4; drizzle 0.45). Não adivinhar.
- Segredos só no servidor. Nenhuma variável `NEXT_PUBLIC_*` pode conter segredo. Variáveis: `DATABASE_URL`, `APP_ENCRYPTION_KEY` (32 bytes base64), `CRON_SECRET`, `PIX_PROVIDER` (`simulator` por enquanto), `SIMULATOR_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_PSP_NAME`, `NEXT_PUBLIC_COMPANY_LEGAL_NAME`, `NEXT_PUBLIC_COMPANY_CNPJ`.
- Sem alegação inventada em lugar nenhum: nada de volume processado, número de clientes, avaliações, logos de clientes, "homologado", "auditado".
- Aviso RC 16 (texto exato, no rodapé e nos termos): `A Vantri não é instituição financeira nem instituição de pagamento autorizada a funcionar pelo Banco Central do Brasil. As contas e as transações Pix são operadas por {PSP}, instituição autorizada pelo Banco Central do Brasil.` — onde `{PSP}` = `NEXT_PUBLIC_PSP_NAME` ou, se vazio, `instituição parceira`.
- Apostas: não existe segmento de aposta; CNPJ com qualquer CNAE (principal ou secundário) começando em `9200` é recusado.
- Toda entrada externa validada com zod `.strict()` no limite (rota/ação). Lista branca de campos.
- Execução em ondas paralelas (ver fim do plano): agentes paralelos **não** fazem commit; o orquestrador commita ao fim de cada onda. Tasks paralelas tocam arquivos disjuntos.

## Review Focus

1. **Dois saques simultâneos com saldo para um só** → só um passa; o outro recebe 422 `insufficient_balance`. Teste da Task 9 (`locks merchant row`) + teste ao vivo contra Postgres real na Task 18.
2. **Webhook do parceiro chega duas vezes ou fora de ordem** (paid repetido, failed depois de completed) → crédito/estorno acontece no máximo uma vez; transição de estado inválida é ignorada. Testes nas Tasks 8, 9 e 13.
3. **Valores estranhos** (0, negativo, decimal, string, acima do limite, taxa maior que o valor) → 422 `invalid_request` com mensagem clara, nada gravado. Testes nas Tasks 8 e 9.
4. **Lojista A lendo cobrança/saque/MED do lojista B** (pela API ou pelo painel, trocando ID) → 404, nunca o dado. Testes na Task 12 e checagem na Task 14.
5. **Pagamento confirmado depois de a cobrança expirar** → o dinheiro entrou: status vira `paid` e credita normalmente. Teste na Task 8.

---

## File Structure

```
vantri/
  package.json, tsconfig.json, next.config.ts, drizzle.config.ts, vitest.config.ts, vercel.json, .env.example
  scripts/deploy.sh, scripts/seed-admin.ts
  drizzle/                         # migrations geradas
  lib/
    db/schema.ts                   # todas as tabelas
    db/client.ts                   # db() global; setDb() para testes
    crypto.ts                      # AES-256-GCM, sha256, tokens aleatórios
    auth/password.ts, auth/totp.ts, auth/session.ts, auth/guards.ts
    ratelimit.ts, turnstile.ts
    br/documents.ts                # CPF/CNPJ dígito verificador, máscara
    br/cnpj-lookup.ts              # BrasilAPI + regra CNAE 9200
    br/brcode.ts                   # EMV BR Code + CRC16
    money/fees.ts, money/ledger.ts
    provider/types.ts, provider/simulator.ts, provider/index.ts
    services/merchants.ts, charges.ts, payouts.ts, med.ts, events.ts
    webhooks/sign.ts, webhooks/dispatch.ts
    api/http.ts, api/keys.ts, api/serializers.ts, api/openapi.ts
  app/
    (site)/page.tsx, termos/, privacidade/, docs/, opengraph-image.tsx, components/
    entrar/, entrar/2fa/, cadastro/, conta/senha/, conta/2fa/
    painel/ (layout, page, cobrancas, extrato, saques, integracoes, med)
    admin/ (layout, page, clientes, transacoes, med)
    api/v1/..., api/provider/webhook/route.ts, api/cron/tick/route.ts
  tests/ (helpers/db.ts + um arquivo por task)
```

---

### Task 1: Esqueleto do projeto, testes e cabeçalhos de segurança

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `drizzle.config.ts`, `.env.example`, `.gitignore`, `app/layout.tsx`, `app/globals.css`, `app/(site)/page.tsx` (placeholder "Vantri"), `lib/db/client.ts`, `lib/db/schema.ts` (vazio exportando `{}`), `tests/helpers/db.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: `db(): Db`, `setDb(d: Db): void`, `type Db`, `type Tx` (o tipo do argumento de `db().transaction(async (tx) => …)`) em `lib/db/client.ts`; `createTestDb(): Promise<Db>` em `tests/helpers/db.ts` (PGlite em memória + aplica `drizzle/` via `drizzle-orm/pglite/migrator`).

- [ ] **Step 1:** `npx create-next-app@15.5.28 . --ts --tailwind --app --eslint --no-src-dir --import-alias "@/*" --use-npm` (pasta já tem `docs/`; se o CLI recusar pasta não vazia, gerar em pasta temporária e mover). Instalar de uma vez todas as dependências do plano: `drizzle-orm postgres zod otplib @node-rs/argon2 qrcode motion` e dev `drizzle-kit @electric-sql/pglite vitest @types/qrcode tsx`.
- [ ] **Step 2:** `lib/db/client.ts`: em produção cria `drizzle(postgres(DATABASE_URL, { prepare: false, max: 1 }), { schema })` preguiçoso; `setDb()` troca a instância global (testes). `type Db = PgDatabase<PgQueryResultHKT, typeof schema>`.
- [ ] **Step 3:** `next.config.ts` → `headers()` para `/(.*)`: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. Para `/docs` a CSP adiciona `https://cdn.jsdelivr.net` em script-src/style-src/font-src/connect-src. `poweredByHeader: false`. Comentário `// ponytail: 'unsafe-inline' em script; CSP com nonce se houver XSS de terceiros`.
- [ ] **Step 4: Teste** `tests/smoke.test.ts` → `it('test db runs migrations and answers', ...)`: `const d = await createTestDb(); const r = await d.execute(sql\`select 1 as ok\`); expect(r.rows[0].ok).toBe(1)`.
- [ ] **Step 5:** `npx vitest run` → PASS; `npx next build` → sem erro.
- [ ] **Step 6:** Commit `chore: scaffold vantri (next 15, drizzle, vitest+pglite, security headers)`.

---

### Task 2: Schema do banco

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0000_*.sql` (gerado por `npx drizzle-kit generate`), `tests/schema.test.ts`

**Interfaces:**
- Produces (nomes de tabela e coluna exatos — todas as tasks dependem disto; `id` = `uuid` default `gen_random_uuid()`, `created_at timestamptz default now()` em todas):
  - `merchants`: `legal_name`, `trade_name`, `document_type ('cpf'|'cnpj')`, `document_enc`, `document_hash` UNIQUE, `segment`, `status ('pending'|'active'|'suspended'|'rejected')` default `pending`, `needs_manual_review bool default false`, `provider_account_id text null`, `fee_in_bps int default 149`, `fee_in_fixed_cents int default 0`, `fee_out_bps int default 0`, `fee_out_fixed_cents int default 100`, `approved_at`.
  - `users`: `email` UNIQUE (minúsculo), `password_hash`, `role ('admin'|'merchant')`, `merchant_id` FK null, `totp_secret_enc null`, `totp_enabled bool default false`, `must_change_password bool default false`, `failed_logins int default 0`, `locked_until null`.
  - `sessions`: `id text PK` (sha256 do token), `user_id` FK cascade, `mfa_passed bool default false`, `expires_at`.
  - `api_keys`: `merchant_id` FK, `name`, `prefix`, `key_hash` UNIQUE, `scopes text[]`, `ip_allowlist text[] default '{}'`, `last_used_at`, `revoked_at`.
  - `charges`: `merchant_id`, `txid` UNIQUE, `external_ref`, `amount_cents int`, `fee_cents int`, `description null`, `status ('pending'|'paid'|'expired')`, `brcode`, `provider_charge_id` UNIQUE, `expires_at`, `paid_at`, `payer_name`, `payer_document_masked`, `end_to_end_id`; UNIQUE(`merchant_id`,`external_ref`).
  - `payouts`: `merchant_id`, `amount_cents`, `fee_cents`, `pix_key`, `pix_key_type ('cpf'|'cnpj'|'email'|'phone'|'evp')`, `description null`, `status ('processing'|'completed'|'failed')`, `failure_code null`, `provider_payout_id` UNIQUE null, `end_to_end_id`, `idempotency_key`, `request_hash`, `completed_at`; UNIQUE(`merchant_id`,`idempotency_key`).
  - `ledger_entries`: `merchant_id`, `amount_cents int` (com sinal), `bucket ('available'|'blocked')`, `kind ('cash_in'|'fee_in'|'cash_out'|'fee_out'|'cash_out_reversal'|'med_hold'|'med_release'|'med_debit'|'adjustment')`, `ref_type ('charge'|'payout'|'med_case'|'manual')`, `ref_id uuid`; UNIQUE(`merchant_id`,`kind`,`ref_id`,`bucket`) — trava de idempotência do dinheiro.
  - `med_cases`: `merchant_id`, `charge_id` FK, `provider_case_id` UNIQUE, `amount_cents`, `reason`, `status ('open'|'defended'|'merchant_won'|'payer_refunded')`, `defense_text null`, `defense_deadline`, `closed_at`.
  - `med_files`: `med_case_id` FK cascade, `filename`, `mime`, `size_bytes`, `data bytea`.
  - `webhook_endpoints`: `merchant_id`, `url`, `secret_enc`, `events text[]`, `active bool default true`.
  - `webhook_deliveries`: `endpoint_id` FK cascade, `event_id`, `event_type`, `payload jsonb`, `status ('pending'|'delivered'|'failed')`, `attempts int default 0`, `next_attempt_at`, `last_status_code null`, `last_error null`, `delivered_at`; índice em (`status`,`next_attempt_at`).
  - `rate_limits`: `key text PK`, `window_start timestamptz`, `count int`.
  - `audit_log`: `actor_user_id null`, `action`, `meta jsonb`.

- [ ] **Step 1: Teste** `tests/schema.test.ts`:
  - `it('rejects duplicate external_ref per merchant')` → inserir 2 charges mesmo merchant/external_ref → segunda lança erro de unique.
  - `it('rejects duplicate ledger entry for same kind/ref/bucket')` → idem em `ledger_entries`.
  - `it('allows same external_ref for different merchants')` → passa.
- [ ] **Step 2:** rodar → FAIL (tabelas não existem).
- [ ] **Step 3:** escrever `schema.ts` (enums como `text({ enum: [...] })`), `npx drizzle-kit generate`.
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat(db): schema completo do gateway`.

---

### Task 3: Criptografia, senha e 2FA (funções puras)

**Files:**
- Create: `lib/crypto.ts`, `lib/auth/password.ts`, `lib/auth/totp.ts`, `tests/crypto-auth.test.ts`

**Interfaces:**
- Produces:
  - `encrypt(plain: string): string` / `decrypt(enc: string): string` — AES-256-GCM, chave `APP_ENCRYPTION_KEY`, formato `v1:<iv b64>:<tag b64>:<ct b64>`.
  - `sha256Hex(s: string): string`, `randomToken(bytes = 32): string` (base64url), `randomBase62(len: number): string`.
  - `hashPassword(p: string): Promise<string>`, `verifyPassword(hash: string, p: string): Promise<boolean>` (@node-rs/argon2).
  - `newTotpSecret(): string`, `totpUri(secret: string, email: string): string` (issuer `Vantri`), `checkTotp(secret: string, code: string): Promise<boolean>` (tolerância ±1 passo de 30 s).

- [ ] **Step 1: Testes:**
  - `encrypt/decrypt roundtrip` e `decrypt rejects tampered ciphertext` (trocar 1 char do ct → lança).
  - `two encryptions of same text differ` (IV aleatório).
  - `verifyPassword true for right, false for wrong`; `hash is not the password`.
  - `checkTotp accepts current code` (gerar com otplib `generate`), `rejects '000000' when not current`, `rejects code from 3 steps ago`.
- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(auth): crypto, argon2 e totp`.

---

### Task 4: Taxas e razão (ledger)

**Files:**
- Create: `lib/money/fees.ts`, `lib/money/ledger.ts`, `tests/ledger.test.ts`

**Interfaces:**
- Consumes: `db()`, schema (Task 2).
- Produces:
  - `computeFee(amountCents: number, bps: number, fixedCents: number): number`.
  - `lockMerchant(tx: Tx, merchantId: string): Promise<void>` (`Tx` vem de `lib/db/client.ts`) — `SELECT id FROM merchants WHERE id=$1 FOR UPDATE`.
  - `postEntries(tx: Tx, entries: Array<{merchantId, amountCents, bucket, kind, refType, refId}>): Promise<boolean>` — insere com `ON CONFLICT DO NOTHING`; devolve `false` se **qualquer** entrada já existia (idempotência).
  - `getBalance(merchantId: string, tx?: Tx): Promise<{available: number, blocked: number, total: number}>`.

- [ ] **Step 1: Testes:**
  - `computeFee(10000,149,0)===149`, `computeFee(10000,0,100)===100`, `computeFee(9999,149,99)===248` (149×9999/10000=148,99→149, +99), `computeFee(1,149,0)===0`.
  - `getBalance sums per bucket` (cash_in +10000, fee_in −149, med_hold −500 available / +500 blocked → `{available: 9351, blocked: 500, total: 9851}`).
  - `postEntries returns false and writes nothing new on replay`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(money): taxas e razão com idempotência`.

---

### Task 5: Provedor Pix (interface, simulador, BR Code)

**Files:**
- Create: `lib/br/brcode.ts`, `lib/provider/types.ts`, `lib/provider/simulator.ts`, `lib/provider/index.ts`, `tests/provider.test.ts`

**Interfaces:**
- Produces:
  - `crc16(payload: string): string` (CRC-16/CCITT-FALSE, poly 0x1021, init 0xFFFF, 4 hex maiúsculos).
  - `buildBrCode(p: {pixKey: string, amountCents: number, merchantName: string, merchantCity: string, txid: string}): string` — EMV MPM com campos 00, 01=`12` (dinâmico de uso único), 26 (GUI `br.gov.bcb.pix` + chave), 52=`0000`, 53=`986`, 54 (valor com ponto, 2 casas), 58=`BR`, 59 (≤25 chars, sem acento), 60 (≤15), 62/05 (txid), 63 (CRC sobre tudo incluindo `6304`).
  - `lib/provider/types.ts`:
    ```ts
    export interface PixProvider {
      name: string
      createAccount(i: { merchantId: string; legalName: string; document: string; documentType: 'cpf'|'cnpj'; email: string }): Promise<{ providerAccountId: string }>
      createCharge(i: { providerAccountId: string; amountCents: number; txid: string; description?: string; expiresInSec: number }): Promise<{ providerChargeId: string; brcode: string }>
      createPayout(i: { providerAccountId: string; amountCents: number; pixKey: string; pixKeyType: PixKeyType; idempotencyKey: string; description?: string }): Promise<{ providerPayoutId: string; status: 'processing'|'completed'|'failed'; failureCode?: string; endToEndId?: string }>
      getPayout(providerPayoutId: string): Promise<{ status: 'processing'|'completed'|'failed'; failureCode?: string; endToEndId?: string }>
      parseWebhook(req: { headers: Headers; rawBody: string }): Promise<ProviderEvent[]>  // lança se a autenticação falhar
    }
    export type ProviderEvent =
      | { type: 'charge.paid'; providerChargeId: string; paidAt: Date; endToEndId: string; payerName?: string; payerDocument?: string }
      | { type: 'payout.completed'; providerPayoutId: string; endToEndId: string }
      | { type: 'payout.failed'; providerPayoutId: string; failureCode: string }
      | { type: 'med.opened'; providerChargeId: string; providerCaseId: string; amountCents: number; reason: string; deadline: Date }
      | { type: 'med.closed'; providerCaseId: string; outcome: 'merchant_won'|'payer_refunded' }
    ```
  - `getProvider(): PixProvider` (por `PIX_PROVIDER`; só `simulator` existe; outro valor → erro claro "provedor X não configurado").
  - Simulador: ids `sim_acc_*`, `sim_ch_*`, `sim_po_*`; chave Pix do BR Code = EVP fixa `00000000-0000-4000-8000-000000000000`; payout para chave `falha@teste.com` → `failed`/`pix_key_not_found`, senão `completed` na hora com `endToEndId` `E00000000` + 23 alfanuméricos; `parseWebhook` exige header `x-simulator-secret === SIMULATOR_WEBHOOK_SECRET`; extra (fora da interface): `simulatePaid(providerChargeId): ProviderEvent` e `simulateMed(providerChargeId, amountCents): ProviderEvent`.

- [ ] **Step 1: Testes:** `crc16('123456789') === '29B1'`; `buildBrCode` termina com `6304` + `crc16(tudo antes, incluindo '6304')`; contém `5406149.90` para 14990 centavos; nome com acento sai sem acento; `simulator payout to falha@teste.com fails with pix_key_not_found`; `parseWebhook rejects wrong secret`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(provider): interface PixProvider, simulador e BR Code`.

---

### Task 6: Lojistas — cadastro, criação pelo admin, aprovação, taxas

**Files:**
- Create: `lib/br/documents.ts`, `lib/br/cnpj-lookup.ts`, `lib/services/merchants.ts`, `tests/merchants.test.ts`

**Interfaces:**
- Consumes: Task 2, 3 (`encrypt`, `sha256Hex`, `hashPassword`, `randomBase62`), Task 5 (`getProvider().createAccount`).
- Produces:
  - `isValidCpf(d: string): boolean`, `isValidCnpj(d: string): boolean`, `onlyDigits(s)`, `maskDocument(d: string): string` (`***.456.789-**` / `12.345.678/****-**`).
  - `SEGMENTS = ['cursos','mentorias','ebooks','comunidades','saas','eventos_online','servicos_digitais'] as const` com rótulos PT.
  - `lookupCnpj(cnpj: string, fetcher = fetch): Promise<{ ok: true; legalName: string; cnaes: string[]; active: boolean } | { ok: false }>` (BrasilAPI `/api/cnpj/v1/{cnpj}`, timeout 5 s).
  - `signupMerchant(input: unknown, deps?: { lookup?: typeof lookupCnpj }): Promise<{ merchantId: string; userId: string }>` — zod strict: `legalName, tradeName, documentType, document, segment, email, password (≥12)`; erros como `MerchantError(code, mensagem PT)`: `invalid_document`, `segment_not_allowed`, `betting_cnae` ("Não atendemos apostas."), `cnpj_inactive`, `document_taken`, `email_taken`. BrasilAPI fora do ar → cria com `needs_manual_review=true`.
  - `adminCreateMerchant(input: unknown, actorId: string): Promise<{ merchantId: string; email: string; tempPassword: string }>` — mesma validação, senha temporária `randomBase62(16)`, `must_change_password=true`, status já `active` + `createAccount` no provedor.
  - `approveMerchant(id, actorId)`, `rejectMerchant(id, actorId)`, `suspendMerchant(id, actorId)`, `reactivateMerchant(id, actorId)`, `updateFees(id, {feeInBps, feeInFixedCents, feeOutBps, feeOutFixedCents}, actorId)` (inteiros 0–10000 bps, 0–100000 centavos) — cada uma grava `audit_log`.

- [ ] **Step 1: Testes:**
  - `isValidCpf('52998224725')===true`, `isValidCpf('11111111111')===false`, `isValidCnpj('11222333000181')===true`, `isValidCnpj('11222333000180')===false`.
  - `signup rejects betting CNAE` (lookup fake devolve `cnaes:['9200399']` → `betting_cnae`, nada gravado).
  - `signup rejects segment 'apostas'`.
  - `signup ignores extra fields` (`role:'admin', status:'active', fee_in_bps:0` no input → zod strict rejeita com `invalid_request`).
  - `signup stores document encrypted` (coluna `document_enc` ≠ dígitos; `decrypt` devolve dígitos).
  - `signup with lookup down sets needs_manual_review`.
  - `approve calls provider.createAccount and sets active + provider_account_id`.
  - `adminCreateMerchant returns temp password that verifies and must_change_password=true`.
  - `updateFees rejects 10001 bps`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(merchants): cadastro, criação pelo admin, aprovação e taxas`.

---

### Task 7: Sessão, login com bloqueio, 2FA e guardas

**Files:**
- Create: `lib/auth/session.ts`, `lib/auth/guards.ts`, `lib/ratelimit.ts`, `lib/turnstile.ts`, `tests/auth.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3.
- Produces:
  - `rateLimit(key: string, limit: number, windowSec: number): Promise<{ ok: boolean; retryAfterSec: number }>` (janela fixa em `rate_limits`, upsert atômico). `// ponytail: janela fixa no Postgres; Redis/Upstash se o volume pedir`.
  - `verifyTurnstile(token: string|undefined, ip: string): Promise<boolean>` — sem `TURNSTILE_SECRET_KEY` devolve `true` e loga aviso uma vez.
  - `login(email: string, password: string, ip: string): Promise<{ ok: true; token: string; needsTotpSetup: boolean } | { ok: false; reason: 'invalid'|'locked'|'rate_limited'|'pending'|'suspended' }>` — 5 falhas seguidas → `locked_until = now+15min`; rate limit IP 20/15 min; lojista `pending`/`rejected` → `pending`; `suspended` → `suspended`. Mensagem genérica para e-mail inexistente (mesmo tempo de resposta: verificar contra hash fixo).
  - `passTotp(token: string, code: string): Promise<boolean>` (marca `mfa_passed`), `beginTotpSetup(userId): Promise<{ secret: string; uri: string }>` (guarda cifrado, `totp_enabled` ainda false), `confirmTotpSetup(userId, code): Promise<boolean>`, `changePassword(userId, current, next): Promise<boolean>`, `logout(token)`.
  - `SESSION_COOKIE = 'vantri_session'`, `cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV==='production', sameSite: 'lax', path: '/', maxAge: 43200 }`.
  - `getSession(): Promise<{ user, session } | null>` (lê cookie via `next/headers`), `requireUser(opts: { role: 'admin'|'merchant' }): Promise<{ user, merchant? }>` — redireciona para `/entrar` sem sessão, `/conta/2fa` sem TOTP configurado, `/entrar/2fa` sem `mfa_passed`, `/conta/senha` com `must_change_password`; papel errado → `notFound()`.

- [ ] **Step 1: Testes:** `login locks after 5 wrong passwords` (6ª tentativa com senha certa → `locked`); `login pending merchant returns pending`; `session token stored only as hash` (linha em `sessions.id` ≠ token); `passTotp marks mfa_passed`; `rateLimit blocks 21st call in window`; `changePassword rejects wrong current`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(auth): sessão, bloqueio, 2fa e guardas`.

---

### Task 8: Cobranças (cash-in)

**Files:**
- Create: `lib/services/charges.ts`, `tests/charges.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 6; `emit` (Task 11).
- Produces:
  - `createCharge(merchantId: string, input: unknown): Promise<{ charge: ChargeRow; created: boolean }>` — zod strict `{ external_ref: string 1–64, amount: int, description?: string ≤140, expires_in?: int 300–86400 }`; lojista precisa estar `active`; `fee = computeFee(amount, fee_in_bps, fee_in_fixed_cents)`; erros `ChargeError('invalid_request', msg)` para `amount < 100`, `amount <= fee`, `amount > 10_000_000`. Mesmo `external_ref` + mesmo valor → devolve a existente com `created:false`; mesmo `external_ref` + valor diferente → `ChargeError('idempotency_conflict')`. `txid = randomBase62(32)`.
  - `getCharge(merchantId: string, id: string): Promise<ChargeRow | null>` — de outro lojista → `null`. Pendente vencida é marcada `expired` na leitura (e emite `charge.expired`).
  - `listCharges(merchantId, { status?, limit ≤100, cursor? })`.
  - `applyChargePaid(e: Extract<ProviderEvent,{type:'charge.paid'}>): Promise<'credited'|'duplicate'|'unknown'>` — numa transação com `lockMerchant`: status → `paid` (inclusive se estava `expired`), `postEntries` (`cash_in` +amount, `fee_in` −fee, bucket `available`, ref charge); se `postEntries` devolver false → `duplicate` sem emitir; senão `emit('charge.paid')`.
  - `expireDueCharges(now = new Date()): Promise<number>`.

- [ ] **Step 1: Testes:**
  - `create charge 14990 snapshots fee 223` (149 bps: 14990×149/10000=223,35→223).
  - `same external_ref same amount returns existing (created=false)`; `same external_ref other amount → idempotency_conflict`.
  - `rejects amount 0, -1, 1.5, '100', 10000001, and amount <= fee` (merchant com fixo 100 → amount 100 rejeitado).
  - `rejects when merchant not active`.
  - `paid event credits net once` (balance available = 14990−223 = 14767; segunda chamada → `duplicate`, saldo igual).
  - `paid after expiry still credits and status=paid`.
  - `getCharge of other merchant returns null`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(charges): cobrança pix idempotente e crédito único`.

---

### Task 9: Saques (cash-out)

**Files:**
- Create: `lib/services/payouts.ts`, `tests/payouts.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 11 (`emit`).
- Produces:
  - `findPayoutIdByProviderId(providerPayoutId: string): Promise<string | null>` (usado pelo webhook da Task 13).
  - `createPayout(merchantId: string, input: unknown, idempotencyKey: string): Promise<{ payout: PayoutRow; replayed: boolean }>` — zod strict `{ amount: int 100–5_000_000, pix_key: string, pix_key_type: PixKeyType, description?: string ≤140 }`, validação da chave por tipo (cpf/cnpj dígito verificador, e-mail, telefone `+55` + 10–11 dígitos, evp UUID). `requestHash = sha256Hex(JSON canônico do input)`. Mesma key + mesmo hash → `replayed:true` (mesmo objeto); mesma key + hash diferente → `PayoutError('idempotency_conflict')` (409). Transação: `lockMerchant` → `getBalance(tx)` → se `available < amount + fee` → `PayoutError('insufficient_balance')` → grava payout `processing` + `postEntries` (`cash_out` −amount, `fee_out` −fee) → commit → chama `provider.createPayout` **fora** da transação → aplica resultado com `applyPayoutResult`. Erro de rede do provedor → fica `processing` (o cron consulta `getPayout`).
  - `applyPayoutResult(payoutId: string, r: { status, failureCode?, endToEndId? }): Promise<void>` — só transições `processing→completed` e `processing→failed`; `failed` posta `cash_out_reversal` +(amount+fee) uma vez; emite `payout.completed`/`payout.failed`. Outras transições ignoradas.
  - `getPayout(merchantId, id)`, `listPayouts(merchantId, {limit, cursor})`, `pollProcessingPayouts(olderThanSec = 120): Promise<number>`.

- [ ] **Step 1: Testes:**
  - `payout debits amount + fee` (saldo 14767, saque 10000 com fee_out 100 → available 4667).
  - `insufficient balance returns insufficient_balance and writes nothing`.
  - `replay same key same body returns same payout`; `same key different body → idempotency_conflict`.
  - `failed payout reverses once` (chave `falha@teste.com` → status failed, saldo volta a 14767; `applyPayoutResult` repetido não credita de novo).
  - `completed then failed is ignored` (status continua completed, sem estorno).
  - `locks merchant row` — espionar SQL e conferir que `FOR UPDATE` roda antes da leitura de saldo.
  - `rejects invalid cpf key`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(payouts): saque idempotente com trava e estorno único`.

---

### Task 10: MED (devolução por fraude)

**Files:**
- Create: `lib/services/med.ts`, `tests/med.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 11 (`emit`); a cobrança é achada por `provider_charge_id` direto na tabela `charges`.
- Produces:
  - `applyMedOpened(e)` → cria `med_cases` (`open`), `postEntries` (`med_hold` −X available, +X blocked), emite `med.opened`; repetido → no-op.
  - `applyMedClosed(e)` → `merchant_won`: `med_release` (+X available, −X blocked); `payer_refunded`: `med_debit` (−X blocked); emite `med.closed`; repetido → no-op.
  - `submitDefense(merchantId: string, caseId: string, text: string, files: Array<{ name: string; bytes: Uint8Array }>): Promise<void>` — só `open` e antes do prazo; texto 20–5000 chars; até 5 arquivos de até 5 MB; tipo pelo **conteúdo** (magic bytes): PDF `25 50 44 46`, PNG `89 50 4E 47`, JPEG `FF D8 FF`; outro → `MedError('invalid_file')`. Status → `defended`.
  - `listMedCases(merchantId|null, ...)`, `getMedFile(fileId, viewer: { role, merchantId? })` — lojista só os próprios.

- [ ] **Step 1: Testes:** `opened holds amount in blocked` (available −X, blocked +X); `opened twice holds once`; `merchant_won releases`; `payer_refunded debits blocked`; `defense rejects .exe renamed to .pdf` (bytes `4D 5A`); `defense after deadline rejected`; `other merchant cannot read file`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(med): bloqueio, defesa com anexos e encerramento`.

---

### Task 11: Webhooks de saída

**Files:**
- Create: `lib/webhooks/sign.ts`, `lib/webhooks/dispatch.ts`, `lib/services/events.ts`, `tests/webhooks.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3.
- Produces:
  - `lib/services/events.ts`: `type WebhookEventType = 'charge.paid'|'charge.expired'|'payout.completed'|'payout.failed'|'med.opened'|'med.closed'`; `emit(tx: Tx, merchantId: string, type: WebhookEventType, data: object): Promise<void>` → chama `enqueueEvent`. Usado pelas Tasks 8, 9 e 10.
  - `signPayload(secret: string, rawBody: string, t: number): string` → `t=<t>,v1=<hex hmac-sha256(secret, \`${t}.${rawBody}\`)>`; header `X-Vantri-Signature`. `verifySignature(secret, rawBody, header, now, toleranceSec = 300): boolean` (exportado para documentação e testes).
  - `enqueueEvent(tx, merchantId, type, data)` → payload `{ id: 'evt_' + randomBase62(24), type, created_at: ISO, data }`; uma `webhook_deliveries` por endpoint ativo que assina o tipo.
  - `RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 21600, 86400]` (7 tentativas no total; depois `failed`).
  - `dispatchDue(limit = 50, now = new Date(), send = fetch): Promise<{ delivered: number; failed: number }>` — POST JSON, timeout 10 s, sucesso = 2xx; `redirect: 'manual'`.
  - `resendDelivery(merchantId, deliveryId)` → volta para `pending` agora (só do próprio lojista).
  - `createEndpoint(merchantId, { url, events }): Promise<{ id, secret }>` — secret `whsec_` + 32 base62, mostrado uma vez, guardado cifrado; URL precisa ser `https://`, host não pode ser `localhost`, IP literal privado/loopback/link-local, nem `*.internal`/`*.local`.

- [ ] **Step 1: Testes:** `signature verifies and fails with altered body`; `signature older than 300s fails`; `retry schedule: after 1st failure next_attempt_at = now+60s; after 7th failure status=failed`; `2xx marks delivered`; `rejects http:// and https://127.0.0.1 and https://10.0.0.5 endpoint`; `resend of other merchant's delivery is not found`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(webhooks): assinatura com timestamp, fila e reenvio`.

---

### Task 12: API pública v1, chaves e documentação

**Files:**
- Create: `lib/api/keys.ts`, `lib/api/http.ts`, `lib/api/serializers.ts`, `lib/api/openapi.ts`, `app/api/v1/balance/route.ts`, `app/api/v1/charges/route.ts`, `app/api/v1/charges/[id]/route.ts`, `app/api/v1/payouts/route.ts`, `app/api/v1/payouts/[id]/route.ts`, `app/api/v1/statement/route.ts`, `app/api/v1/med/route.ts`, `app/api/v1/med/[id]/route.ts`, `app/api/v1/openapi.json/route.ts`, `app/(site)/docs/page.tsx`, `tests/api.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 7 (`rateLimit`), 8, 9, 10.
- Produces:
  - `SCOPES = ['balance:read','charges:read','charges:write','payouts:read','payouts:write','statement:read','med:read'] as const`.
  - `createApiKey(merchantId, { name, scopes, ipAllowlist }): Promise<{ id, key }>` — `vk_live_` + 40 base62; guarda `sha256Hex`, `prefix` = 12 primeiros chars; mostrada uma vez. `revokeApiKey(merchantId, id)`.
  - `withApi(scope: Scope, handler: (ctx: { merchantId: string; req: Request; params }) => Promise<Response>)` — `Authorization: Bearer vk_live_…`; sem/errada → 401 `unauthorized`; revogada → 401; sem escopo → 403 `forbidden`; IP fora da allowlist (se não vazia; IP de `x-forwarded-for` primeiro valor) → 403; lojista não `active` → 403; rate limit 120/min por chave → 429 + `Retry-After`; atualiza `last_used_at` no máximo 1×/min.
  - Erro JSON: `{ "error": { "code": string, "message": string } }`. Mapa: `invalid_request` 422, `unauthorized` 401, `forbidden` 403, `not_found` 404, `idempotency_conflict` 409, `insufficient_balance` 422, `rate_limited` 429, `provider_error` 502.
  - Serializers (campos exatos, nada além): Charge `{ id, txid, external_ref, amount, fee, net, description, status, brcode, qr_code_base64, expires_at, paid_at, payer: { name, document_masked } | null, end_to_end_id, created_at }`; Payout `{ id, amount, fee, pix_key, pix_key_type, description, status, failure_code, end_to_end_id, created_at, completed_at }`; Balance `{ available, blocked, total }`; StatementEntry `{ id, kind, bucket, amount, ref_type, ref_id, created_at }`; MedCase `{ id, charge_id, amount, reason, status, defense_deadline, created_at, closed_at }`.
  - Rotas: `GET /balance` (balance:read) · `POST /charges` (charges:write; 201 criada, 200 se idempotente) · `GET /charges` e `GET /charges/{id}` (charges:read) · `POST /payouts` (payouts:write; header `Idempotency-Key` obrigatório 8–64 chars → senão 422; 201/200 replay) · `GET /payouts`, `GET /payouts/{id}` (payouts:read) · `GET /statement?from&to&limit&cursor` (statement:read; intervalo ≤366 dias) · `GET /med`, `GET /med/{id}` (med:read).
  - `openapi.ts`: documento OpenAPI **3.1.0** escrito à mão (servers `NEXT_PUBLIC_SITE_URL + /api/v1`, securityScheme bearer, todos os paths/esquemas acima, seção de webhooks com `X-Vantri-Signature` e exemplo de verificação em Node). `/docs` renderiza com Scalar via `<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.75.0">` apontando para `/api/v1/openapi.json`.

- [ ] **Step 1: Testes** (chamando os handlers exportados com `new Request`):
  - `no key → 401`, `revoked key → 401`, `charges:read key POST /charges → 403`, `ip not in allowlist → 403`.
  - `POST /charges 201 then same body 200 same id`.
  - `GET /charges/{id} of other merchant → 404`; `GET /payouts/{id}` idem; `GET /med/{id}` idem.
  - `POST /payouts without Idempotency-Key → 422`.
  - `response has no internal fields` (Charge JSON keys === lista exata acima).
  - `121st request in a minute → 429 with Retry-After`.
  - `openapi.json parses and has openapi '3.1.0' and all 8 paths`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): api v1 com escopos, allowlist, rate limit e openapi 3.1`.

---

### Task 13: Webhook do provedor e cron

**Files:**
- Create: `app/api/provider/webhook/route.ts`, `app/api/cron/tick/route.ts`, `vercel.json`, `tests/provider-webhook.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 8, 9, 10, 11.
- Produces:
  - `POST /api/provider/webhook` → `getProvider().parseWebhook` (falha → 401) → para cada evento: `applyChargePaid` / `applyPayoutResult(await findPayoutIdByProviderId(...))` (id desconhecido → ignora) / `applyMedOpened` / `applyMedClosed` → 200 `{ received: n }`; em seguida `after(() => dispatchDue())`.
  - `GET /api/cron/tick` com `Authorization: Bearer ${CRON_SECRET}` (senão 401) → `expireDueCharges()`, `pollProcessingPayouts()`, `dispatchDue()` → 200 com contagens.
  - `vercel.json`: cron diário `0 3 * * *` em `/api/cron/tick` (garantia mínima no plano grátis). A cada minuto, o crontab do servidor do Lenda (Task 18).

- [ ] **Step 1: Testes:** `webhook with wrong simulator secret → 401`; `charge.paid delivered twice credits once`; `payout.failed after completed ignored`; `tick without secret → 401`; `tick expires due charges`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(provider): webhook de entrada e cron`.

---

### Task 14: Telas de acesso (entrar, cadastro, 2FA, senha)

**Files:**
- Create: `app/entrar/page.tsx`, `app/entrar/actions.ts`, `app/entrar/2fa/page.tsx`, `app/cadastro/page.tsx`, `app/cadastro/actions.ts`, `app/conta/2fa/page.tsx`, `app/conta/senha/page.tsx`, `app/components/turnstile.tsx`, `app/components/ui/*` (botão, campo, cartão, tabela, selo de status — usados também nas Tasks 15 e 16)

**Interfaces:**
- Consumes: Tasks 6, 7.
- Produces: fluxo completo de acesso; componentes de UI compartilhados em `app/components/ui/`.

- [ ] **Step 1:** Server Actions chamando `login`, `signupMerchant`, `passTotp`, `beginTotpSetup`/`confirmTotpSetup` (QR do `totpUri` via `qrcode.toDataURL` + código para digitar), `changePassword`, `logout`. Turnstile em entrar e cadastro. Cadastro: campos da Task 6, select de segmento só com `SEGMENTS`, caixa obrigatória "Declaro que não opero apostas nem jogos de azar", link para termos. Depois do cadastro: tela "Recebemos seu cadastro. Você poderá entrar quando aprovarmos." Mensagens de erro em PT vindas dos códigos.
- [ ] **Step 2:** `npx next build` sem erro; `npx tsc --noEmit` limpo.
- [ ] **Step 3:** Commit `feat(ui): entrar, cadastro, 2fa e troca de senha`.

---

### Task 15: Painel do lojista

**Files:**
- Create: `app/painel/layout.tsx` (menu lateral: Início, Cobranças, Extrato, Saques, Integrações, MED; no celular vira menu de topo), `app/painel/page.tsx`, `app/painel/cobrancas/page.tsx`, `app/painel/cobrancas/actions.ts`, `app/painel/extrato/page.tsx`, `app/painel/extrato/csv/route.ts`, `app/painel/saques/page.tsx`, `app/painel/saques/actions.ts`, `app/painel/integracoes/page.tsx`, `app/painel/integracoes/actions.ts`, `app/painel/med/page.tsx`, `app/painel/med/actions.ts`

**Interfaces:**
- Consumes: Tasks 7 (`requireUser({role:'merchant'})` em todo layout/ação/rota), 8–12, componentes da Task 14.

- [ ] **Step 1:** Início: saldo disponível/bloqueado/total, recebido hoje e nos últimos 7 dias (gráfico de barras SVG simples), últimas 5 cobranças. Cobranças: criar (valor em reais convertido para centavos no servidor, descrição, validade) → mostra QR (`qrcode.toDataURL(brcode)`) + copia-e-cola + status; lista com filtro de status; com `PIX_PROVIDER=simulator` aparece faixa "Ambiente de teste" e botão "Simular pagamento" (chama `simulatePaid` → `applyChargePaid`). Extrato: tabela paginada + CSV (`/painel/extrato/csv?from&to`, `Content-Disposition: attachment`). Saques: formulário (valor, tipo de chave, chave, descrição) + **código 2FA obrigatório** (verifica `checkTotp` antes de `createPayout`; idempotency key = `randomBase62(24)` gerada no render do formulário), lista. Integrações: chaves de API (criar com nome/escopos/IPs → mostra a chave **uma vez**; revogar), webhooks (criar → secret uma vez; lista de entregas com status, código HTTP, tentativas e botão reenviar). MED: casos, prazo, formulário de defesa com anexos.
- [ ] **Step 2:** Toda ação lê `merchantId` da sessão, nunca do formulário.
- [ ] **Step 3:** `npx next build` + `npx tsc --noEmit` limpos.
- [ ] **Step 4:** Commit `feat(painel): painel do lojista`.

---

### Task 16: Painel admin

**Files:**
- Create: `app/admin/layout.tsx`, `app/admin/page.tsx`, `app/admin/clientes/page.tsx`, `app/admin/clientes/[id]/page.tsx`, `app/admin/clientes/actions.ts`, `app/admin/transacoes/page.tsx`, `app/admin/med/page.tsx`, `app/admin/med/actions.ts`, `app/admin/med/arquivo/[id]/route.ts`, `scripts/seed-admin.ts`

**Interfaces:**
- Consumes: Tasks 6, 7 (`requireUser({role:'admin'})`), 8–10.

- [ ] **Step 1:** Início: contagem de pendentes, volume do dia, saques em processamento, MEDs abertos. Clientes: lista com filtro de status e selo "revisão manual"; detalhe com dados (documento descriptografado e mascarado), aprovar/recusar/suspender/reativar, editar as 4 taxas (campos em % e R$, gravados como bps/centavos), saldo, últimas transações. "Criar cliente": formulário → mostra e-mail + senha temporária **uma vez** com botão copiar e aviso "envie ao cliente; ele troca no primeiro acesso". Transações: cobranças e saques de todos, filtro por cliente/status/data. MED: lista; com simulador, "Abrir MED de teste" numa cobrança paga; encerrar a favor do lojista ou do pagador; baixar anexos (`Content-Disposition: attachment`).
- [ ] **Step 2:** `scripts/seed-admin.ts <email>` (`npm run seed:admin -- email`): cria admin com senha temporária impressa uma vez, `must_change_password=true`.
- [ ] **Step 3:** `npx next build` + `npx tsc --noEmit` limpos.
- [ ] **Step 4:** Commit `feat(admin): painel admin e seed`.

---

### Task 17: Vitrine, marca e páginas legais

**Files:**
- Create: `app/(site)/page.tsx`, `app/(site)/layout.tsx`, `app/(site)/components/*` (Header com menu mobile, Hero, Segmentos, Fatos, Recursos, Dev, Precos, Faq, CtaFinal, Footer, Reveal, Counter, Gauge, LineChart, Marquee), `app/(site)/termos/page.tsx`, `app/(site)/privacidade/page.tsx`, `app/opengraph-image.tsx`, `app/icon.svg`, `public/vantri-logo.svg`

**Interfaces:**
- Consumes: só `computeFee` e os defaults de taxa (Global Constraints) para o bloco de preço.

- [ ] **Step 1: Marca.** Wordmark "vantri" em minúsculas + símbolo (um "V" formado por duas faixas que se cruzam). Tokens em `globals.css` (`@theme`): `--color-bg #F6F6F1`, `--color-ink #0E1120`, `--color-brand #3B37F2`, `--color-accent #C9F25B`, `--color-muted #646A7A`, `--color-line #E4E4EC`, `--color-ok #0F9F6E`. Fonte Plus Jakarta Sans via `next/font/google` (títulos 700, tracking −0,02em).
- [ ] **Step 2: Seções** (mesma ordem da Cashyin): Header (âncoras + Entrar + Começar; menu hambúrguer no celular) → Hero (título sobre receber Pix nas vendas digitais, mock do painel com abas Cobrança/Extrato/Saque que reage ao scroll, mas legível no celular) → faixa Marquee com **segmentos** (Cursos, Mentorias, E-books, Comunidades, SaaS, Eventos online), sem logos de cliente → Fatos (contadores de fatos do produto, não de volume: `0` mensalidade, `D+0` liquidação, `7` tentativas de webhook, `2FA` obrigatório) → Recursos (6 cards, cada um com uma micro-animação: Gauge de tracinhos SVG, LineChart com `pathLength`, etc.) → Dev (trecho de `POST /charges` + card de webhook "ao vivo" com o JSON real do evento `charge.paid` e o header `X-Vantri-Signature`) → Preços (um plano "Pague pelo uso": 1,49% por Pix recebido, R$ 1,00 por Pix enviado, sem mensalidade, sem setup) → FAQ (`<details>`, o mesmo array gera o JSON-LD FAQPage; inclui "A Vantri é um banco?" respondendo com o aviso RC 16, e "Atendem apostas?" → "Não.") → CTA final → Footer (aviso RC 16 exato, razão social e CNPJ das env, links Termos/Privacidade/Docs/Entrar, nenhum link `#`).
- [ ] **Step 3: Animações:** `motion/react`; contadores com `useInView({ once: true, amount: 0.3 })` (**sem margem negativa** — bug da Cashyin); `useReducedMotion()` → valores finais, sem movimento; conteúdo visível sem JS (o reveal só esconde depois da hidratação, via classe colocada no `useEffect`); imagens só SVG/CSS (nada de PNG de 1 MB, nada de tsParticles).
- [ ] **Step 4: SEO:** `metadataBase = new URL(NEXT_PUBLIC_SITE_URL)`, title/description, OG image gerada em `opengraph-image.tsx`, JSON-LD só `Organization` (sem `aggregateRating`) e `FAQPage`, `app/sitemap.ts` e `app/robots.ts` com URLs absolutas.
- [ ] **Step 5:** Termos de uso e Política de privacidade (LGPD) em PT, com o aviso RC 16, proibição de apostas e jogos de azar, regras de MED e uma nota no topo: "Modelo inicial — revisar com advogado antes de operar."
- [ ] **Step 6:** `npx next build` limpo; abrir no Playwright em 1440 e 390 px: menu mobile abre, contadores chegam ao valor final nas duas larguras, sem rolagem horizontal.
- [ ] **Step 7:** Commit `feat(site): vitrine vantri, marca e páginas legais`.

---

### Task 18: Banco, deploy, cron, checklist e prova final

**Files:**
- Create: `scripts/deploy.sh`, `README.md` (como rodar, variáveis, deploy, como plugar o parceiro real)

- [ ] **Step 1: Banco:** criar projeto Supabase gratuito pelo MCP (conferir custo com `get_cost` antes; custo ≠ 0 → parar e avisar). Aplicar `drizzle/*.sql` pelo MCP `apply_migration`. Ligar RLS em **todas** as tabelas sem policy (o app conecta como `postgres` pelo pooler e ignora RLS; a chave anon não lê nada) e conferir com `get_advisors` = zero alertas de RLS. `DATABASE_URL` = pooler de transação (porta 6543). Se a senha do banco não puder ser obtida pelas ferramentas, pedir ao Lenda que cole a string de conexão em `vercel env add DATABASE_URL production` — única ação dele.
- [ ] **Step 2: Vercel:** `vercel link` (projeto novo `vantri`), `vercel env add` para cada variável (gerar `APP_ENCRYPTION_KEY`, `CRON_SECRET` e `SIMULATOR_WEBHOOK_SECRET` com `openssl rand -base64 32`; `PIX_PROVIDER=simulator`; `NEXT_PUBLIC_SITE_URL` = URL do deploy). `scripts/deploy.sh` = `vercel deploy --prod --yes` (único jeito de publicar este projeto).
- [ ] **Step 3: Cron por minuto:** no servidor do Lenda (`ssh servidor`), uma linha no crontab: `* * * * * curl -fsS -m 25 -H "Authorization: Bearer <CRON_SECRET>" https://<url>/api/cron/tick > /dev/null`. Conferir com `crontab -l`.
- [ ] **Step 4: Admin:** `DATABASE_URL=... npm run seed:admin -- sanches925@gmail.com` → guardar a senha temporária para entregar ao Lenda.
- [ ] **Step 5: Teste de corrida ao vivo:** script único contra o Postgres real: lojista com saldo para 1 saque, `Promise.all` de 5 `createPayout` com chaves de idempotência diferentes → exatamente 1 `processing/completed`, 4 `insufficient_balance`, saldo nunca negativo. Mostrar a saída.
- [ ] **Step 6: Checklist de lançamento** (`~/.claude/skills/lenda-strategy/references/checklist-lancamento.md`): os 20 itens com `arquivo:linha` ou "não se aplica porque X". Headers conferidos ao vivo com `curl -sI` na home, `/painel` e `/api/v1/balance`. `npm audit --omit=dev` e o plugin `supply-chain-risk-auditor`.
- [ ] **Step 7: Playwright como usuário NOVO** (contexto limpo): vitrine em 1440 e 390 → cadastro novo → admin aprova → lojista entra, configura 2FA → cria cobrança → "Simular pagamento" → saldo sobe → cria chave de API → `curl` cria cobrança pela API → cadastra webhook (https://webhook.site) → simula pagamento → entrega aparece "entregue" → saque com 2FA → extrato e CSV → admin abre MED de teste → lojista envia defesa com PDF → admin encerra. Prints de cada passo.
- [ ] **Step 8:** `/code-review` no branch inteiro; corrigir ou justificar cada achado.
- [ ] **Step 9:** Commit final e memória do projeto (`project-vantri-gateway.md`: URL, deploy só por `scripts/deploy.sh`, admin, cron no servidor, plano 2 = parceiro real).

---

## Ondas de execução

| Onda | Tasks (paralelas dentro da onda) | Depende de |
|---|---|---|
| A | 1 | — |
| B | 2 · 3 · 5 · 17 | A |
| C | 4 · 6 · 7 · 11 | 2 (6 também 3 e 5; 7 e 11 também 3) |
| D | 8 · 9 · 10 | 4, 5, 6, 11 |
| E | 12 · 13 · 14 | 7–11 |
| F | 15 · 16 | 12, 14 |
| G | 18 | todas |

## Plano 2 (fora deste plano)

Adaptador do parceiro real em `lib/provider/<parceiro>.ts` implementando `PixProvider`, a partir da documentação oficial dele, assim que o Lenda disser o nome. Troca é `PIX_PROVIDER=<parceiro>` + credenciais na Vercel.
