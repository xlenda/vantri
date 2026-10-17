# Vantri Fase 2 — Painel do Lojista (Plano A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar o **interior do painel do lojista** (`app/painel/**` + `app/conta/**`) no nível de um gateway de verdade — Início rico, Extrato que fecha conta, Transações com detalhe e comprovante, assistente de saque com parcelamento persistido, webhooks completos com inspetor e "testar envio", allowlist CIDR, busca por identificador e a área de conta/segurança — **por cima** dos serviços da fase 1, sem reescrevê-los. Tudo contra o simulador; o que depende do parceiro real fica marcado "requer parceiro".

**Architecture:** O motor já existe e é a fonte única de verdade: serviços puros em `lib/services/*` + `lib/money/ledger.ts`, guardas em `lib/auth/*`, webhooks em `lib/webhooks/*`, API em `lib/api/*`. A fase 2 **adiciona** funções a esses serviços (nunca duplica dinheiro nem fala com o banco por fora) e telas em `app/painel`/`app/conta` que as consomem via Server Actions e Route Handlers. Toda página/ação/rota do painel chama `painelSession()` (que é `requireUser({ role: "merchant" })` estreitado) e deriva `merchant.id` da sessão. Mudanças de schema são aditivas e com RLS ligado.

**Tech Stack (já instalado — não adicionar dependência sem necessidade):** next@15.5.28 (App Router, Server Actions, `after`), react 19 (`useActionState`), typescript, tailwindcss 4, drizzle-orm 0.45 + drizzle-kit 0.31, postgres-js 3.4 (prod) / @electric-sql/pglite 0.5 (testes), zod 4, otplib 13, @node-rs/argon2 2, qrcode 1.5, vitest 5. **XLSX:** nova dependência `exceljs` (streaming, zero deps nativas) — ver Task M-EXPORT; nenhuma outra dependência nova.

**Specs:** `docs/superpowers/specs/2026-10-17-vantri-fase2-design.md` (Plano A) · `docs/superpowers/specs/2026-10-17-paridade-cashyin.md` (Parte 1 = telas Cashyin, fonte de campos/colunas/fluxos; Parte 2 = lacunas com tamanho P/M/G).

---

## Global Constraints

Valem para **toda** tela, ação e rota desta fase. Repetem e estendem as constraints da fase 1 (dinheiro em centavos, zod estrito no limite, PT-BR, aviso RC 16, sem apostas).

- **Papel no servidor, sempre.** Toda página, Server Action e Route Handler do painel começa por `painelSession()` (de `app/painel/lib.ts`), que é `requireUser({ role: "merchant" })` + `notFound()` se faltar merchant. As telas de conta (`/conta/2fa`, `/conta/senha`, e a nova área `/painel/conta`) usam `accessSession()` quando não podem redirecionar para si mesmas. **Esconder botão não é segurança**: a ação re-checa. Não copiar o defeito da Cashyin (papel só no front; viewer que transfere).
- **IDOR impossível.** Todo id que entra por formulário/URL/rota vai para um serviço que filtra por `merchant.id` da sessão (`getCharge(merchantId, id)`, `getPayout(merchantId, id)`, `getMedCase(merchantId, id)`, `getMedFile(fileId, { role, merchantId })`, `resendDelivery(merchantId, id)`, `deleteEndpoint(merchantId, id)`). Id de outro lojista → `null`/`not_found`, **nunca** o dado. `merchantId` **jamais** vem do formulário. Funções novas que tomam id seguem o mesmo contrato (devolvem `null`/`not_found` para id de outro dono, e validam o formato UUID antes de consultar).
- **Sincronia (um número só).** Todo valor de dinheiro é lido pelos serviços/razão existentes: `getBalance(merchantId, tx?)`, `listStatement`, `listCharges`, `listPayouts`, `listMedCases`. Nenhuma tela soma centavos por conta própria fora de um serviço. Agregados novos (resumo de período, saldo corrido, Fecho Diário, saúde de webhook) moram em **funções de serviço** com teste, não em queries soltas na página.
- **Sem float.** Inteiros em centavos em DB, serviço, JSON e CSV/XLSX. Exibição por `brl()` (de `lib/br/money.ts`); leitura de reais por `parseReais()` (devolve `null` em ambíguo). Percentual com `feeText()`. Nada de `parseFloat` em valor.
- **PT-BR.** Toda interface, aviso e mensagem de erro em português do Brasil. Mensagens de erro de negócio vêm do serviço (já em PT, sem dado interno); a tela nunca inventa texto técnico. Datas no fuso America/Sao_Paulo (`dateTime()`), dia civil por `diaBrasilia()`.
- **Mobile 390 px, sem rolagem horizontal.** Todo layout funciona a 390 px. `Table` já rola dentro da própria caixa (`overflow-x-auto`), sem empurrar a página; o menu (`PainelNav`) já vira faixa rolável no topo. Painel de detalhe/assistente a largura total no celular. Verificar no Playwright a 390 px (Task M-VERIFY). Não copiar o defeito da Cashyin (sem menu no celular).
- **Schema aditivo + RLS.** Toda coluna/tabela nova é **aditiva** (nada removido/renomeado), com default seguro, numa migração gerada por `drizzle-kit generate`. Toda tabela nova entra na lista de RLS ligado (Task M-DB). O app conecta como `postgres` (ignora RLS); a chave anon não lê nada. `get_advisors` = zero alertas de RLS.
- **`logError`, nunca erro cru.** Todo `catch` que loga usa `logError(context, err, ids)` (de `lib/log.ts`): só contexto + ids, nunca a mensagem crua (que traz chave Pix, nome do pagador, params da query). Nenhum `console.error(err)` com o objeto inteiro, nenhum erro de servidor exibido ao usuário. Toasts/avisos ao lojista são categorias/textos em PT. Não copiar o defeito da Cashyin (erro cru no toast).
- **Não copiar os defeitos da Cashyin** (mapa §1.17): sem menu no celular; filtros/KPIs só da página carregada (os nossos agregados são do **período inteiro**, no servidor); retomada de lote só na memória (a nossa **persiste no banco**); erro cru; papel só no front; `http://`/IP interno em webhook (o `webhookUrlProblem` já barra); status desconhecido virando sucesso; checagem de saldo sem a tarifa (o `createPayout` já soma a tarifa).
- **2FA anti-replay compartilhado.** O 2FA sensível é **um só mecanismo**: `verifyUserTotp(userId, code)` (de `lib/auth/session.ts`), que consome o passo (RFC 6238 §5.2) e tem limite por usuário. No painel, toda porta sensível (saque, lote de saque, criar chave de API, reconfigurar 2FA) passa por `freshTotpProblem(user.id, fd)` (de `app/painel/lib.ts`), que chama `verifyUserTotp`. **Nenhuma porta nova pode ter o seu próprio caminho de TOTP** que escape do consumo de passo — senão um código serviria para duas ações. A ordem é sempre: validar formato dos campos (erro aqui **não** gasta o código) → `freshTotpProblem` → efeito.
- **"requer parceiro" (plano 2) é construído contra o simulador e marcado.** Features que dependem do parceiro Pix real são feitas como tela+serviço com o simulador e **marcadas na UI** ("requer parceiro de Pix") onde o dado real não existe, sem fingir. Lista (ver Parte 2.5 do mapa): consulta **DICT** do favorecido (nome/ISPB no passo Revisão), Pix **devolvido** (`returned`) e seu estorno, **devolução de cobrança** (`refunded`), **limites reais** (diário/mensal/noturno e teto por transferência que define se o parcelamento liga de fato), **dados bancários no comprovante** (nome/instituição do favorecido), tipo de fraude/relato/ISPB do MED. Nesta fase: limites usam um default configurável; comprovante mostra só o que temos (sem dado pessoal do favorecido); parcelamento usa teto configurável com default.
- **Execução em ondas paralelas (ver fim):** agentes paralelos **não** commitam; o orquestrador commita ao fim de cada onda. Tasks paralelas tocam arquivos **disjuntos**. O único arquivo compartilhado pesado (`lib/db/schema.ts`) tem a migração feita numa única task inicial (M-DB); ninguém mais edita o schema.

## Review Focus

Alvos de revisão desta fase (além dos da fase 1, que continuam valendo):

1. **IDOR em toda ação/rota nova que toma id.** Comprovante de saque, inspetor de entrega, arquivo, reenvio, editar/excluir/testar webhook, novo segredo, editar allowlist, retomar lote, detalhe de transação. Teste por mutação: lojista B pede o id de A → `null`/`not_found`/404, nunca o dado. Rota pública `/comprovante/[codigo]` não aceita id direto, só o código HMAC, e não vaza dado pessoal.
2. **2FA anti-replay compartilhado.** A porta nova do saque parcelado e a de reconfigurar 2FA **não** podem bypassar o consumo de passo que o saque simples usa. Teste: um código TOTP aceito numa porta é recusado na outra no mesmo passo de 30 s. Reconfigurar 2FA exige o código **atual** (não religa sem ele).
3. **Webhook "testar envio" não é SSRF.** O envio de teste reusa **o mesmo caminho** do `dispatchDue` (que resolve o DNS e checa cada IP com `isBlockedAddress`, `redirect: "manual"`, timeout). Não existe um `fetch` novo para a URL do endpoint fora desse caminho. O endpoint já foi validado por `webhookUrlProblem` na criação/edição; a edição **re-valida** a URL. Teste: endpoint cujo DNS resolve para IP interno não recebe o teste.
4. **Injeção em CSV e XLSX.** CSV reusa `csvCell` (apóstrofo em célula que começa com `= + - @ tab CR`). XLSX: toda célula de texto que começa com esses caracteres recebe o mesmo tratamento (ou é escrita como texto com prefixo), e números vão como número. Teste: external_ref `=1+1` e nome `@cmd` saem neutralizados nos dois formatos.
5. **Invariantes de dinheiro do saque parcelado.** Nenhuma parcela debita sem saldo (cada `createPayout` da parcela re-checa saldo dentro da transação com `lockMerchant`); a soma das parcelas nunca ultrapassa o saldo disponível no momento; retomar um lote **não** paga parcela já concluída duas vezes (chave de idempotência por parcela `${batchId}:${index}`); o total do lote = soma das parcelas (divisão gulosa em centavos inteiros, sem arredondamento). Teste por mutação: retomar duas vezes o mesmo lote não cria parcela duplicada; falha no meio deixa o estado retomável e consistente.
6. **Saldo corrido e Fecho Diário batem com o razão.** O "Saldo após" de cada linha do extrato e o fechamento de cada dia conferem com `getBalance` no corte. Teste: soma dos lançamentos até a data X = saldo de fecho do dia X.

---

## File Structure (novos e modificados nesta fase)

```
vantri/
  lib/
    db/schema.ts                          # MOD (M-DB): payout_batches, webhook_attempts, med_events,
                                          #   webhook_endpoints.description, payouts.batch_id/batch_index,
                                          #   charges índices E2E, api_keys CIDR (ip_allowlist já é text[])
    services/
      summary.ts                          # NEW: resumo de período + série diária (Início e Extrato)
      search.ts                           # NEW: busca por E2E/TxID/ref/nome em charges+payouts
      statement-extra.ts                  # NEW: saldo corrido + Fecho Diário (serve CSV/XLSX)
      payout-batches.ts                   # NEW: saque parcelado persistido (greedy, idempotente, retomável)
      webhooks-admin.ts                   # NEW: update/toggle/rotateSecret/testSend/health/listDeliveries filtrados
      api-key-ips.ts                      # NEW: CIDR na allowlist + checkIp ("testar IP")
      sessions.ts                         # NEW: listar e revogar sessões do próprio usuário
      receipt.ts                          # NEW: código de autenticação do comprovante (HMAC) + verificação
    webhooks/
      sign.ts, dispatch.ts, ssrf.ts       # MOD (leve): extrair uma função de envio reusável p/ test-send
      attempts.ts                         # NEW: gravar tentativa (n, status, latência, erro, trecho da resposta)
    money/fees.ts, money/ledger.ts        # (sem mudança)
    export/xlsx.ts                        # NEW: helper XLSX com proteção de injeção (exceljs)
  app/
    painel/
      lib.ts                              # MOD: helpers de período, saldo oculto, labels de falha
      layout.tsx                          # MOD: card de saldo + "Ocultar saldos" + link "Conta"
      balance-toggle.tsx                  # NEW (client): botão olho (localStorage + classe no <html>)
      page.tsx                            # MOD: Início rico (período, KPIs, fluxo, alertas, limites)
      fluxo-chart.tsx                     # NEW: SVG de duas séries (entradas × saídas)
      extrato/page.tsx                    # MOD: cards, filtros, saldo corrido, Fecho Diário, XLSX
      extrato/csv/route.ts                # MOD: filtro por tipo
      extrato/xlsx/route.ts               # NEW: export XLSX (extrato e Fecho Diário)
      transacoes/page.tsx                 # NEW: lista unificada + detalhe lateral (abas)
      transacoes/detail.tsx               # NEW (client): abas do detalhe
      saques/page.tsx                     # MOD: lista com abas/busca/contadores de verdade + link detalhe
      saques/[id]/page.tsx                # NEW: detalhe do saque (abas) + link comprovante
      saques/[id]/comprovante/page.tsx    # NEW: comprovante imprimível (@media print)
      saques/novo/page.tsx                # NEW: assistente de saque (4 passos)
      saques/novo/wizard.tsx              # NEW (client): stepper Dados→Revisão→Verificação→Confirmação
      saques/actions.ts                   # MOD: previewPayout + createBatchPayout + resumeBatch
      integracoes/page.tsx                # MOD: abas (?aba=), saúde, KPIs 24h
      integracoes/webhooks/*              # NEW: criar/editar/excluir/toggle/novo-segredo/testar
      integracoes/entregas/page.tsx       # NEW: inspetor — lista filtrada + KPIs
      integracoes/entregas/[id]/page.tsx  # NEW: inspetor de uma entrega + "Baixar JSON"
      integracoes/entregas/[id]/json/route.ts  # NEW: download do JSON da entrega
      integracoes/seguranca/*             # NEW: allowlist CIDR + "testar IP" por chave
      integracoes/actions.ts              # MOD: ações de webhook/allowlist
      conta/page.tsx                      # NEW: Minha conta (dados, senha, 2FA, sessões, parceiro)
      conta/actions.ts                    # NEW: reset 2FA, revogar sessão
      busca/page.tsx                      # NEW (ou embutido no header): busca por identificador
    comprovante/[codigo]/page.tsx         # NEW: verificação pública do comprovante (sem dado pessoal)
    conta/2fa/*, conta/senha/*            # (reaproveitados; reset de 2FA logado é novo fluxo em /painel/conta)
  tests/
    summary.test.ts, search.test.ts, statement-extra.test.ts, payout-batches.test.ts,
    webhooks-admin.test.ts, api-key-ips.test.ts, sessions.test.ts, receipt.test.ts,
    webhook-attempts.test.ts, xlsx.test.ts
```

Nomenclatura: rotas e textos em PT; nomes de função/coluna seguem o padrão do repo (camelCase TS, snake_case DB, JSON público em snake_case via os `toXxxJson` existentes).

---

## Tasks

Cada task: **Files** (criar/modificar/testar), **Interfaces** (consome/produz, com assinaturas reais), **TDD steps**. Serviços puros seguem TDD (teste falha → implementa → passa); telas seguem build/tsc + verificação visual na Task M-VERIFY (não dá para fazer TDD de JSX, então a prova é `next build` + `tsc --noEmit` + Playwright no fim).

---

### Task M-DB: Migração aditiva + RLS (única dona do schema)

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (via `npx drizzle-kit generate`), `tests/schema-fase2.test.ts`

**Interfaces — tabelas/colunas novas (nomes exatos; as outras tasks dependem disto):**
- `payout_batches`: `id uuid pk`, `merchant_id` FK merchants, `total_cents int`, `chunk_cents int` (teto por parcela no momento), `count int` (nº de parcelas), `pix_key text`, `pix_key_type` (mesmo enum de payouts), `description text null`, `status text enum ['processing'|'completed'|'partial'|'failed']`, `failed_at_index int null` (índice da 1ª parcela que falhou; `null` = nenhuma falhou ainda), `idempotency_key text`, `request_hash text`, `created_at`; `unique(merchant_id, idempotency_key)`.
- `payouts` (MOD, aditivo): `batch_id uuid null` FK payout_batches, `batch_index int null`. Saque avulso = os dois `null`. A chave de idempotência de cada parcela é `${batch_id}:${batch_index}` em `payouts.idempotency_key` (reusa o `unique(merchant_id, idempotency_key)` já existente para impedir parcela dupla).
- `webhook_endpoints` (MOD, aditivo): `description text null` (nome do endpoint no painel).
- `webhook_attempts`: `id uuid pk`, `delivery_id` FK webhook_deliveries ON DELETE CASCADE, `n int` (nº da tentativa, 1-based), `status_code int null`, `latency_ms int null`, `error text null` (só categoria), `response_snippet text null` (≤ 1 KB, trecho da resposta), `created_at`; índice em `delivery_id`.
- `med_events`: `id uuid pk`, `med_case_id` FK med_cases ON DELETE CASCADE, `type text enum ['opened'|'defense_submitted'|'closed_merchant_won'|'closed_payer_refunded']`, `meta jsonb default {}`, `created_at`; índice em `med_case_id`. (Linha do tempo do MED; gravado em `applyMedOpened`/`submitDefense`/`applyMedClosed` — ver Task M-MED-TIMELINE.)
- `charges` (MOD): índice em `(merchant_id, end_to_end_id)` e índice em `(merchant_id, txid)` e `(merchant_id, external_ref)` já existe (unique) — para a busca. `pg_trgm` em `payer_name` **não** entra agora (ponytail: só se o volume pedir; busca por nome usa `ILIKE` com prefixo).
- `api_keys`: **sem mudança de schema** — `ip_allowlist text[]` já existe e passa a guardar CIDRs; a descrição por IP e o CIDR entram na validação de serviço (Task M-ALLOWLIST), não em coluna nova. (ponytail: não criar tabela `api_key_ips`; `text[]` de CIDRs basta e o serviço valida formato e prefixo.)

- [ ] **Step 1: Teste** `tests/schema-fase2.test.ts`:
  - `it('rejects duplicate batch idempotency_key per merchant')` → 2 `payout_batches` mesmo merchant/idempotency_key → unique.
  - `it('allows null batch_id on standalone payout')` → insere payout sem batch → ok.
  - `it('cascades webhook_attempts on delivery delete')` → apaga delivery → attempts somem.
  - `it('cascades med_events on case delete')`.
- [ ] **Step 2:** rodar → FAIL. **Step 3:** escrever as tabelas/colunas em `schema.ts` (enums como `text({ enum: [...] })`, FKs e índices como no arquivo atual), `npx drizzle-kit generate`. **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat(db): schema aditivo da fase 2 (lotes de saque, tentativas de webhook, eventos de med)`.

---

### Task M-SUMMARY: Serviço de resumo de período (Início + Extrato)

**Files:**
- Create: `lib/services/summary.ts`, `tests/summary.test.ts`

**Interfaces:**
- Consumes: `db()`, `ledgerEntries` (Task 2 fase 1), `diaBrasilia`.
- Produces:
  - `periodSummary(merchantId: string, fromDay: string, toDay: string): Promise<{ inflowCents: number; inflowCount: number; outflowCents: number; outflowCount: number; feeInCents: number; feeOutCents: number; resultCents: number }>` — soma o razão entre `fromDay 00:00 -03:00` e `toDay+1 00:00 -03:00`. `inflow` = soma de `cash_in`; `outflow` = soma dos `cash_out` (valor absoluto); contagens por `kind`; `result = inflow - outflow`. Dias em AAAA-MM-DD Brasília.
  - `dailyFlow(merchantId, fromDay, toDay): Promise<Array<{ day: string; inflowCents: number; outflowCents: number }>>` — uma linha por dia civil de Brasília com movimento (para o gráfico de fluxo). Dia por `to_char((created_at at time zone 'UTC') - interval '3 hours', 'YYYY-MM-DD')` (o mesmo truque já usado em `page.tsx`).
  - `previousPeriod(fromDay, toDay): { fromDay: string; toDay: string }` — janela de **mesma duração** que termina 1 dia antes de `fromDay` (regra do mapa §1.4). Puro, testável sem banco.
  - `pctDelta(current: number, previous: number): number | null` — `(current-previous)/previous`, `null` se `previous <= 0` (oculta o delta).

- [ ] **Step 1: Testes:**
  - `periodSummary sums inflow/outflow/fees and counts` (monta razão: cash_in +10000 ×2, fee_in −149 ×2, cash_out −5000, fee_out −100 → inflow 20000/n2, outflow 5000/n1, feeIn 298, feeOut 100, result 15000).
  - `periodSummary respects Brasília day boundary` (lançamento às 02:00 UTC do dia seguinte conta no dia anterior em BRT).
  - `dailyFlow returns one row per day with movement`.
  - `previousPeriod of 1–16 is previous 16 days ending day before` (puro).
  - `pctDelta null when previous <= 0`; `pctDelta(112,100)===0.12`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(summary): resumo de período e série de fluxo sobre o razão`.

---

### Task M-SEARCH: Busca por E2E/TxID/referência/nome

**Files:**
- Create: `lib/services/search.ts`, `tests/search.test.ts`

**Interfaces:**
- Consumes: `db()`, `charges`, `payouts` (índices da Task M-DB).
- Produces:
  - `searchTransactions(merchantId: string, term: string, limit = 20): Promise<{ charges: ChargeRow[]; payouts: PayoutRow[] }>` — filtra **sempre por `merchant_id`** da sessão; cobre `charges` (`txid`, `external_ref`, `end_to_end_id` exatos; `payer_name` por `ILIKE term%`) e `payouts` (`id`, `end_to_end_id`, `pix_key` exatos). `term` aparado, mínimo 2 chars (senão devolve vazio). Sem período (histórico inteiro — a força da Cashyin, §0.2). `limit` 1–50. Reusa `chargeAsOf(c, now)` para o status exibido. **Não** usa termo sem dígito para casar documento (evita o bug da Cashyin §1.17.10).

- [ ] **Step 1: Testes:**
  - `finds charge by exact E2E and by txid`; `finds charge by payer_name prefix` ("mar" acha "Maria", não acha "Ana").
  - `finds payout by pix_key and by e2e`.
  - `never returns other merchant's rows` (mesmo E2E em dois lojistas → só o da sessão).
  - `term shorter than 2 chars returns empty`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(search): busca por E2E/TxID/referência/nome escopada ao lojista`.

---

### Task M-STATEMENT-EXTRA: Saldo corrido + Fecho Diário

**Files:**
- Create: `lib/services/statement-extra.ts`, `tests/statement-extra.test.ts`

**Interfaces:**
- Consumes: `db()`, `ledgerEntries`, `getBalance`.
- Produces:
  - `listStatementWithBalance(merchantId, query): Promise<{ data: Array<LedgerRow & { balanceAfter: number | null }>; nextCursor: string | null }>` — envelopa o padrão do `listStatement` existente, mas acrescenta o **saldo corrido** do bucket `available` após cada lançamento, com uma só consulta extra: `sum(amount_cents) filter (where bucket='available') over (order by created_at, id)` + o saldo anterior à página. Quando há filtro de `kind`/`direction`, `balanceAfter = null` (saldo corrido só é calculável sobre a conta inteira — regra do mapa §1.6, feita honesta: a coluna mostra "—", nunca um número errado). Aceita `kind?: LedgerKind[]`, `direction?: 'in'|'out'`, `minCents?`, `maxCents?` (filtro de valor **no servidor**, não na página como a Cashyin), além de `from/to/limit/cursor`.
  - `dailyClosing(merchantId, fromDay, toDay): Promise<Array<{ day: string; openingCents: number; inflowCents: number; outflowCents: number; feeCents: number; medCents: number; closingCents: number }>>` — `generate_series` dos dias de Brasília + soma acumulada; série **contínua** (dia sem movimento repete o fechamento anterior). **Melhor que a Cashyin** (que só mostra o fechamento): abertura, entradas, saídas, tarifas, MED e fechamento. Período máximo 366 dias (reusa o limite do `listStatement`).

- [ ] **Step 1: Testes:**
  - `balanceAfter matches getBalance at each cut` (3 lançamentos; saldo após o 2º = soma dos dois primeiros).
  - `balanceAfter is null when kind filter active`.
  - `filters by direction/kind/value range on the server`.
  - `dailyClosing is continuous` (dia sem movimento repete o fechamento); `closing of day = opening + inflow - outflow - fee ± med`.
  - `dailyClosing rejects period > 366 days`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(extrato): saldo corrido e fecho diário sobre o razão`.

---

### Task M-XLSX: Helper de exportação XLSX com proteção de injeção

**Files:**
- Create: `lib/export/xlsx.ts`, `tests/xlsx.test.ts`
- Modify: `package.json` (add `exceljs`)

**Interfaces:**
- Consumes: `exceljs` (streaming workbook).
- Produces:
  - `buildXlsx(sheetName: string, header: string[], rows: Array<Array<string | number>>): Promise<Buffer>` — monta uma planilha. **Proteção de injeção:** toda célula de **texto** que começa com `= + - @ \t \r` recebe apóstrofo na frente (mesma regra do `csvCell`); número vai como número (soma no Excel). Header como texto. Nome do sheet aparado para ≤ 31 chars (limite do Excel).
  - `XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'`.
  - ponytail: `exceljs` em vez de escrever OOXML à mão — 1 dependência JS pura, sem binário nativo (não quebra na Vercel). O CSV com BOM já abre no Excel; o XLSX é o "formato bonito" que o contador pede (mapa §2.3.5).

- [ ] **Step 1: Testes:**
  - `cell starting with = + - @ is prefixed with apostrophe`; `number stays number`.
  - `buildXlsx produces a valid zip (PK header)` e reabre com `exceljs` devolvendo as mesmas linhas.
  - `sheet name truncated to 31 chars`.
- [ ] **Step 2:** FAIL. **Step 3:** `npm i exceljs`, implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(export): helper xlsx com proteção contra injeção de fórmula`.

---

### Task M-BATCH: Saque parcelado persistido (greedy, idempotente, retomável)

**Files:**
- Create: `lib/services/payout-batches.ts`, `tests/payout-batches.test.ts`

**Interfaces:**
- Consumes: `createPayout` (fase 1, **reusado como está** para cada parcela), `getBalance`, `lockMerchant`, `getProvider`, `computeFee`, `sha256Hex`, `payoutBatches`/`payouts` (Task M-DB), `emit`.
- Produces:
  - `DEFAULT_PAYOUT_CEILING_CENTS = 1_500_000` e `payoutCeilingCents(): number` — lê `PAYOUT_CEILING_CENTS` do env (default R$ 15.000). **requer parceiro** para o valor real; marcar na UI. Teto configurável sem código.
  - `splitGreedy(totalCents: number, ceilingCents: number): number[]` — divisão gulosa: parcelas cheias do teto, resto na última; centavos inteiros, sem arredondamento. `splitGreedy(4_000_000, 1_500_000) = [1_500_000, 1_500_000, 1_000_000]`; `splitGreedy(1_500_001, 1_500_000) = [1_500_000, 1]`. Puro.
  - `needsBatch(amountCents, ceilingCents): boolean` — `amountCents > ceilingCents` (teto exato é saque só — regra §1.7).
  - `createBatchPayout(merchantId, input, idempotencyKey): Promise<BatchResult>` — valida chave/valor/tarifa como o `createPayout` (reusa `pixKeyProblem`); `requestHash = sha256Hex(JSON canônico)`; cria `payout_batches` (status `processing`) idempotente por `(merchant_id, idempotency_key)` (replay devolve o lote existente). **Pré-checagem de saldo do lote inteiro** dentro de uma transação com `lockMerchant`: `available >= total + somaDasTarifas` (a tarifa de cada parcela é `computeFee(parcela, feeOutBps, feeOutFixedCents)`) senão `PayoutBatchError('insufficient_balance')` e nada é criado. Depois envia as parcelas **em sequência**, cada uma via `createPayout(merchantId, { amount: parcela, pix_key, pix_key_type, description }, \`${batchId}:${i}\`)` — reusando toda a trava/idempotência/estorno do saque avulso. **Para na primeira falha**, grava `failed_at_index = i`, status `partial`, e devolve `{ batchId, status, chunks: [{ index, amountCents, payoutId, status }] }`. Tudo que já passou fica persistido.
  - `resumeBatch(merchantId, batchId, idempotencyKeyUnused?): Promise<BatchResult>` — só do próprio lojista (id de outro → `not_found`); só lote `partial`; retoma a partir de `failed_at_index`, reusando a **mesma** chave de idempotência por parcela `${batchId}:${index}` (parcela já concluída → `createPayout` devolve `replayed`, **não paga de novo**); re-checa saldo do restante na transação. Atualiza `status` para `completed` (todas concluídas) ou `partial`/`failed`. **A retomada vive no banco** (lote + índice persistidos) — o que a Cashyin não faz (§1.7.8, §1.17.3).
  - `getBatch(merchantId, batchId)`, `listBatchPayouts(merchantId, batchId)` — para a tela.
  - `PayoutBatchError(code: 'invalid_request'|'idempotency_conflict'|'insufficient_balance'|'not_found'|'invalid_status', msg)`.

- [ ] **Step 1: Testes (contra PGlite, com simulador):**
  - `splitGreedy` casos acima (puro); `needsBatch` teto exato = false, teto+1 = true.
  - `createBatchPayout debits every chunk and sums to total` (saldo p/ 3 parcelas; total + tarifas debitados; 3 payouts com `batch_index` 0..2).
  - `insufficient balance for the whole batch writes nothing` (saldo p/ 2 de 3 parcelas → `insufficient_balance`, zero payouts, zero batch efetivo).
  - `one failing chunk stops and persists resume point` (parcela 2 com `pix_key=falha@teste.com` → status `partial`, `failed_at_index=1`, parcela 0 concluída e persistida).
  - `resume does not double-pay completed chunks` (retomar o lote acima: parcela 0 fica `replayed`, não cria novo payout; saldo não debita de novo).
  - `resume twice is idempotent` (retomar duas vezes → nenhuma parcela duplicada; conferir contagem de payouts do lote).
  - `batch of other merchant → not_found`.
  - `2FA is not consumed here` — o consumo do código é da action (Task M-SAQUE), não do serviço; o serviço não vê TOTP.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(payouts): saque parcelado persistido com retomada idempotente`.

---

### Task M-WEBHOOK-ATTEMPTS: Gravar tentativas de entrega + envio reusável

**Files:**
- Create: `lib/webhooks/attempts.ts`, `tests/webhook-attempts.test.ts`
- Modify: `lib/webhooks/dispatch.ts` (gravar uma `webhook_attempts` por tentativa; extrair `sendOne(delivery)` reusável), `lib/webhooks/sign.ts`/`ssrf.ts` (sem mudança de contrato)

**Interfaces:**
- Consumes: `webhookAttempts` (Task M-DB), o `attempt()` interno do `dispatch.ts`.
- Produces:
  - Em `dispatch.ts`: ao final de cada `attempt`, gravar `webhook_attempts` `{ deliveryId, n: attempts, statusCode, latencyMs, error, responseSnippet }`. `latencyMs` = tempo do `fetch` (medir com `performance.now()`); `responseSnippet` = primeiros ≤ 1024 chars do corpo da resposta (hoje o corpo é cancelado — passar a **ler** até 1 KB e depois cancelar; nunca guardar o segredo nem headers). Categoria de erro continua vindo de `errorCategory` (nunca mensagem crua).
  - Exportar `sendTestDelivery(endpointId, merchantId): Promise<{ delivered: boolean; statusCode: number | null; error: string | null }>` — enfileira **uma** entrega `test.ping` (payload `{ id:'evt_test_…', type:'webhook.test', created_at, data:{ test:true } }`) **só** para aquele endpoint do lojista e chama o **mesmo** caminho de envio (`attempt`/`sendOne`, que resolve DNS + `isBlockedAddress` + `redirect:'manual'` + timeout). **Não** cria `fetch` novo fora desse caminho (Review Focus 3). `webhook.test` **não** entra em `WEBHOOK_EVENT_TYPES` nem é assinável (é um tipo interno só de teste).
  - `listDeliveries(merchantId, filters: { endpointId?, status?, from?, to?, term?, limit?, cursor? }): Promise<{ data; nextCursor }>` — para o inspetor; filtra por `merchant_id` (join em endpoints); `term` ≥ 8 chars procura o identificador no histórico inteiro ignorando período (reusa `searchTransactions`→ resolve delivery pelo `payload->data->id`/E2E) — ou, mais simples, procura `payload->>'id'` / `eventId`.
  - `getDeliveryForMerchant(merchantId, deliveryId): Promise<DeliveryWithAttempts | null>` — detalhe + lista de `webhook_attempts`, só do próprio lojista (id de outro → `null`).

- [ ] **Step 1: Testes:**
  - `each dispatch writes one webhook_attempts row with n, latency, category` (endpoint que recusa → 1 attempt com `error` categoria, sem mensagem crua).
  - `response_snippet is capped at 1KB and never contains the secret`.
  - `sendTestDelivery to a private-IP endpoint is blocked` (DNS resolve p/ 10.0.0.5 → `delivered:false`, `error` "endereço bloqueado"); reusa o mock `resolve` do teste de dispatch.
  - `sendTestDelivery of other merchant's endpoint → not_found`.
  - `getDeliveryForMerchant of other merchant → null`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(webhooks): tentativas persistidas, envio de teste reusando o guard de ssrf`.

---

### Task M-WEBHOOK-ADMIN: Gestão completa de webhook (serviço)

**Files:**
- Create: `lib/services/webhooks-admin.ts`, `tests/webhooks-admin.test.ts`
- (Depende de M-WEBHOOK-ATTEMPTS para `sendTestDelivery`/`listDeliveries`.)

**Interfaces:**
- Consumes: `webhookEndpoints`, `webhookUrlProblem` (SSRF), `encrypt`, `WEBHOOK_EVENT_TYPES`, `webhookDeliveries` (saúde).
- Produces (todas filtram por `merchantId`; id de outro → `not_found`):
  - `updateEndpoint(merchantId, id, { url, events, description }): Promise<void>` — **re-valida** a URL com `webhookUrlProblem` (Review Focus 3); dedup e valida eventos; sem efeito colateral no segredo.
  - `setEndpointActive(merchantId, id, active: boolean): Promise<void>` — liga/desliga (a coluna `active` já existe).
  - `rotateEndpointSecret(merchantId, id): Promise<{ secret: string }>` — gera `whsec_` novo, guarda cifrado, devolve **uma vez**. 1 segredo por endpoint — **sem** o bug de grupo da Cashyin (§1.17.12).
  - `endpointHealth(merchantId): Promise<Map<endpointId, { rate: number; sample: number; band: 'healthy'|'unstable'|'failing'|'nodata' }>>` — sobre as **últimas 100 entregas de cada endpoint**: `rate = delivered/(delivered+failed)`, pendentes não contam; faixas ≥0.95 saudável, ≥0.80 instável, <0.80 com falhas, sem amostra "sem dados" (regra §1.10).
  - `deliveryStats24h(merchantId): Promise<{ delivered: number; failed: number; avgLatencyMs: number | null; pending: number }>` — KPIs de 24 h.
  - (reexporta `createEndpoint`, `deleteEndpoint`, `resendDelivery` de `lib/services/events.ts` — já existem — para a tela importar de um lugar só, ou a tela importa dos dois; não duplicar lógica.)

- [ ] **Step 1: Testes:**
  - `updateEndpoint rejects http:// and private IP` (reusa `webhookUrlProblem`); `updateEndpoint of other merchant → not_found`.
  - `setEndpointActive toggles`; `rotateEndpointSecret changes stored secret and returns new one once`.
  - `endpointHealth bands: 95%→healthy, 85%→unstable, 50%→failing, none→nodata` (montar entregas).
  - `deliveryStats24h counts within 24h only`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(webhooks): editar/ativar/segredo/saúde/kpis por endpoint`.

---

### Task M-ALLOWLIST: Allowlist com CIDR + "testar IP"

**Files:**
- Create: `lib/services/api-key-ips.ts`, `tests/api-key-ips.test.ts`
- Modify: `lib/api/keys.ts` (a validação de `ipAllowlist` passa a aceitar CIDR com prefixo mínimo; `withApi` em `lib/api/http.ts` passa a casar IP contra CIDR, não só igualdade)

**Interfaces:**
- Consumes: `node:net` `BlockList`/`isIP` (já usados em `ssrf.ts`), `apiKeys`.
- Produces:
  - `ipEntryProblem(entry: string): string | null` — valida "IP ou CIDR": IPv4 (4 octetos, sem zero à esquerda) ou IPv6 (um `::`, sem zona), prefixo CIDR 0–32 (v4)/0–128 (v6), **mínimo /24 (v4) e /64 (v6)** (regra §1.10); IP sem prefixo = host único. Mensagens em PT ("Prefixo muito amplo: aceito IPv4 a partir de /24 e IPv6 a partir de /64.").
  - `updateKeyAllowlist(merchantId, keyId, entries: string[]): Promise<void>` — substitui a allowlist de uma chave existente (hoje só dava para definir na criação — lacuna §2.2). Dedup, até 20, valida cada entrada. Chave de outro lojista → `not_found`.
  - `ipMatchesAllowlist(ip: string, allowlist: string[]): boolean` — casa `ip` contra a lista de IPs/CIDRs via `BlockList` (um BlockList por família; `addSubnet`/`addAddress`). Lista vazia = aceita qualquer origem (comportamento atual). **Esta função substitui o `includes(ip)` de `withApi`** — assim a allowlist por chave passa a aceitar faixas (a Vantri mantém allowlist **por chave**, a vantagem dela sobre a Cashyin — §2.4).
  - `checkIp(merchantId, keyId, ip): Promise<{ allowed: boolean; hasAllowlist: boolean; matched?: string }>` — "testar IP": aceita só IP puro (sem `/`); resultado permitido/bloqueado/sem restrição, sem efeito. Chave de outro lojista → `not_found`.

- [ ] **Step 1: Testes:**
  - `ipEntryProblem accepts 203.0.113.0/24 and 203.0.113.10`; `rejects /25` ("prefixo muito amplo"); `rejects 203.0.113.256`; `rejects space in the middle`.
  - `ipMatchesAllowlist: 203.0.113.10 matches 203.0.113.0/24, not 198.51.100.0/24`; `empty allowlist matches anything`.
  - `withApi still 403s an IP outside a CIDR allowlist` (teste de integração leve em `api.test.ts` ou aqui): chave com `['203.0.113.0/24']`, request de `198.51.100.1` → 403.
  - `updateKeyAllowlist of other merchant → not_found`.
  - `checkIp returns allowed/blocked/no-restriction`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar (trocar `includes` por `ipMatchesAllowlist` em `withApi`). **Step 4:** PASS (os testes de `api.test.ts` da fase 1 continuam verdes — o IP exato é um CIDR /32).
- [ ] **Step 5:** Commit `feat(api): allowlist por chave com CIDR e testar IP`.

---

### Task M-SESSIONS: Listar e revogar sessões do próprio usuário

**Files:**
- Create: `lib/services/sessions.ts`, `tests/sessions.test.ts`

**Interfaces:**
- Consumes: `sessions`, `sha256Hex`.
- Produces:
  - `listSessions(userId, currentToken): Promise<Array<{ id: string; createdAt: Date; expiresAt: Date; mfaPassed: boolean; current: boolean }>>` — sessões não expiradas do usuário; marca a atual comparando `sha256Hex(currentToken)` com `sessions.id`. **Nunca** devolve o token (só o hash-id, que é opaco). (ponytail: não há coluna de IP/user-agent em `sessions`; mostrar criada em/expira em/atual já resolve o caso "derrubar sessão esquecida". Upgrade = colunas `ip`/`ua` se o lojista pedir.)
  - `revokeSession(userId, sessionId): Promise<boolean>` — apaga uma sessão **do próprio usuário** (id de outro usuário → não apaga, devolve `false`). `sessionId` é o hash-id opaco.
  - `revokeOtherSessions(userId, keepSessionId): Promise<number>` — "encerrar as outras".

- [ ] **Step 1: Testes:**
  - `listSessions marks current and excludes expired`; `never leaks the raw token`.
  - `revokeSession only removes own session` (sessão de outro userId → false, continua lá).
  - `revokeOtherSessions keeps the current one`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(auth): listar e revogar sessões do próprio usuário`.

---

### Task M-RECEIPT: Código de autenticação do comprovante + verificação pública

**Files:**
- Create: `lib/services/receipt.ts`, `tests/receipt.test.ts`

**Interfaces:**
- Consumes: `createHmac`/`timingSafeEqual` (node:crypto), `APP_ENCRYPTION_KEY` (ou `RECEIPT_SECRET` dedicado — usar `APP_ENCRYPTION_KEY` para não criar env nova), `getPayout` (para a verificação pública reusar o dado).
- Produces:
  - `receiptCode(payoutId: string): string` — `HMAC-SHA256(key, 'receipt:' + payoutId)` truncado para ~16 hex base32/hex (código curto, imprimível). Determinístico.
  - `verifyReceiptCode(payoutId: string, code: string): boolean` — `timingSafeEqual`. O código **não** é um id adivinhável: quem tem o comprovante tem o código; sem ele, a página pública nega.
  - `publicReceipt(code: string, payoutId: string): Promise<{ amountCents: number; status: PayoutRow['status']; endToEndId: string | null; completedAt: Date | null } | null>` — a verificação pública: confere o código contra o id e devolve **só** valor, status, E2E e data — **sem nenhum dado pessoal** (nome/chave/documento do favorecido = plano 2, não aparece). `null` se o código não bate ou o saque não existe/não está `completed`.

- [ ] **Step 1: Testes:**
  - `receiptCode is deterministic and verifies`; `verifyReceiptCode rejects wrong code` (timing-safe).
  - `publicReceipt returns only non-personal fields` (checar que o objeto não tem nome/chave/documento).
  - `publicReceipt null for wrong code or non-completed payout`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(receipt): código de autenticação e verificação pública sem dado pessoal`.

---

### Task M-MED-TIMELINE: Linha do tempo do MED (eventos gravados)

**Files:**
- Modify: `lib/services/med.ts` (gravar `med_events` em `applyMedOpened`, `submitDefense`, `applyMedClosed`; expor `listMedEvents`)
- Create: `tests/med-timeline.test.ts`

**Interfaces:**
- Consumes: `medEvents` (Task M-DB).
- Produces:
  - Dentro das três funções existentes, **na mesma transação**, inserir a linha de `med_events` (`opened`/`defense_submitted`/`closed_merchant_won`/`closed_payer_refunded`). Idempotente: como a transição-pai já é idempotente (`onConflictDoNothing`/`update ... where status in (...)`), o evento só grava quando a transição realmente acontece.
  - `listMedEvents(merchantId, caseId): Promise<Array<{ type; createdAt; meta }>>` — só do próprio lojista (caso de outro → `[]`), ordenado por `created_at`. Serve ao painel e (depois) ao admin.
  - **requer parceiro:** os eventos finos ("recebido via DICT", bloqueio cautelar, aguardando defesa, análise) vêm do parceiro real; nesta fase a linha do tempo tem os eventos que o simulador gera (aberto, defesa enviada, encerrado). Marcar na UI que o detalhe fino do MED é do plano 2.

- [ ] **Step 1: Testes:**
  - `applyMedOpened writes an 'opened' event once` (repetido não duplica).
  - `submitDefense writes 'defense_submitted'`.
  - `applyMedClosed writes the matching closed_* event; late close writes nothing`.
  - `listMedEvents of other merchant → []`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(med): linha do tempo com eventos gravados na transação`.

---

### Task U-LAYOUT: Casca do painel — card de saldo, ocultar saldos, link Conta

**Files:**
- Modify: `app/painel/layout.tsx`, `app/painel/lib.ts` (helpers)
- Create: `app/painel/balance-toggle.tsx` (client)

**Interfaces:**
- Consumes: `getBalance`, `painelSession`.
- Produces:
  - No layout: **card de saldo na lateral** (`getBalance(merchant.id)` → Disponível, com botões "Cobrar" → `/painel/cobrancas`, "Sacar" → `/painel/saques/novo`) e item "Conta" (→ `/painel/conta`) no menu (`nav.tsx` ganha o item).
  - `BalanceToggle` (client): botão olho que grava `vantri-ocultar-saldos` no `localStorage` e põe/tira uma classe no `<html>` (`data-ocultar`). CSS em `globals.css`: `html[data-ocultar] .valor-sensivel { ... }` troca o número por "••••••" (via `::after` ou classe utilitária). **Toda** célula de dinheiro usa a classe `valor-sensivel` — aplicar em Início, Extrato, Transações, Saques, card da lateral (a Cashyin vaza em várias telas — §1.4; a Vantri não). try/catch em torno do `localStorage` (pode falhar em aba privada).
  - ponytail: um atributo no `<html>` + CSS, sem estado React global; o botão só liga/desliga a classe.

- [ ] **Step 1:** implementar layout + toggle; adicionar item "Conta" no `nav.tsx`.
- [ ] **Step 2:** `npx next build` + `npx tsc --noEmit` limpos.
- [ ] **Step 3:** Commit `feat(painel): card de saldo na lateral, ocultar saldos e link conta`.

---

### Task U-INICIO: Início rico

**Files:**
- Modify: `app/painel/page.tsx`
- Create: `app/painel/fluxo-chart.tsx`

**Interfaces:**
- Consumes: `periodSummary`, `dailyFlow`, `previousPeriod`, `pctDelta` (M-SUMMARY), `getBalance`, `searchTransactions`/`listStatement` (últimas 6 do razão), `endpointHealth`/`deliveryStats24h` ou consulta de entregas `failed` (alerta), `listMedCases` (MED com prazo curto).
- Produces (blocos na ordem do mapa §1.4, adaptados):
  - **Seletor de período** na URL (`?de&ate`) com atalhos Hoje / 7 dias / Este mês (padrão **Este mês**) — `<form method="get">` + `<input type="date">` (native, sem lib). "Atualizar" = re-submit.
  - **3 KPIs:** Entradas do período (nº Pix + ticket médio), Saldo disponível (Disponível/Bloqueado/Total — não depende do período), Saídas do período (nº + tarifa total); **delta** "+12,3% vs. período anterior" via `pctDelta` (oculto se período anterior ≤ 0; verde/vermelho conforme sentido). Valores com classe `valor-sensivel`.
  - **Gráfico de fluxo** (`FluxoChart`): SVG puro de **duas séries** (entradas verde, saídas vermelha) sobre `dailyFlow` — **sem biblioteca** (estende o `Bars` atual para duas séries); eixo X "dd/mm"; lista escondida para leitor de tela; link "Ver extrato →".
  - **Últimas transações (6):** lê do **razão** (os dois sentidos, não só cobranças), com saldo após; ícone/cor por sinal; link para o detalhe.
  - **Resumo do dia** (sempre o dia de Brasília): entradas (n), saídas (n), resultado com sinal.
  - **Alertas** (cards clicáveis): "Entregas de webhook falhando" (se houver `failed` nos últimos 7 dias → `/painel/integracoes/entregas`), "Saldo bloqueado" (se `blocked > 0` → `/painel/extrato`), e **"MED com prazo curto"** (caso `open` com prazo < 48 h → `/painel/med`) — **a Cashyin não alerta prazo** (§2.2 Início; diferencial).
  - **Card "Limites Pix"** (texto): diário/mensal/noturno com "Usado X de Y"; **requer parceiro** para os valores reais → marcar "limites de demonstração" e usar o default (M-BATCH `payoutCeilingCents` e um limite diário default). Se não houver limites, o card explica que são de demonstração.

- [ ] **Step 1:** implementar; reusar `Card`, `StatusBadge`, `Table`, `Alert`.
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(painel): início rico com período, fluxo, alertas e limites`.

---

### Task U-EXTRATO: Extrato completo

**Files:**
- Modify: `app/painel/extrato/page.tsx`, `app/painel/extrato/csv/route.ts`
- Create: `app/painel/extrato/xlsx/route.ts`

**Interfaces:**
- Consumes: `listStatementWithBalance`, `dailyClosing` (M-STATEMENT-EXTRA), `periodSummary` (M-SUMMARY), `buildXlsx`/`XLSX_MIME` (M-XLSX), `csvCell`, `searchTransactions` (busca).
- Produces:
  - **3 cards do período** (Entradas / Saídas / Resultado) via `periodSummary`.
  - **Período** com atalhos Hoje / 7 dias / Este mês + De/Até (reusa `<input type="date">`).
  - **Filtros no servidor:** por tipo (`kind[]`), por movimento (`direction`), por faixa de valor (`minCents`/`maxCents`) — passados a `listStatementWithBalance`. A coluna **Saldo** mostra "—" quando há filtro de tipo/movimento (honesto; `balanceAfter === null`), com um aviso.
  - **Saldo após** cada lançamento (coluna nova).
  - **Busca** por identificador (campo no topo → `searchTransactions`) com resultados agrupados (Cobranças/Transferências) e link para o detalhe; estados "nada encontrado"/"falha ao buscar" (falha ≠ "não existe" — §1.6).
  - **Fecho Diário:** visão (`?visao=fecho`) com tabela Data / Abertura / Entradas / Saídas / Tarifas / MED / Fechamento (via `dailyClosing`) — **melhor que a Cashyin**; "fechamento" (PT-BR), não "fecho" (§1.17.20).
  - **Export CSV + XLSX:** CSV (rota existente, agora com filtro de `kind`/`direction` na query) e **XLSX** (rota nova) — tanto do extrato quanto do Fecho Diário; `Content-Disposition: attachment`, `cache-control: no-store`; recusa acima de 50 mil linhas (o CSV já faz isso). XLSX usa `buildXlsx` (proteção de injeção).

- [ ] **Step 1:** implementar página + rota XLSX; estender CSV.
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(extrato): cards, filtros no servidor, saldo após, fecho diário, csv+xlsx`.

---

### Task U-TRANSACOES: Lista unificada + detalhe lateral (abas)

**Files:**
- Create: `app/painel/transacoes/page.tsx`, `app/painel/transacoes/detail.tsx` (client, só as abas)

**Interfaces:**
- Consumes: `listCharges`, `listPayouts`, `getCharge`, `getPayout`, `toChargeJson`/`toPayoutJson` (aba "Payloads"), `listMedEvents`/entregas da transação.
- Produces:
  - Lista unificada de cobranças e saques (ou duas abas "Cobranças"/"Transferências" — decidir no build; o mapa trata extrato e transações como aliases §1.6, mas o design Plano A pede "Transações: lista + detalhe lateral"). Período, busca, abas de status, cursor.
  - **Detalhe lateral** (`?id=` abre um painel à direita; a largura total no celular) com **abas** (Resumo, Pix, Financeiro, Webhooks, Timeline, Payloads) — adaptação honesta das 7 abas da Cashyin (§1.5): "Financeiro" mostra a **tarifa de verdade** e "Você recebe" (a Vantri tem; a Cashyin diz "Não informada pelo Core" — §2.4); "Webhooks" lista as entregas desta transação; "Payloads" mostra o JSON público (`toChargeJson`/`toPayoutJson`) com `CopyButton`.
  - Para **saque**, o detalhe linka para `/painel/saques/[id]` e o comprovante (Task U-SAQUE-DETAIL).
  - IDOR: `getCharge(merchant.id, id)`/`getPayout(merchant.id, id)` → `null` para id de outro lojista.

- [ ] **Step 1:** implementar; reusar `CopyField`, `StatusBadge`, `maskDocument` (pagador mascarado).
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(transacoes): lista unificada e detalhe lateral com abas`.

---

### Task U-SAQUE-DETAIL: Detalhe do saque + comprovante + verificação pública

**Files:**
- Modify: `app/painel/saques/page.tsx` (lista com abas/busca/contadores de verdade + link para o detalhe)
- Create: `app/painel/saques/[id]/page.tsx`, `app/painel/saques/[id]/comprovante/page.tsx`, `app/comprovante/[codigo]/page.tsx`
- Modify: `app/painel/lib.ts` (tabela `FAILURE_LABEL: Record<string,string>` código→texto PT)

**Interfaces:**
- Consumes: `getPayout`, `listPayouts`, `receiptCode`/`publicReceipt` (M-RECEIPT), `maskDocument`, `FAILURE_LABEL`.
- Produces:
  - **Lista de saques** com abas por status (Todos / Em processamento / Concluídos / Falhou), busca por chave/E2E, e **contadores de verdade** (não só da página — uma consulta de contagem por status; a Cashyin erra isso §1.17.2).
  - **`/painel/saques/[id]`** (detalhe, só do próprio lojista — `getPayout(merchant.id, id)` → `notFound()` se `null`): chave **mascarada**, valor, tarifa, status, E2E, datas, **motivo legível da falha** (`FAILURE_LABEL[p.failureCode]` em PT; a Cashyin mostra o código cru §2.2), e link para o comprovante.
  - **`/painel/saques/[id]/comprovante`**: HTML imprimível com `@media print` ("Salvar como PDF" do navegador — **sem dependência nova**). Mostra valor, data, E2E, status e o **código de autenticação** (`receiptCode(id)`) + a URL pública `/comprovante/<codigo>`. Dados bancários completos do favorecido = **requer parceiro** → marcar "dados bancários do favorecido: disponíveis com o parceiro de Pix (plano 2)". Comprovante só faz sentido para `completed` (status não-concluído mostra o porquê).
  - **`/comprovante/[codigo]`** (público, sem login): recebe só o **código** (não o id); a página precisa do par código+id — resolver por uma rota que aceita `?id=` + valida com `verifyReceiptCode`, **ou** embutir o id no código (código = `base32(payoutId)` + HMAC curto e `publicReceipt` separa). Mostra **só** valor/status/E2E/data (sem nome/chave/documento — Review Focus 1). Código inválido → "comprovante não encontrado". Mantém a faixa "ambiente de demonstração" enquanto o Pix é simulado.

- [ ] **Step 1:** implementar; `FAILURE_LABEL` cobre os 12 códigos de falha do mapa §1.14 (`pix_key_not_found` → "Chave Pix não encontrada" etc.).
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(saques): detalhe, motivo legível e comprovante imprimível com verificação pública`.

---

### Task U-SAQUE-WIZARD: Assistente de saque (4 passos) + parcelamento

**Files:**
- Create: `app/painel/saques/novo/page.tsx`, `app/painel/saques/novo/wizard.tsx` (client)
- Modify: `app/painel/saques/actions.ts` (adicionar `previewPayoutAction`, `createBatchPayoutAction`, `resumeBatchAction`; manter `createPayoutAction`)

**Interfaces:**
- Consumes: `pixKeyProblem`, `computeFee`, `getBalance` (preview), `createPayout` (avulso), `createBatchPayout`/`resumeBatch`/`getBatch` (M-BATCH), `splitGreedy`/`needsBatch`/`payoutCeilingCents`, `freshTotpProblem` (2FA anti-replay compartilhado), `phoneKey`, `payoutInput` (reusa a validação de `app/painel/input.ts`).
- Produces:
  - Assistente **Dados → Revisão → Verificação (TOTP) → Confirmação** (stepper). Reusa o `payoutInput` existente (chave validada/normalizada **antes** do 2FA — a Vantri já faz §2.4). Passo **Revisão com tarifa e saldo depois** (a Cashyin ignora a tarifa §1.7): `previewPayoutAction` calcula `computeFee` + `getBalance` sem efeito (nenhum TOTP, nada gravado) e devolve o resumo; acima do teto, mostra a **prévia das parcelas** (`splitGreedy`) e o aviso "Saque parcelado — n parcelas para o mesmo favorecido".
  - Passo **Verificação:** um único `freshTotpProblem(user.id, fd)` por envio; o código **não** é reusado entre o saque e o lote (consumo de passo compartilhado — Review Focus 2). Ordem: validar campos (não gasta código) → TOTP → efeito.
  - Envio: se `needsBatch` → `createBatchPayoutAction` (→ `createBatchPayout`), senão `createPayoutAction` (reusa o fluxo avulso). `after(() => dispatchDue())` para os eventos saírem já.
  - **Confirmação:** para lote, mostra o resultado parcela a parcela; se `partial`, botão **"Retomar parcelas pendentes"** → `resumeBatchAction` (→ `resumeBatch`), que **apaga o TOTP e volta ao passo Verificação** (código novo — o lote não reusa o código anterior). A retomada lê o lote do **banco** (não da memória — §1.7.8). Idempotency key do lote gerada no render; a de cada parcela é derivada no serviço (`${batchId}:${i}`).
  - ponytail: um só `wizard.tsx` controlado por `useState` do passo, com `useActionState` por ação; não criar uma máquina de estados genérica.

- [ ] **Step 1:** implementar wizard + 3 actions; `createPayoutAction` continua para o caminho avulso (o formulário simples de `saques/page.tsx` pode redirecionar para `/painel/saques/novo` ou coexistir — decidir no build, preferir o wizard como caminho único "Nova transferência").
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(saques): assistente em 4 passos com parcelamento persistido e retomada`.

---

### Task U-INTEGRACOES: Webhooks completos + inspetor + allowlist (telas)

**Files:**
- Modify: `app/painel/integracoes/page.tsx` (abas `?aba=chaves|webhooks|seguranca`; saúde e KPIs), `app/painel/integracoes/actions.ts`
- Create: `app/painel/integracoes/webhooks/form.tsx` (criar/editar), `app/painel/integracoes/entregas/page.tsx`, `app/painel/integracoes/entregas/[id]/page.tsx`, `app/painel/integracoes/entregas/[id]/json/route.ts`, `app/painel/integracoes/seguranca/ip-form.tsx`

**Interfaces:**
- Consumes: `createEndpoint`/`updateEndpoint`/`setEndpointActive`/`deleteEndpoint`/`rotateEndpointSecret`/`sendTestDelivery`/`endpointHealth`/`deliveryStats24h`/`listDeliveries`/`getDeliveryForMerchant` (M-WEBHOOK-ADMIN, M-WEBHOOK-ATTEMPTS), `updateKeyAllowlist`/`checkIp`/`ipEntryProblem` (M-ALLOWLIST), `createApiKey`/`revokeApiKey`, `rfc8187` (download).
- Produces:
  - **Abas na URL** (`?aba=`) para Chaves / Webhooks / Segurança (§2.2).
  - **Webhooks:** tabela com **Saúde** (faixa), nome+URL, eventos, situação, ações **Editar / Ativar-desativar / Testar / Novo segredo / Excluir** (tudo que a Cashyin não tem §0.2) — cada ação é um `<form>` com o id em hidden e re-checa no servidor; "Testar" chama `sendTestDelivery` (reusa o guard SSRF — Review Focus 3); criar/editar re-valida a URL. KPIs de 24 h no topo.
  - **Inspetor de entregas** (`/painel/integracoes/entregas`): lista filtrada (endpoint, período, status, busca por identificador ≥ 8 chars no histórico inteiro) com cursor 25/50/100; `/painel/integracoes/entregas/[id]` mostra request enviado (método/URL/escudo "Assinado com HMAC (X-Vantri-Signature)" — **sem** o segredo nem headers), resposta (status/latência/trecho), **timeline de tentativas** (de `webhook_attempts`), próxima tentativa, botões **Reenviar** (`resendDelivery`) e **Baixar JSON** (rota `json/route.ts` → `Content-Disposition: attachment`, só do próprio lojista). IDOR: `getDeliveryForMerchant(merchant.id, id)` → `null`/404.
  - **Segurança & IPs:** editar a allowlist **por chave** com CIDR + descrição; faixa de estado; **"testar IP"** (`checkIp`); validação por `ipEntryProblem`. Rodapé explicando que a restrição vale só para chamadas da API, nunca para o painel.
  - Chaves: agrupar escopos por rótulo (Cobranças/Saques/Saldo e extrato/MED) e mostrar rótulos na tabela (não os IDs crus — §2.2); **confirmar** antes de revogar.

- [ ] **Step 1:** implementar; reusar `CopyField` (segredo/chave uma vez), `StatusBadge`, `Table`, `Alert`.
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(integracoes): webhooks completos, inspetor de entregas e allowlist cidr`.

---

### Task U-CONTA: Minha conta — senha, 2FA, sessões, parceiro

**Files:**
- Create: `app/painel/conta/page.tsx`, `app/painel/conta/actions.ts`
- (Reusa `/conta/senha` para troca de senha — já existe; a área `/painel/conta` linka para lá e trata reset de 2FA + sessões.)

**Interfaces:**
- Consumes: `listSessions`/`revokeSession`/`revokeOtherSessions` (M-SESSIONS), `verifyUserTotp`/`beginTotpSetup`/`confirmTotpSetup` (reconfigurar 2FA), `changePassword` (via link para `/conta/senha`), `maskDocument`, `getSession`/`accessSession`.
- Produces:
  - Página **Minha conta**: dados do lojista (razão/trade, documento **mascarado**, segmento), parceiro de liquidação (**RC 16** — transparência; a Cashyin esconde §2.2 Outras telas — mostrar o `NEXT_PUBLIC_PSP_NAME` e, com parceiro real, agência/conta = plano 2, marcado).
  - **Trocar senha:** link/botão para `/conta/senha` (fluxo existente; derruba as outras sessões).
  - **Reconfigurar 2FA (com senha/código atual):** o dono reconfigura o **próprio** 2FA. Fluxo seguro: exige o **código TOTP atual** (`freshTotpProblem`/`verifyUserTotp`) **e** a senha atual antes de liberar um `beginTotpSetup` novo (que só funciona com `totp_enabled=false`) — então a action precisa: validar senha + código atual → desligar o 2FA atual → `beginTotpSetup` → confirmar o novo com `confirmTotpSetup`. **Não** pode religar sem o código atual (Review Focus 2). (Reset por esquecimento do app = admin, Plano B — **fora** daqui; mostrar só o link de suporte.)
  - **Sessões abertas:** `listSessions(user.id, token)` numa tabela (criada em / expira em / atual) com "Encerrar" por sessão (`revokeSession`) e "Encerrar as outras" (`revokeOtherSessions`).
  - **"Esqueci minha senha" por e-mail está FORA** (decisão do dono — plano 3, sem serviço de e-mail). Não construir tela de recuperação por e-mail. O caminho para quem se trancou é o admin (Plano B).

- [ ] **Step 1:** implementar página + actions; reconfigurar 2FA reaproveita QR/`beginTotpSetup`.
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(conta): minha conta com senha, reconfigurar 2fa e sessões`.

---

### Task U-RECEBER: Consolidar nomenclatura de Receber/Depósito

**Files:**
- Modify: `app/painel/cobrancas/page.tsx` (texto/rótulos), `app/painel/nav.tsx` (se precisar), `app/painel/lib.ts` (se precisar)

**Interfaces:** nenhuma função nova.

- Escopo mínimo (design Plano A item 5): a tela de **cobranças já existe e está à frente da Cashyin** (valor + descrição + validade + tarifa + QR + copia-e-cola + "Simular pagamento", §2.2 Receber). Aqui é só **consolidar a nomenclatura**: garantir que "Receber"/"Cobrança"/"Depósito" não apareçam como coisas diferentes (um único rótulo "Cobranças" com o subtítulo "Gere um QR Code Pix para receber"), e que o atalho "Cobrar" do Início e o "Receber" da lateral apontem para `/painel/cobrancas`. **Não** criar rota `/painel/receber` nova (ponytail: é a mesma tela; renomear confunde links e histórico). Opcional (baixo custo, passaria a Cashyin): atualizar a cobrança pendente a cada 3 s no cliente enquanto não paga (`router.refresh`) — deixar para depois se apertar o escopo.

- [ ] **Step 1:** ajustar rótulos/links; sem lógica nova.
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `chore(painel): consolidar nomenclatura de receber/cobrança`.

---

### Task U-BUSCA: Busca por identificador no painel

**Files:**
- Create: `app/painel/busca/page.tsx` (ou embutir no header do layout/Extrato)

**Interfaces:**
- Consumes: `searchTransactions` (M-SEARCH).
- Produces:
  - Campo de busca (no header do painel ou numa página `/painel/busca?q=`) por E2E / TxID / referência / nome, resultados agrupados (Cobranças / Transferências) com link para o detalhe. Escopado ao `merchant.id`. Estados: buscando / nada encontrado / falha (falha ≠ "não existe"). ponytail: reusa `searchTransactions`; a UI é um `<form method="get">` + lista — sem busca ao vivo com debounce nesta fase (opcional depois).

- [ ] **Step 1:** implementar.
- [ ] **Step 2:** build + tsc limpos.
- [ ] **Step 3:** Commit `feat(busca): busca por identificador escopada ao lojista`.

---

### Task M-DB-DEPLOY: Aplicar migração e RLS no banco

**Files:** (sem arquivo novo; operação de infra)

- [ ] **Step 1:** Aplicar `drizzle/00XX_*.sql` da Task M-DB no Supabase (MCP `apply_migration`; conferir custo = 0 antes). Ligar **RLS** em todas as tabelas novas (`payout_batches`, `webhook_attempts`, `med_events`) sem policy; conferir com `get_advisors` = zero alertas de RLS.
- [ ] **Step 2:** Confirmar que o `PAYOUT_CEILING_CENTS` (e um limite diário default, se usado no Início) estão como env na Vercel (ou têm default no código). Nenhum segredo novo obrigatório (o comprovante usa `APP_ENCRYPTION_KEY`).
- [ ] **Step 3:** Commit (se houver `.sql` ou doc de env) `chore(db): aplicar migração da fase 2 e ligar rls`.

---

### Task M-VERIFY: Prova final (Playwright como usuário NOVO) + code review

**Files:** (sem arquivo novo)

- [ ] **Step 1:** `npx vitest run` (todos os serviços novos verdes) + `npx next build` + `npx tsc --noEmit` limpos.
- [ ] **Step 2: Playwright como usuário NOVO** (contexto limpo, 1440 e **390 px**): entrar → configurar 2FA → **Início** (trocar período, ver fluxo de duas séries, alertas, ocultar saldos esconde **todos** os valores) → criar cobrança → "Simular pagamento" → **Extrato** com filtro de tipo, saldo após, Fecho Diário, baixar CSV e **XLSX** → **busca** por E2E acha a cobrança → **saque pelo assistente** (Revisão com tarifa e saldo depois; TOTP; confirmação) → **saque parcelado** acima do teto (prévia de parcelas; forçar falha numa parcela com `falha@teste.com`; **retomar** e provar que a parcela concluída não paga de novo) → **comprovante** imprime e a URL pública mostra só valor/E2E/data → **webhooks**: criar, editar, **testar envio** (entrega aparece), **inspetor** com timeline de tentativas, novo segredo, excluir → **allowlist** com CIDR e "testar IP" → **Minha conta**: reconfigurar 2FA (exige código atual), encerrar uma sessão. Prints de cada passo. **Prova por mutação** onde o teste de serviço não cobre a UI (retomar lote duas vezes; abrir id de outro lojista pela URL → 404).
- [ ] **Step 3:** Confirmar a 390 px: menu em faixa, sem rolagem horizontal, detalhe/assistente a largura total.
- [ ] **Step 4:** `/code-review` no diff da fase 2 com foco nos 6 itens de Review Focus; corrigir ou justificar cada achado. Rodar o checklist de lançamento (`~/.claude/skills/lenda-strategy/references/checklist-lancamento.md`) nos 4 que derrubam o negócio: RLS ligado nas tabelas novas, nenhum `service_role`/segredo no cliente, comprovante/JSON público sem dado pessoal, IDOR nas rotas novas.
- [ ] **Step 5:** Commit final + atualizar `project-vantri-gateway.md` (fase 2: painel completo contra o simulador; o que ficou marcado "requer parceiro").

---

## Ondas de execução

Tasks na mesma onda tocam arquivos disjuntos e rodam em paralelo. `lib/db/schema.ts` só é tocado na M-DB (onda A); ninguém mais mexe no schema.

| Onda | Tasks (paralelas dentro da onda) | Depende de |
|---|---|---|
| A | **M-DB** | — |
| B | **M-SUMMARY** · **M-SEARCH** · **M-STATEMENT-EXTRA** · **M-XLSX** · **M-RECEIPT** · **M-SESSIONS** · **M-MED-TIMELINE** | A (M-MED-TIMELINE, M-SUMMARY, M-STATEMENT-EXTRA, M-SESSIONS usam tabelas/colunas da A; M-XLSX e M-RECEIPT são puros mas agrupados aqui) |
| C | **M-BATCH** · **M-WEBHOOK-ATTEMPTS** · **M-ALLOWLIST** | A (M-BATCH usa `payout_batches`; M-WEBHOOK-ATTEMPTS usa `webhook_attempts`) |
| D | **M-WEBHOOK-ADMIN** | C (usa `sendTestDelivery`/`listDeliveries` da M-WEBHOOK-ATTEMPTS) |
| E | **U-LAYOUT** · **U-INICIO** · **U-EXTRATO** · **U-TRANSACOES** · **U-SAQUE-DETAIL** · **U-SAQUE-WIZARD** · **U-INTEGRACOES** · **U-CONTA** · **U-RECEBER** · **U-BUSCA** | B, C, D (cada tela consome os serviços das ondas B–D; arquivos de tela são disjuntos por rota) |
| F | **M-DB-DEPLOY** | A (e as telas prontas) |
| G | **M-VERIFY** | todas |

**Nota sobre a onda E:** as telas tocam arquivos disjuntos por rota, mas três tocam arquivos compartilhados pequenos — `app/painel/lib.ts` (U-LAYOUT adiciona helpers; U-SAQUE-DETAIL adiciona `FAILURE_LABEL`) e `app/painel/nav.tsx` (U-LAYOUT adiciona "Conta"). Para evitar conflito, **U-LAYOUT roda sozinha primeiro dentro da onda E** (ou o orquestrador faz as edições de `lib.ts`/`nav.tsx` numa sub-task inicial), e as demais telas da onda E seguem depois. `app/painel/integracoes/actions.ts` e `app/painel/saques/actions.ts` são tocados só por uma task cada (U-INTEGRACOES e U-SAQUE-WIZARD respectivamente).

## Total de tasks

**24 tasks** = **12 de serviço/dados** (M-DB, M-SUMMARY, M-SEARCH, M-STATEMENT-EXTRA, M-XLSX, M-BATCH, M-WEBHOOK-ATTEMPTS, M-WEBHOOK-ADMIN, M-ALLOWLIST, M-SESSIONS, M-RECEIPT, M-MED-TIMELINE) + **10 de tela** (U-LAYOUT, U-INICIO, U-EXTRATO, U-TRANSACOES, U-SAQUE-DETAIL, U-SAQUE-WIZARD, U-INTEGRACOES, U-CONTA, U-RECEBER, U-BUSCA) + **2 de infra/prova** (M-DB-DEPLOY, M-VERIFY).

## Plano 2 (fora deste plano) — o que fica marcado "requer parceiro"

Construído contra o simulador e marcado na UI; o dado real entra quando o Lenda nomear o parceiro (`PIX_PROVIDER=<parceiro>`):
- **DICT** do favorecido no passo Revisão (nome/instituição/ISPB reais) — hoje o saque não mostra nome real do favorecido.
- **Pix devolvido** (`returned`) e seu estorno — hoje só `completed`/`failed`.
- **Devolução de cobrança** (`refunded`) iniciada pelo lojista.
- **Limites reais** (diário/mensal/noturno e teto por transferência) — hoje default configurável (`PAYOUT_CEILING_CENTS`); o card de limites do Início é "demonstração".
- **Dados bancários no comprovante** (nome/instituição do favorecido) — hoje o comprovante mostra só valor/E2E/data, sem dado pessoal.
- **MED fino** (tipo de fraude, relato do pagador, ISPB, eventos "recebido via DICT") — hoje a linha do tempo tem só os eventos do simulador.
