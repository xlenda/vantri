# Vantri Fase 2 — Admin / Backoffice (Plano B) Implementation Plan

> **Para quem executa:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar tarefa a tarefa. Os passos usam `- [ ]` para acompanhamento. Prosa e UI em **pt-BR**; nomes de código em inglês (camelCase no TS, snake_case no banco/JSON).

**Goal:** Dar ao `/admin` da Vantri o "interior completo" de um gateway de verdade — no molde do backoffice da Wavex (tema escuro roxo, menu ATENDIMENTO / INTEGRAÇÕES / COMPLIANCE, busca global de operação, "Histórico operacional", Sellers com Conta/KYC/API) e do mapa `paridade-cashyin` Parte 3 — **sem** reescrever os serviços da fase 1. Toda tela consome `lib/services/*` e `lib/money/ledger.ts`; todo papel é checado **no servidor**; todo movimento manual de dinheiro passa por `postEntries` com `lockMerchant`, é auditado com o autor e, quando move dinheiro, passa por **quatro olhos**.

**Architecture:** O admin continua em `app/admin/**` (Next 15 App Router, Server Components + Server Actions). Nenhuma tela fala com o banco por fora dos serviços existentes; as **leituras** novas de admin (agregados, listas cruzadas) ficam em `app/admin/queries.ts` (ou arquivos irmãos) como hoje. As **escritas** novas (papéis, quatro olhos, ajuste/estorno manual, ações em saque, reset de 2FA) ganham serviços puros em `lib/services/admin/*` testados com Vitest+PGlite, e as Server Actions só traduzem erro→PT e chamam o serviço depois de `requireAdmin({ perm })`. Gráficos são SVG inline montados no servidor (sem Recharts nem lib pesada — a vitrine já faz isso com SVG na fase 1).

**Tech Stack:** o mesmo da fase 1 (ver `docs/superpowers/plans/2026-10-16-vantri-gateway.md`): next@15.5.28, react 19, typescript, tailwindcss 4, drizzle-orm 0.45 + drizzle-kit 0.31, postgres-js em produção, PGlite 0.5 nos testes, zod 4, otplib 13, @node-rs/argon2, qrcode, vitest 5. **Nenhuma dependência nova** salvo decisão explícita (XLSX fica para depois do CSV; ver Decisão pendente).

**Specs (ler antes de começar):**
- Design da fase 2 (Plano B = admin): `docs/superpowers/specs/2026-10-17-vantri-fase2-design.md`
- Mapa detalhado, **Parte 3** (backoffice P0/P1/P2 + mudanças de schema) e **Parte 1** (o que cada dado significa): `docs/superpowers/specs/2026-10-17-paridade-cashyin.md`
- Referência Wavex (o que o Lenda quer): `.superpowers/sdd/2026-10-16-vantri-gateway/progress.md` (buscar "REFERÊNCIA DO LENDA" e "print do backoffice/suporte da WAVEX")
- Estilo da casa (copiar a estrutura): `docs/superpowers/plans/2026-10-16-vantri-gateway.md`

---

## Global Constraints (valem para TODA tarefa — a revisão cobra cada uma)

- **Papel no servidor, sempre.** Toda página, Server Action e route handler do `/admin` chama `requireAdmin({ perm })` (Task 1) — que confere a sessão de admin **e** a permissão específica daquele papel. Esconder botão no front **nunca** é controle de acesso: a mesma permissão é re-checada no servidor antes de qualquer efeito. Um `suporte` que forjar o POST de "mudar taxa", "aprovar cliente", "ajustar saldo" ou "resetar 2FA" recebe `notFound()`/erro, não a ação.
- **Dinheiro só pelos serviços/ledger existentes.** Nenhum `INSERT`/`UPDATE` em `ledger_entries`, `charges`, `payouts` ou `med_cases` fora de `lib/services/*` e `lib/money/ledger.ts`. Movimento manual (ajuste de saldo, estorno manual) é um `kind: 'adjustment'`/`cash_out_reversal` via `postEntries(tx, …)` dentro de `db().transaction` com `lockMerchant(tx, merchantId)` antes da leitura de saldo. **Nunca** editar ou apagar lançamento existente: só lançar o contrário.
- **Quatro olhos** em movimento manual de dinheiro (ajuste de saldo, estorno manual de saque) e nas ações que o mapa marca (mudança de taxa acima de um teto, reativação de cliente): viram **pedido** em `pending_approvals` que **outro** admin aprova. Quem pediu **não** pode aprovar (checado no servidor pelo `actor_user_id`). O efeito só acontece na aprovação.
- **Step-up TOTP.** Toda ação de admin que move dinheiro ou muda acesso (ajuste, estorno, criar pedido de quatro olhos, aprovar pedido, reset de 2FA) exige o código TOTP de novo — `verifyUserTotp(userId, code)` de `lib/auth/session.ts`, exatamente como o saque do lojista já faz (`freshTotpProblem` em `app/painel/lib.ts`). Código já usado é recusado (anti-replay nativo do `verifyUserTotp`).
- **Documento mascarado por padrão.** `maskDocument` em tudo; o documento completo só aparece no estado de revisão manual já construído (`app/admin/clientes/[id]/page.tsx`, regra `fullCnpj`). Nenhuma tela nova e nenhuma exportação revela documento completo além dessa política.
- **Log sem dado pessoal.** `logError(context, err, idsSomente)` de `lib/log.ts`; só ids, nunca nome/documento/chave Pix/payload do pagador. Erro do serviço vira mensagem PT fixa; a causa vai só para o log.
- **IDOR impossível.** Id sempre da sessão/escopo. O admin vê tudo (merchantId = `null` nos serviços que aceitam, como `listMedCases(null, …)`), mas o lojista nunca; nenhum id de lojista vem de formulário para decidir escopo de leitura do lojista.
- **Mobile 390 px.** Tudo funciona a 390 px (menu, tabelas com rolagem horizontal própria, gráfico que encolhe). A Cashyin falha nisso; a Vantri não copia.
- **Migração nova é aditiva e liga RLS.** Toda tabela/coluna nova entra numa migração Drizzle gerada (`npx drizzle-kit generate`), com `default` para linhas existentes, e **RLS ligado** na tabela nova (seguir `drizzle/0003_rls.sql` e `0004_revoke_anon.sql`). O app conecta como `postgres` pelo pooler e ignora RLS; a chave anon não lê nada. Conferir com `get_advisors` = zero alertas.
- **Exportações neutralizam injeção de CSV.** Reusar `csvCell` de `app/painel/lib.ts` (prefixa `'` em célula que começa com `= + - @ \t \r`; aspas em `; " \r \n`), BOM `﻿`, separador `;`, `Content-Disposition: attachment`, `Cache-Control: no-store`. Nome do arquivo só com `from/to` já validados por `z.iso.date()`.
- **Busca global não vaza.** A "Localizar operação" devolve só o que um admin pode ver (admin vê tudo) e **nunca** campos internos crus (hash de senha, segredo cifrado, `request_hash`): devolve os mesmos JSONs públicos / resumos que as telas já mostram. Consulta **parametrizada** (Drizzle/placeholders), nunca string concatenada — sem SQL injection.
- **Honestidade.** A faixa "ambiente de demonstração" (`DemoBanner`, já no layout) continua enquanto o Pix for simulado. O que depende do parceiro real (conciliação bancária, envio de defesa de MED, KYC documental, limites do parceiro) é marcado **"requer parceiro"** e não finge funcionar. Tudo que é P2 no mapa (limites/risco, "ver como o lojista", conciliação) **fica fora** deste plano.
- **Execução em ondas** (ver fim): agentes paralelos **não** commitam; o orquestrador commita ao fim de cada onda. Tarefas paralelas tocam arquivos disjuntos. Task 1 (papéis + migração) é a onda 1 e quase tudo depende dela.

## Review Focus (o que a revisão tenta quebrar)

1. **Admin de menor privilégio (`operador`/`suporte`) tenta privilégio de `admin`** — mudar taxa, aprovar/recusar/suspender cliente, ajustar saldo, estornar saque, criar/aprovar pedido de quatro olhos, resetar 2FA — forjando o POST direto (sem o botão). Em todos → `notFound()`/erro, nada gravado. Testes nas Tasks 1, 8, 9, 10 e 12.
2. **Quatro olhos auto-aprovado** — o mesmo admin que pediu tenta aprovar o próprio pedido (pela tela ou forjando `approvalId`) → recusado no servidor. Pedido aprovado/recusado não aplica duas vezes. Testes na Task 8.
3. **Ajuste manual que estoura o saldo ou pula o ledger** — débito manual que deixaria `available` negativo é recusado (salvo o caso MED já existente, que não é ajuste); todo ajuste aparece em `ledger_entries` via `postEntries` (idempotente) e no `audit_log` com o autor; nada edita linha existente. Testes na Task 8.
4. **Exportação vaza segredo/documento** — auditoria, registros de acesso e demais CSVs não contêm hash de senha, segredo de webhook/chave, `request_hash`, nem documento completo além da política; célula iniciada por `=`/`+`/`-`/`@` é neutralizada. Testes nas Tasks 7, 11 e 13.
5. **Busca global injeção / vazamento / papel** — termo com `' ; -- %` não quebra nem vaza linha de outro escopo; a rota é admin-only (`requireAdmin`); o resultado não traz campo interno cru. Testes na Task 14.
6. **Reset de 2FA / troca de senha forçada sem step-up ou por papel errado** — `suporte` sem step-up não reseta 2FA de ninguém; o reset derruba as sessões do alvo e exige verificação de identidade fora do sistema (texto). Testes na Task 12.
7. **Limpeza de 6 meses do Marco Civil** apaga só `access_logs` com mais de 6 meses e **nada** mais novo; roda isolada no cron (um passo que falha não derruba os outros). Teste na Task 11.
8. **Agregados do início batem com os serviços** (um número, uma fonte): o "Recebido hoje" etc. usam o mesmo corte de dia de Brasília (`todayStart`) e os mesmos status "como a pessoa vê" (`chargeStatusWhere`). Teste na Task 5.

---

## File Structure (novo e modificado)

```
vantri/
  lib/
    db/schema.ts                         # + admin_role em users; + pending_approvals, webhook_attempts,
                                         #   med_events, cron_runs, fee_plans, fee_history, merchants.rejection_reason,
                                         #   merchants.cnpj_lookup; access_logs.event ganha novos valores
    auth/session.ts                      # checkAccess/resolveSession carregam adminRole (modificar)
    auth/guards.ts                       # + requireAdmin({ perm }) (modificar)
    auth/perms.ts                        # NOVO: papéis, matriz de permissões, pode()
    services/admin/
      roles.ts                           # NOVO: listar/definir papel de admin (quatro olhos não; papel é do superadmin)
      approvals.ts                       # NOVO: pending_approvals — criar pedido, aprovar, recusar, listar
      ledger-admin.ts                    # NOVO: adjustBalance / reveralPayout manual (via pending_approvals + postEntries)
      payouts-ops.ts                     # NOVO: repoll de 1 saque, reenvio, marcar-falho+estornar (quatro olhos)
      webhooks-monitor.ts                # NOVO: entregas cruzadas, reenvio em lote, desativar endpoint
      med-queue.ts                       # NOVO: fila por prazo + KPIs + eventos (med_events)
      audit.ts                           # NOVO: leitura/filtro/export do audit_log
      access.ts                          # NOVO: leitura/filtro/export de access_logs + limpeza 6 meses
      cron-health.ts                     # NOVO: grava e lê cron_runs
      search.ts                          # NOVO: busca global parametrizada
      fee-plans.ts                       # NOVO: planos de tarifa + fee_history
      users-admin.ts                     # NOVO: reset 2FA, forçar troca de senha, derrubar sessões, desbloquear
    webhooks/dispatch.ts                 # enqueue grava tentativa em webhook_attempts; dispatchDue idem (modificar)
    services/charges.ts | payouts.ts | med.ts | merchants.ts  # pontos de auditoria e eventos ampliados (modificar)
  app/admin/
    layout.tsx                           # tema escuro roxo + 3 grupos de menu + busca global + rodapé do papel (modificar)
    nav.tsx                              # menu em grupos ATENDIMENTO/INTEGRAÇÕES/COMPLIANCE/EQUIPE (modificar)
    perms-ui.ts                          # NOVO: rótulos PT de papel/permissão (sem "use server")
    page.tsx                             # Visão do suporte: cartões + gráficos SVG + fila de pendências (modificar)
    home-queries.ts                      # NOVO: agregados por dia e por lojista, saldos, fila
    chart.tsx                            # NOVO: BarChart/LineChart SVG (server component, sem lib)
    clientes/page.tsx                    # tabela Sellers: #id, e-mail mascarado, Conta/KYC/API, Desde, Operação (modificar)
    clientes/[id]/...                    # tela de operação do cliente — estender (usuários, MED, ajuste de saldo) (modificar)
    clientes/analise/page.tsx            # NOVO: fila de análise de cadastro (P1) — opcional nesta leva
    transacoes/page.tsx                  # + exportar + detalhe (modificar)
    transacoes/export/route.ts           # NOVO: CSV de transações
    saques/page.tsx                      # NOVO: operação de saques (presos, repoll, reenviar, estornar)
    saques/[id]/page.tsx                 # NOVO: linha do tempo + payload do saque
    saques/actions.ts                    # NOVO
    saques/export/route.ts               # NOVO
    webhooks/page.tsx                    # NOVO: monitor de webhooks (falhando, por lojista, reenvio)
    webhooks/[id]/page.tsx               # NOVO: detalhe de entrega + tentativas
    webhooks/actions.ts                  # NOVO
    med/page.tsx                         # fila por prazo + KPIs + linha do tempo (modificar; mantém abrir/encerrar simulador)
    med/[id]/page.tsx                    # NOVO: detalhe do caso (eventos, defesa, cobrança)
    auditoria/page.tsx                   # NOVO: tela do audit_log
    auditoria/export/route.ts            # NOVO
    acessos/page.tsx                     # NOVO: registros de acesso (Marco Civil)
    acessos/export/route.ts              # NOVO: CSV + hash SHA-256 gravado na auditoria
    equipe/page.tsx                      # NOVO: admins + papéis + usuários (reset 2FA etc.)
    equipe/actions.ts                    # NOVO
    aprovacoes/page.tsx                  # NOVO: fila de quatro olhos (pedidos a aprovar/recusar)
    aprovacoes/actions.ts                # NOVO
    tarifas/page.tsx                     # NOVO: planos de tarifa (P1)
    tarifas/actions.ts                   # NOVO
    saude/page.tsx                       # NOVO: saúde do cron/parceiro
    buscar/route.ts (ou server action)   # NOVO: busca global "Localizar operação"
    admin-lib.ts                         # NOVO: csvResponse() + helpers compartilhados (sem "use server")
  app/api/cron/tick/route.ts             # grava cron_runs + passo de limpeza de access_logs 6 meses (modificar)
  scripts/seed-admin.ts                  # admin criado já com admin_role='admin' (modificar)
  tests/                                 # um arquivo por serviço novo + app/admin/*.test.ts ampliado
```

> **Nomenclatura dos papéis — DECISÃO DO CONTROLADOR (ver "Lacunas de design" no fim):** este plano adota os 3 papéis que o **design/briefing Wavex** pede — **`admin` / `operador` / `suporte`** — e **não** os 4 do mapa Parte 3 (`superadmin/financeiro/compliance/suporte`). Mapeamento: `admin` = tudo (inclusive gerir admins e aprovar quatro olhos); `operador` = opera dinheiro e cadastro (saques, MED, ajuste/estorno **via pedido**, taxas, webhooks), mas **não** gere admins; `suporte` = leitura de clientes/transações/MED + reset de 2FA com step-up; **não** move dinheiro, não muda taxa, não aprova cadastro. Confirmar com o Lenda antes de fechar a Task 1.

---

### Task 1: Papéis do admin, matriz de permissões e `requireAdmin` (FUNDAÇÃO)

**Files:**
- Modify: `lib/db/schema.ts` (coluna `admin_role` em `users`), `lib/auth/session.ts` (carregar `adminRole`), `lib/auth/guards.ts` (`requireAdmin`), `scripts/seed-admin.ts`
- Create: `lib/auth/perms.ts`, `app/admin/perms-ui.ts`, `drizzle/0005_*.sql` (gerado), `tests/perms.test.ts`
- Modify (teste): `tests/auth.test.ts` (ou `app/admin/admin.test.ts`) para o novo redirect/papel

**Interfaces:**
- `users.adminRole`: `text("admin_role", { enum: ["admin","operador","suporte"] })` **nullable** (lojista e admins antigos ficam `null`; a migração faz `UPDATE users SET admin_role='admin' WHERE role='admin'`). Prod. `default` nenhum (lojista é null).
- `lib/auth/perms.ts`:
  ```ts
  export type AdminRole = "admin" | "operador" | "suporte"
  export type Perm =
    | "clientes:ler" | "clientes:cadastro"        // aprovar/recusar/suspender/reativar/criar
    | "taxas:editar"
    | "transacoes:ler" | "transacoes:exportar"
    | "saques:operar"                              // repoll, reenviar
    | "dinheiro:mover"                             // ajuste manual, estorno manual, marcar-falho+estornar (SEMPRE via quatro olhos)
    | "quatro_olhos:aprovar"
    | "med:ler" | "med:operar"                     // abrir/encerrar no simulador, anotações
    | "webhooks:operar"                            // reenviar, desativar endpoint
    | "auditoria:ler" | "auditoria:exportar"
    | "acessos:ler" | "acessos:exportar"
    | "equipe:gerir"                               // papéis de admin
    | "usuarios:operar"                            // reset 2FA, forçar troca de senha, derrubar sessões, desbloquear
    | "tarifas:gerir" | "saude:ler"
  export const PERMS: Record<AdminRole, ReadonlySet<Perm>>  // matriz (ver abaixo)
  export const pode = (role: AdminRole | null, perm: Perm): boolean  // null => false
  ```
  **Matriz** (fonte única; a tela só espelha): `admin` = todas. `operador` = tudo menos `equipe:gerir` e `quatro_olhos:aprovar` (operador **pede** mas não aprova; só `admin` aprova). `suporte` = `clientes:ler`, `transacoes:ler`, `med:ler`, `acessos:ler`, `auditoria:ler`, `saude:ler`, `usuarios:operar` (reset 2FA). Nada de `*:editar/operar/mover/exportar/cadastro` para `suporte` exceto `usuarios:operar`.
- `lib/auth/session.ts`: `resolveSession` passa a selecionar `users.adminRole`; `SessionInfo["user"]` ganha `adminRole`. `checkAccess` inalterado na ordem (papel `admin` continua a porta grossa).
- `lib/auth/guards.ts`:
  ```ts
  export async function requireAdmin(opts: { perm: Perm }): Promise<{ user: SessionInfo["user"] }>
  // 1) requireUser({ role: "admin" }) (sessão + 2FA + etc.)  2) if (!pode(user.adminRole, opts.perm)) notFound()
  ```
- `app/admin/perms-ui.ts`: `ROLE_LABEL: Record<AdminRole,string>` ("Administrador", "Operador", "Suporte") e `PERM_LABEL`.

- [ ] **Step 1: Teste** `tests/perms.test.ts`: `pode('admin', qualquer) === true`; `pode('suporte','dinheiro:mover') === false`; `pode('suporte','usuarios:operar') === true`; `pode('operador','quatro_olhos:aprovar') === false`; `pode('operador','taxas:editar') === true`; `pode(null, 'clientes:ler') === false`. Matriz coberta campo a campo.
- [ ] **Step 2:** FAIL. **Step 3:** escrever `perms.ts`, migração (`admin_role` + UPDATE), `resolveSession`/`SessionInfo`, `requireAdmin`, `seed-admin` (admin nasce `adminRole:'admin'`). **Step 4:** PASS + `npx tsc --noEmit`.
- [ ] **Step 5:** `get_advisors` sem alerta de RLS na nova coluna (coluna não cria tabela; confirmar que nada regrediu). Commit `feat(admin): papéis admin/operador/suporte e requireAdmin no servidor`.

---

### Task 2: Schema aditivo do backoffice (tabelas novas)

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0006_*.sql` (gerado) + `drizzle/0007_rls.sql` (RLS das tabelas novas, no molde de `0003_rls.sql`), `tests/schema-admin.test.ts`

**Interfaces** (nomes exatos; `id` uuid default, `created_at` timestamptz default now()):
- `pendingApprovals` (`pending_approvals`): `kind text enum ['balance_adjustment','payout_reversal','fee_change','merchant_reactivate']`, `merchantId uuid FK`, `payload jsonb` (lista branca por tipo), `reason text`, `amountCents int null`, `status text enum ['pending','approved','rejected'] default 'pending'`, `requestedBy uuid FK users`, `decidedBy uuid FK users null`, `decidedAt tstz null`, `resultRefId uuid null` (ex.: id do lançamento/estorno criado). Índice (`status`,`createdAt`).
- `webhookAttempts` (`webhook_attempts`): `deliveryId uuid FK webhook_deliveries onDelete cascade`, `n int`, `statusCode int null`, `latencyMs int null`, `errorCategory text null`, `at tstz`. Índice (`deliveryId`,`n`). (Só **categoria** de erro, nunca mensagem crua — igual a `last_error` hoje.)
- `medEvents` (`med_events`): `medCaseId uuid FK med_cases onDelete cascade`, `type text` (`opened|funds_blocked|defense_submitted|defense_sent|analysis|closed|note`), `at tstz`, `source text enum ['provider','admin','merchant','system']`, `meta jsonb default {}`. Índice (`medCaseId`,`at`).
- `cronRuns` (`cron_runs`): `step text`, `startedAt tstz`, `finishedAt tstz null`, `result jsonb null`, `error text null`. Índice (`step`,`startedAt`).
- `feePlans` (`fee_plans`): `name text`, `feeInBps int`, `feeInFixedCents int`, `feeOutBps int`, `feeOutFixedCents int`, `archivedAt tstz null`.
- `feeHistory` (`fee_history`): `merchantId uuid FK`, `feeInBps int`, `feeInFixedCents int`, `feeOutBps int`, `feeOutFixedCents int`, `planId uuid FK fee_plans null`, `effectiveFrom tstz`, `actorUserId uuid FK users null`.
- `merchants` ganha: `rejectionReason text null`, `cnpjLookup jsonb null` (resultado da consulta de CNPJ guardado — razão social, situação, CNAEs).
- `accessLogs.event` passa a aceitar mais valores: enum `['login','login_failed','api_call','session_use']` (aditivo; nada apaga retroativo). **Limpeza de 6 meses** agora permitida (ver Task 11); o comentário do schema sobre "nada apaga (Ruling 30)" vira "limpeza de 6 meses no cron (art. 15)".
- (`reconciliation_items`, `merchant_limits` são **P2** — fora deste plano.)

- [ ] **Step 1: Teste** `tests/schema-admin.test.ts`: inserir uma linha em cada tabela nova roda; `pending_approvals` recusa `status` fora do enum; `webhook_attempts` cai junto quando a entrega é apagada (cascade); `access_logs` aceita `event:'api_call'`.
- [ ] **Step 2:** FAIL. **Step 3:** escrever schema + `drizzle-kit generate` + `0007_rls.sql` (ligar RLS, sem policy, em todas as tabelas novas). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(db): tabelas do backoffice (approvals, webhook_attempts, med_events, cron_runs, fee_plans/history) + RLS`.

---

### Task 3: Casca do admin no molde Wavex (layout, menu, tema, busca, rodapé do papel)

**Files:**
- Modify: `app/admin/layout.tsx`, `app/admin/nav.tsx`
- Create: `app/admin/search-box.tsx` (client; campo "Localizar operação" + Consultar/Limpar; aponta para Task 14), `app/admin/admin-lib.ts` (`csvResponse(name, header, rows)` reusando `csvCell`), `app/admin/perms-ui.ts` já veio na Task 1
- Modify (teste): `app/admin/admin.test.ts` (render do layout por papel)

**Interfaces / UI:**
- **Tema escuro roxo** (molde do print Wavex): definir tokens locais do admin em `app/admin/` (não mexer na marca da vitrine). Fundo roxo escuro, texto claro, acento. Reaproveitar `app/components/ui/*` (botão, card, tabela, badge); se preciso, variante escura via classes Tailwind — **sem** nova lib.
- **Menu em grupos** (substitui os 4 links planos de hoje), cada item filtrado por `pode(user.adminRole, perm)` **e** o alvo re-checa no servidor:
  - **ATENDIMENTO:** Visão do suporte (`/admin`), Clientes/Sellers (`/admin/clientes`), Transações PIX (`/admin/transacoes`), Saques (`/admin/saques`).
  - **INTEGRAÇÕES:** Webhooks (`/admin/webhooks`).
  - **COMPLIANCE:** Análise KYC (`/admin/clientes/analise` ou aba em clientes), MED (`/admin/med`), Auditoria (`/admin/auditoria`), Acessos (`/admin/acessos`).
  - **EQUIPE:** Equipe e papéis (`/admin/equipe`), Aprovações (`/admin/aprovacoes`), Tarifas (`/admin/tarifas`), Saúde (`/admin/saude`).
  - Item ativo por prefixo (como hoje); "Visão do suporte" só no caminho exato.
- **Busca global** "Localizar operação" no topo (desktop e mobile): input + Consultar + Limpar; submete para a rota/ação da Task 14. (Exportar resumo do resultado é parte da Task 14.)
- **Rodapé do usuário:** e-mail + **selo do papel** (`ROLE_LABEL[user.adminRole]`), botão Sair (já existe). Sem dado pessoal extra.
- `admin-lib.ts`:
  ```ts
  export function csvResponse(filename: string, header: string[], rows: string[][]): Response
  // monta "﻿" + [header, ...rows].map(r => r.map(csvCell).join(";")).join("\r\n") + "\r\n"
  // headers: text/csv; charset=utf-8, Content-Disposition attachment filename="…", Cache-Control no-store
  ```
- **Mobile:** o menu vira acordeão/topo rolável a 390 px (a Cashyin perde o menu no celular — a Vantri **não**).

- [ ] **Step 1:** layout + nav com grupos; `csvResponse`; `search-box`. Menu condicionado por `pode()`.
- [ ] **Step 2: Teste** no `admin.test.ts`: renderizar o layout como `suporte` **não** mostra "Tarifas"/"Aprovações"/"Equipe"; como `admin` mostra tudo; o selo do papel aparece. (Render com `requireUser`/`requireAdmin` mockados, como o teste atual já faz.)
- [ ] **Step 3:** `npx next build` + `npx tsc --noEmit` limpos; abrir no Playwright a 1440 e 390 px — menu acessível nas duas larguras, sem rolagem horizontal da página.
- [ ] **Step 4:** Commit `feat(admin): casca Wavex — tema escuro, menu em grupos, busca global e selo de papel`.

---

### Task 4: Auditoria ampliada + eventos de MED (instrumentar os serviços existentes)

> Base para Auditoria (Task 10), fila de MED (Task 6) e quatro olhos (Task 8). **Não reescreve** os serviços; só adiciona gravação de `audit_log`/`med_events` nos pontos que faltam, preservando a assinatura.

**Files:**
- Modify: `lib/services/med.ts` (gravar `med_events` em `applyMedOpened`/`applyMedClosed`/`submitDefense`), `lib/services/payouts.ts` e `lib/services/charges.ts` e `lib/services/merchants.ts` (padronizar `audit_log` nos pontos já existentes e novos), `lib/webhooks/dispatch.ts` (gravar `webhook_attempts` em cada tentativa)
- Create: `lib/services/admin/audit-util.ts` (helper `writeAudit(tx, actorUserId, action, meta)` — o mesmo `audit()` que `merchants.ts` já tem, extraído para reuso), `tests/audit-events.test.ts`

**Interfaces:**
- `writeAudit(tx: Tx, actorUserId: string | null, action: string, meta: Record<string, unknown>): Promise<void>` — insere em `audit_log`. Reusa o padrão de `merchants.ts`.
- Em `dispatch.ts`: dentro da gravação de resultado de cada entrega, `INSERT` em `webhook_attempts` (`n = attempts`, `statusCode`, `latencyMs` medido com `performance.now()` em volta do `send`, `errorCategory`). **Mesma transação/escrita** que já grava `webhook_deliveries` — sem rodada extra.
- Em `med.ts`: `applyMedOpened` grava `med_events` (`opened`, `funds_blocked`); `applyMedClosed` grava `closed`; `submitDefense` grava `defense_submitted`. Dentro da transação que já existe.
- Novas ações de `audit_log` padronizadas (string em `action`): `payout.repoll`, `payout.resend`, `payout.force_fail`, `balance.adjust`, `webhook.resend`, `webhook.endpoint_disable`, `user.reset_2fa`, `user.force_password`, `user.drop_sessions`, `export.<recurso>`, `approval.request`, `approval.approve`, `approval.reject`, `fee_plan.*`, `med.open_test`, `med.close`. (As Tasks 6–13 chamam `writeAudit` com estes nomes.)

- [ ] **Step 1: Teste** `tests/audit-events.test.ts`: abrir MED de teste grava 2 `med_events` (`opened`,`funds_blocked`); encerrar grava `closed`; uma entrega de webhook falha → 1 linha em `webhook_attempts` com `errorCategory` e **sem** mensagem crua (não contém host/IP). (Reusar os mocks de provider/fetch dos testes da fase 1.)
- [ ] **Step 2:** FAIL. **Step 3:** instrumentar. **Step 4:** PASS — e rodar os testes **já existentes** de med/payouts/webhooks: continuam verdes (assinaturas intactas).
- [ ] **Step 5:** Commit `feat(admin): trilha de med_events e webhook_attempts e audit_log padronizado`.

---

### Task 5: Visão do suporte — agregados, gráficos SVG e fila de pendências

**Files:**
- Modify: `app/admin/page.tsx`
- Create: `app/admin/home-queries.ts`, `app/admin/chart.tsx`, (teste em `app/admin/admin.test.ts`)

**Interfaces:**
- `app/admin/home-queries.ts` (leituras de admin; quem chama já passou por `requireAdmin({ perm: "clientes:ler" })` — a Visão é visível a todos os papéis):
  ```ts
  export type Range = { from: string; to: string }         // dias de Brasília (reusa dayStart/todayDate de format.ts)
  export function parseRange(sp): Range                     // presets hoje/7d/30d/mês/personalizado
  export async function seriesByDay(r: Range): Promise<Array<{ day: string; inCents: number; outCents: number; medCents: number; pixCount: number; payoutCount: number }>>
  export async function topMerchants(r: Range, limit=10): Promise<Array<{ merchantId: string; tradeName: string; inCents: number; count: number; feeCents: number; medRate: number }>>
  export async function aggregateBalances(): Promise<{ availableTotal: number; blockedTotal: number; negativeCount: number }>   // SUM sobre ledger_entries agrupado; reusa o padrão de getBalance
  export async function pendingQueue(): Promise<{ pendingMerchants: number; stuckPayouts: number; failingWebhooks: number; medDueSoon: number; cronStale: boolean }>
  ```
  Cortes de dia **iguais** aos de `queries.ts`/`format.ts`; status "como a pessoa vê" via `chargeStatusWhere`. Receita = `SUM(fee_in)+SUM(fee_out)` por dia.
- `app/admin/chart.tsx` (server component, SVG puro — **sem** Recharts): `BarChart({ data, series })` (recebido × enviado por dia) e `Sparkline`/`LineChart`. Eixo com rótulo `dd/mm`; `role="img"` + `aria-label` com os totais; encolhe a 390 px (viewBox + `width:100%`). Segue o jeito dos componentes SVG da vitrine (Gauge/LineChart da Task 17 da fase 1).
- `page.tsx`: seletor de período; cartões (recebido bruto, líquido, enviado, receita de tarifa, nº cobranças pagas, conversão pagas÷criadas, ticket médio, saques com falha %, MED aberto R$); gráfico de barras por dia; tabela "maiores lojistas"; saldos agregados; **fila de pendências** (cards clicáveis que levam a `/admin/saques?presos=1`, `/admin/webhooks?status=failed`, `/admin/med?ordem=prazo`, `/admin/saude`). Mantém o alerta de Turnstile que já existe.

- [ ] **Step 1: Teste** no `admin.test.ts`: `seriesByDay` agrupa por dia de Brasília e separa in/out (semear cobranças pagas e saques em dias diferentes → série correta); `topMerchants` ordena por volume; `aggregateBalances` soma por bucket e conta disponível negativo (semear um lojista com MED após saque); `pendingQueue` conta pendentes/presos/falhando. Um teste de render confirma que o SVG do gráfico aparece e que os números batem com `adminOverview` para o dia de hoje.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** `npx next build`; Playwright 390 px (gráfico não estoura a tela). Commit `feat(admin): visão do suporte com gráficos SVG, saldos agregados e fila de pendências`.

---

### Task 6: Fila de MED por prazo + KPIs + detalhe com linha do tempo

**Files:**
- Modify: `app/admin/med/page.tsx` (ordenar por prazo, KPIs, taxa de MED por lojista — **mantendo** abrir/encerrar no simulador que já existe)
- Create: `app/admin/med/[id]/page.tsx`, `lib/services/admin/med-queue.ts`, (testes em `tests/med-queue.test.ts`)

**Interfaces:**
- `lib/services/admin/med-queue.ts`:
  ```ts
  export async function medKpis(): Promise<{ open: number; blockedCents: number; dueToday: number; defensePendingSend: number }>
  export async function listMedByDeadline(opts: { limit?: number; cursor?: string; onlyOpen?: boolean }): Promise<{ data: Array<MedCaseRow & { tradeName: string; deadlineBucket: 'red'|'amber'|'ok' }>; nextCursor: string | null }>
  export async function medCaseDetail(id: string): Promise<{ case: MedCaseRow; charge: {...}; events: MedEventRow[]; files: {...}[]; merchantMedRate: number } | null>
  export async function addMedNote(caseId: string, actorUserId: string, note: string): Promise<void>  // writeAudit + med_events(type:'note')
  ```
  `deadlineBucket`: `red` < 24 h, `amber` < 72 h (calculado no servidor). `merchantMedRate` = casos ÷ cobranças pagas (30 dias). Ordena por `defenseDeadline` asc entre os abertos; encerrados por `createdAt` desc. Reusa `listMedCases`/`getMedCase`/`listMedFiles` do serviço existente onde der; só a ordenação por prazo e os KPIs são novos.
- `/admin/med` ganha botão/ordem "por prazo" e os 4 KPIs no topo, com cor por prazo. `requireAdmin({ perm: "med:ler" })`; abrir/encerrar/anotar exige `med:operar`.
- `/admin/med/[id]`: cobrança de origem, valor bloqueado, motivo, defesa + anexos (download pelo route existente `med/arquivo/[id]`), **linha do tempo** de `med_events`, taxa de MED do lojista. Ação "Enviar defesa ao parceiro" aparece **"requer parceiro"** (desabilitada no simulador). Anotações internas (textarea → `addMedNote`).

- [ ] **Step 1: Teste** `tests/med-queue.test.ts`: semear casos com prazos diferentes → `listMedByDeadline` ordena por prazo e marca `red`/`amber`; `medKpis` conta abertos e soma bloqueado; `medCaseDetail` traz os `med_events` na ordem; `addMedNote` grava evento + auditoria; `suporte` não consegue `addMedNote` (perm).
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS (e os testes de MED da fase 1 seguem verdes).
- [ ] **Step 5:** Commit `feat(admin): fila de MED por prazo, KPIs e detalhe com linha do tempo`.

---

### Task 7: Auditoria e Registros de acesso (Marco Civil) — telas, filtros, exportação + limpeza no cron

**Files:**
- Create: `lib/services/admin/audit.ts`, `lib/services/admin/access.ts`, `app/admin/auditoria/page.tsx`, `app/admin/auditoria/export/route.ts`, `app/admin/acessos/page.tsx`, `app/admin/acessos/export/route.ts`, `tests/admin-audit-access.test.ts`
- Modify: `app/api/cron/tick/route.ts` (passo `deleted_access_logs` de 6 meses — **ver também Task 11**)

**Interfaces:**
- `lib/services/admin/audit.ts`:
  ```ts
  export type AuditFilters = { actorUserId?: string; action?: string; merchantId?: string; from?: string; to?: string; page: number }
  export function parseAuditFilters(sp): AuditFilters
  export async function listAudit(f): Promise<{ rows: Array<{ log: AuditLogRow; actorEmail: string | null }>; hasNext: boolean }>
  export async function auditCsvRows(f): Promise<{ header: string[]; rows: string[][] }>   // meta em JSON string via csvCell; sem segredo
  ```
  `merchantId` é filtrado por `meta->>'merchantId'` (parametrizado). A exportação **não** inclui hash/segredo (o `meta` só tem ids e valores de taxa; conferir no teste).
- `lib/services/admin/access.ts`:
  ```ts
  export type AccessFilters = { email?: string; userId?: string; ip?: string; from?: string; to?: string; page: number }
  export async function listAccess(f): Promise<{ rows: Array<{ ip: string; event: string; createdAt: Date; email: string | null }>; hasNext: boolean }>
  export async function accessCsvRows(f): Promise<{ header: string[]; rows: string[][] }>  // UTC e Brasília nas duas colunas
  export async function deleteAccessLogsOlderThan6Months(now = new Date()): Promise<number>  // DELETE where created_at < now - 6 months
  ```
- Telas: Auditoria com filtro (quem/ação/lojista/período), detalhe do `meta` (JSON formatado, só leitura, **sem** botão apagar). Acessos com busca por e-mail/IP/período, colunas data UTC + Brasília, IP, evento. Ambas com botão **Exportar** → route CSV via `csvResponse`. `requireAdmin({ perm: "auditoria:ler" / "acessos:ler" })`; exportar exige `:exportar`.
- Exportação de acessos grava na auditoria `export.access_logs` com `{ from, to, sha256 }` do arquivo (o hash é do corpo do CSV; a Task 13 generaliza, mas **esta** já grava para a ordem judicial). A rota calcula `sha256Hex(body)` (de `lib/crypto.ts`), grava a auditoria e devolve o arquivo.

- [ ] **Step 1: Teste** `tests/admin-audit-access.test.ts`: `listAudit` filtra por ação e por `meta.merchantId` (parametrizado — termo com `'`/`%` não quebra nem vaza); `auditCsvRows`/`accessCsvRows` não contêm `passwordHash`/`secret`; célula iniciada por `=` sai com `'`; `deleteAccessLogsOlderThan6Months` apaga só > 6 meses (semear um registro de 5 meses e um de 7 → só o de 7 some); exportar acessos grava `export.access_logs` com `sha256`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(admin): auditoria e registros de acesso (Marco Civil) com filtro, export e limpeza 6 meses`.

---

### Task 8: Quatro olhos + movimento manual de dinheiro (ajuste de saldo, estorno manual)

> **O coração da segurança de dinheiro.** Nenhum dinheiro manual se move fora daqui, e nunca sem um segundo admin.

**Files:**
- Create: `lib/services/admin/approvals.ts`, `lib/services/admin/ledger-admin.ts`, `app/admin/aprovacoes/page.tsx`, `app/admin/aprovacoes/actions.ts`, `tests/admin-approvals.test.ts`, `tests/admin-ledger.test.ts`
- Modify: `app/admin/clientes/[id]/page.tsx` + `app/admin/clientes/actions.ts` (botão "Ajustar saldo" → cria pedido; taxa acima do teto → cria pedido)

**Interfaces:**
- `lib/services/admin/approvals.ts`:
  ```ts
  export type ApprovalKind = "balance_adjustment" | "payout_reversal" | "fee_change" | "merchant_reactivate"
  export class ApprovalError extends Error { code: "invalid_request"|"not_found"|"self_approval"|"already_decided"|"forbidden" }
  export async function requestApproval(kind, input: unknown, requestedBy: string): Promise<{ id: string }>  // valida payload por tipo (zod strict), writeAudit 'approval.request'
  export async function listPendingApprovals(): Promise<Array<{ ...; requesterEmail: string; tradeName: string }>>
  export async function approve(id: string, approver: string): Promise<void>   // requester !== approver (senão self_approval); status pending→approved; APLICA o efeito; writeAudit 'approval.approve'
  export async function reject(id: string, approver: string, reason: string): Promise<void>
  ```
  `approve` roda o efeito dentro de **uma** transação: lê o pedido `FOR UPDATE`, confere `status==='pending'` e `requestedBy !== approver`, aplica (chama `ledger-admin`/`reactivateMerchant`/`updateFees`), grava `decidedBy/decidedAt/resultRefId` e a auditoria. Idempotente: segundo `approve` vê `already_decided`.
- `lib/services/admin/ledger-admin.ts` (chamado **só** por `approvals.approve`, nunca direto por uma action):
  ```ts
  export async function adjustBalance(tx: Tx, merchantId: string, amountCents: number, reason: string, actorUserId: string): Promise<string>
  // dentro da tx do approve: lockMerchant; se amountCents<0 e available+amountCents<0 => ApprovalError('invalid_request') (não estoura saldo);
  // postEntries([{ kind:'adjustment', bucket:'available', refType:'manual', refId: <id novo>, amountCents }]); devolve refId; writeAudit 'balance.adjust'
  export async function reversePayoutManual(tx: Tx, payoutId: string, actorUserId: string): Promise<void>
  // só payout em 'failed'/'processing' que ainda NÃO estornou; posta 'cash_out_reversal' amount+fee uma vez (idempotência do UNIQUE do ledger); writeAudit 'payout.force_fail'
  ```
  `refId` do ajuste: gerar um uuid novo por pedido (guardado no `pending_approvals.resultRefId`) para a chave de idempotência do ledger (`UNIQUE(merchant,kind,ref,bucket)`) nunca colidir e um replay do approve não lançar de novo.
- `clientes/actions.ts`: `requestBalanceAdjustmentAction` e a mudança de taxa **acima do teto** (definir teto, ex.: variação > X bps/centavos — decisão do controlador; default sugerido: qualquer mudança para cliente **ativo** vai por quatro olhos, já que os termos prometem aviso de 30 dias) chamam `requestApproval`, **não** aplicam. Step-up TOTP via `freshTotpProblem`. `requireAdmin({ perm: "dinheiro:mover" })` para ajuste/estorno; `taxas:editar` para taxa.
- `aprovacoes/page.tsx` + `actions.ts`: lista de pedidos pendentes (quem pediu, o quê, por quê, valor, lojista); botões Aprovar/Recusar exigem `requireAdmin({ perm: "quatro_olhos:aprovar" })` (só `admin`) **e** step-up TOTP. O próprio pedido do admin aparece mas o botão Aprovar é bloqueado no servidor (self_approval).

- [ ] **Step 1: Testes:**
  - `tests/admin-approvals.test.ts`: requester não aprova o próprio pedido (`self_approval`), mesmo forjando o id; segundo `approve` → `already_decided` e não aplica de novo; `operador` cria pedido mas não aprova (`forbidden`/notFound na action); `suporte` não cria pedido de dinheiro.
  - `tests/admin-ledger.test.ts`: ajuste de crédito +500 aparece como 1 `adjustment` e sobe `available` em 500; débito −500 com saldo 300 → `invalid_request`, **nada** lançado; aprovar o mesmo pedido duas vezes credita **uma** vez (idempotência do ledger); estorno manual de saque `failed` não duplica estorno.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(admin): quatro olhos e ajuste/estorno manual via postEntries com lockMerchant`.

---

### Task 9: Operação de saques (todos os lojistas) + detalhe + exportação

**Files:**
- Create: `lib/services/admin/payouts-ops.ts`, `app/admin/saques/page.tsx`, `app/admin/saques/[id]/page.tsx`, `app/admin/saques/actions.ts`, `app/admin/saques/export/route.ts`, `tests/admin-payouts-ops.test.ts`
- Modify: `lib/services/payouts.ts` — **extrair** de `pollProcessingPayouts` um `repollPayout(payoutId): Promise<PayoutRow['status']>` (consulta/reenvia **um** saque) e fazer `pollProcessingPayouts` reusá-lo; **não** mudar o comportamento em lote.

**Interfaces:**
- `lib/services/payouts.ts` (adição que não quebra nada):
  ```ts
  export async function repollPayout(payoutId: string): Promise<PayoutRow["status"]>  // com providerPayoutId => getPayout+applyPayoutResult; sem => resubmit (mesma idempotência); writeAudit 'payout.repoll'/'payout.resend'
  ```
- `lib/services/admin/payouts-ops.ts`:
  ```ts
  export type PayoutOpFilters = { merchantId?: string; status?: PayoutRow["status"]; stuck?: boolean; from?: string; to?: string; page: number }
  export async function listPayoutsOps(f): Promise<{ rows: Array<{ payout: PayoutRow; tradeName: string; ageMin: number }>; hasNext: boolean }>  // "presos há > 10 min" = status processing e createdAt < now-10min
  export async function payoutDetail(id: string): Promise<{ payout: PayoutRow; tradeName: string; events: AuditLogRow[] } | null>  // linha do tempo via audit_log do saque
  export async function payoutsCsvRows(f): Promise<{ header; rows }>
  ```
- `saques/page.tsx`: lista de todos os saques com idade ("há 14 min em processamento"), `failure_code`, id no parceiro, E2E, **chave mascarada** (reusar a máscara que o painel já aplica à chave), valor e tarifa; filtro rápido "presos há mais de 10 min". `requireAdmin({ perm: "saques:operar" })` para as ações; leitura com `transacoes:ler`.
- Ações (`actions.ts`): "Consultar no parceiro agora" (`repollPayout`), "Reenviar ao parceiro" (`repollPayout`, só sem id do parceiro). **"Marcar como falho e estornar"** NÃO é ação direta: cria **pedido de quatro olhos** (`requestApproval('payout_reversal', …)`, Task 8). Todas com step-up TOTP e auditoria.
- `saques/[id]/page.tsx`: linha do tempo (pedido, enviado, resposta do parceiro, cada consulta do cron, resultado — vinda do `audit_log` do saque), payload enviado/recebido **sem dado pessoal além do necessário** (reusar `toPayoutJson`, nunca despejar raw do provedor com PII).
- Export CSV via `csvResponse`; grava `export.payouts` na auditoria.

- [ ] **Step 1: Teste** `tests/admin-payouts-ops.test.ts`: `repollPayout` de um `processing` com `providerPayoutId` fecha como `completed` (mock do provider) e os testes **existentes** de `pollProcessingPayouts` seguem verdes; "presos" só lista `processing` com idade > 10 min; "marcar falho" cria pedido (não estorna na hora); `suporte` não opera saque (notFound); export não traz `request_hash`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(admin): operação de saques — repoll por id, reenvio, estorno via quatro olhos e export`.

---

### Task 10: Transações PIX (todos) — detalhe e exportação

**Files:**
- Modify: `app/admin/transacoes/page.tsx` (detalhe + botão exportar; reusa `listChargesAdmin`/`listPayoutsAdmin`/`parseTxFilters` que já existem)
- Create: `app/admin/transacoes/export/route.ts`, `app/admin/transacoes/[tipo]/[id]/page.tsx` **ou** um `<details>`/drawer no próprio `page.tsx` (preferir detalhe inline server-rendered — mais simples que rota nova), `tests` dentro de `app/admin/admin.test.ts`

**Interfaces:**
- Reusa `listChargesAdmin`, `listPayoutsAdmin`, `parseTxFilters`, `merchantOptions` (já em `queries.ts`). A exportação monta as linhas a partir de `listChargesAdmin`/`listPayoutsAdmin` paginando com o filtro atual (período/cliente/status), `csvResponse`. `requireAdmin({ perm: "transacoes:exportar" })`.
- Detalhe: reaproveitar os JSONs públicos (`toChargeJson({withQr:false})`, `toPayoutJson`) e a máscara de documento; para cobrança, mostrar pagador mascarado, E2E, datas; para saque, link para `/admin/saques/[id]`.
- `export/route.ts` grava `export.transactions` na auditoria.

- [ ] **Step 1: Teste** no `admin.test.ts`: exportação de cobranças respeita o filtro de período/cliente e não vaza campo interno; o detalhe de uma cobrança mostra pagador mascarado (nunca completo). Teto de linhas (igual ao painel: `MAX_ROWS`, recusa sem cortar calado).
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(admin): detalhe e exportação de transações`.

---

### Task 11: Monitor de webhooks (cruzado) + Saúde do cron/parceiro + limpeza 6 meses no tick

**Files:**
- Create: `lib/services/admin/webhooks-monitor.ts`, `lib/services/admin/cron-health.ts`, `app/admin/webhooks/page.tsx`, `app/admin/webhooks/[id]/page.tsx`, `app/admin/webhooks/actions.ts`, `app/admin/saude/page.tsx`, `tests/admin-webhooks-health.test.ts`
- Modify: `app/api/cron/tick/route.ts` (envolver cada passo com gravação em `cron_runs` **e** adicionar o passo `deleted_access_logs` de 6 meses da Task 7)

**Interfaces:**
- `lib/services/admin/webhooks-monitor.ts`:
  ```ts
  export type DeliveryFilters = { merchantId?: string; endpointId?: string; eventType?: string; status?: 'pending'|'delivered'|'failed'; from?: string; to?: string; page: number }
  export async function listDeliveries(f): Promise<{ rows: Array<{ delivery: WebhookDeliveryRow; tradeName: string; url: string }>; hasNext: boolean }>
  export async function deliveryDetail(id: string): Promise<{ delivery: WebhookDeliveryRow; attempts: WebhookAttemptRow[]; tradeName: string } | null>  // payload + cada tentativa (hora, http, latência, categoria)
  export async function endpointSuccessRates(): Promise<Array<{ endpointId: string; url: string; tradeName: string; rate24h: number; rate7d: number }>>
  export async function resendOne(deliveryId: string, actorUserId: string): Promise<void>     // next_attempt_at = now, status pending; writeAudit 'webhook.resend'
  export async function resendFailedBatch(f: DeliveryFilters, actorUserId: string): Promise<number>  // DLQ: todos 'failed' do filtro voltam a pending
  export async function disableEndpoint(endpointId: string, actorUserId: string): Promise<void>  // active=false; writeAudit 'webhook.endpoint_disable'
  ```
  `resendOne`/`resendFailedBatch`: **admin** reenvia de qualquer lojista (diferente do `resendDelivery(merchantId, …)` do painel, que é escopo do dono — **não** reusar aquele; este é cross-merchant mas só via `requireAdmin({ perm:"webhooks:operar" })`). Dispara `after(() => dispatchDue())` como as outras entradas já fazem.
- `lib/services/admin/cron-health.ts`:
  ```ts
  export async function recordCronRun(step: string, run: () => Promise<unknown>): Promise<unknown>  // grava started/finished/result/error em cron_runs, propaga o resultado
  export async function cronHealth(): Promise<{ steps: Array<{ step: string; lastAt: Date | null; agoSec: number | null; error: string | null }>; stale: boolean }>  // stale se o tick não roda há > 5 min
  export function providerHealth(): { provider: string; simulated: boolean }
  ```
- `app/api/cron/tick/route.ts`: cada passo do `STEPS` existente passa a ser gravado via `recordCronRun(name, step.run)` (sem mudar a ordem nem a lógica), e **adiciona** o passo `deleted_access_logs: deleteAccessLogsOlderThan6Months()` (Task 7). Cada passo continua isolado (um que falha não derruba os outros) — já é assim.
- Telas: Monitor com filtros (lojista/endpoint/evento/status/período), taxa de sucesso 24 h/7 d por endpoint, fila "falhou de vez" com reenviar em lote, detalhe com tentativas. Saúde com última rodada de cada passo + "há quanto tempo" + alerta se > 5 min; provedor ativo.

- [ ] **Step 1: Teste** `tests/admin-webhooks-health.test.ts`: `listDeliveries` cruza lojistas e filtra por status; `deliveryDetail` traz as tentativas em ordem com categoria (sem mensagem crua); `resendFailedBatch` volta os `failed` do filtro para `pending`; `disableEndpoint` desliga; `recordCronRun` grava started/finished e propaga o retorno; `cronHealth.stale` vira true quando o último run passou de 5 min. `suporte` não reenvia (perm).
- [ ] **Step 2:** FAIL. **Step 3:** implementar + ajustar o tick. **Step 4:** PASS (testes do tick da fase 1 seguem verdes).
- [ ] **Step 5:** Commit `feat(admin): monitor de webhooks, saúde do cron e limpeza de acessos no tick`.

---

### Task 12: Equipe e papéis + usuários (reset 2FA, troca de senha, derrubar sessões)

**Files:**
- Create: `lib/services/admin/roles.ts`, `lib/services/admin/users-admin.ts`, `app/admin/equipe/page.tsx`, `app/admin/equipe/actions.ts`, `tests/admin-users.test.ts`

**Interfaces:**
- `lib/services/admin/roles.ts`:
  ```ts
  export async function listAdmins(): Promise<Array<{ id: string; email: string; adminRole: AdminRole; totpEnabled: boolean; lastLoginAt: Date | null }>>
  export async function setAdminRole(targetUserId: string, role: AdminRole, actorUserId: string): Promise<void>  // só 'admin' chama (perm equipe:gerir); não pode rebaixar a si mesmo se for o último admin; writeAudit 'role.set'
  ```
- `lib/services/admin/users-admin.ts`:
  ```ts
  export type UserRow = { id; email; role; adminRole; merchantId; tradeName?; totpEnabled; lastLoginAt; lockedUntil; mustChangePassword }
  export async function listUsers(f: { q?: string; kind?: 'admin'|'merchant'; page: number }): Promise<{ rows: UserRow[]; hasNext: boolean }>
  export async function reset2fa(targetUserId: string, actorUserId: string): Promise<void>       // totpEnabled=false, totpSecretEnc=null, totpLastStep=null; derruba sessões do alvo; writeAudit 'user.reset_2fa'
  export async function forcePasswordChange(targetUserId: string, actorUserId: string): Promise<{ tempPassword: string }>  // randomBase62(16), hashPassword, mustChangePassword=true, derruba sessões; mostra a senha UMA vez; writeAudit 'user.force_password'
  export async function dropSessions(targetUserId: string, actorUserId: string): Promise<void>   // delete sessions; writeAudit 'user.drop_sessions'
  export async function unlock(targetUserId: string, actorUserId: string): Promise<void>         // failedLogins=0, lockedUntil=null; writeAudit 'user.unlock'
  ```
- `equipe/page.tsx`: aba "Administradores" (listar, mudar papel — `requireAdmin({ perm:"equipe:gerir" })`, só `admin`) e aba "Usuários" (admins + lojistas: e-mail, papel, lojista, 2FA, último login, bloqueado até, troca pendente). Ações de usuário exigem `requireAdmin({ perm:"usuarios:operar" })` **e** step-up TOTP. Reset de 2FA mostra o aviso "confirme a identidade fora do sistema antes"; força senha mostra a senha temporária **uma vez** (padrão `create-form` que já existe).
- `setAdminRole`/`reset2fa` **derrubam as sessões** do alvo (mudança de acesso tem efeito imediato — igual `changePassword` já derruba as outras).

- [ ] **Step 1: Teste** `tests/admin-users.test.ts`: `suporte` reseta 2FA (tem `usuarios:operar`) mas **não** muda papel (`equipe:gerir` negado → notFound na action); `reset2fa` zera `totpEnabled`/segredo e apaga as sessões do alvo; `forcePasswordChange` devolve senha que verifica e marca `mustChangePassword`; `setAdminRole` não deixa o último `admin` se rebaixar; toda ação sem step-up TOTP é recusada; tudo gera `audit_log` com o autor.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(admin): equipe, papéis e operações de usuário (reset 2fa, senha, sessões) com step-up`.

---

### Task 13: Planos de tarifa + histórico + exportações restantes

**Files:**
- Create: `lib/services/admin/fee-plans.ts`, `app/admin/tarifas/page.tsx`, `app/admin/tarifas/actions.ts`, `tests/admin-fee-plans.test.ts`
- Modify: `lib/services/merchants.ts` — `updateFees` grava uma linha em `fee_history` (aditivo; a assinatura não muda); aplicar plano a um cliente reusa `updateFees`.

**Interfaces:**
- `lib/services/admin/fee-plans.ts`:
  ```ts
  export async function createFeePlan(input: unknown, actorUserId: string): Promise<{ id: string }>   // nome + 4 valores; writeAudit 'fee_plan.create'
  export async function listFeePlans(): Promise<FeePlanRow[]>
  export async function assignPlanToMerchant(merchantId: string, planId: string, actorUserId: string): Promise<void>  // chama updateFees com os valores do plano; grava fee_history com planId
  export async function feeHistory(merchantId: string): Promise<Array<{ ...; actorEmail: string | null }>>
  export function simulateFee(amountCents: number, plan: {feeInBps; feeInFixedCents}): number   // "para R$ 197,00 o lojista recebe R$ X"
  ```
  `updateFees` (modificado): dentro da transação que já existe, após gravar as taxas e a auditoria, insere `fee_history` (`effectiveFrom = now`, `actorUserId`). Mudar taxa de cliente **ativo** acima do teto continua indo por quatro olhos (Task 8) — aqui é só o modelo reutilizável + histórico.
- Telas: planos nomeados, atribuir a cliente, histórico com data de vigência, simulador. `requireAdmin({ perm: "tarifas:gerir" })`.
- **Exportações restantes** (Parte 3 item 14): a razão/fechamento diário por lojista ainda não têm tela própria nesta leva (a Visão já mostra agregados); se a razão por lojista for construída, o CSV sai por `csvResponse` com `export.ledger`/`export.daily_balances` na auditoria. *(Ver Lacuna de design: razão/conciliação completa é marcada G/P0 no mapa mas depende de decisão de escopo; este plano entrega agregados + exportações de transações/MED/auditoria/acessos; a razão por lojista linha-a-linha pode ser uma task extra ou P2.)*

- [ ] **Step 1: Teste** `tests/admin-fee-plans.test.ts`: criar plano e atribuir muda as 4 taxas do cliente e grava `fee_history` com `planId` e autor; `feeHistory` lista em ordem; `simulateFee(19700, {feeInBps:149,feeInFixedCents:0})` dá o líquido certo; `updateFees` passa a gravar histórico (o teste existente de taxas segue verde). `suporte` não gere tarifas.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(admin): planos de tarifa, histórico de vigência e simulador`.

---

### Task 14: Busca global "Localizar operação" + Exportar resumo

**Files:**
- Create: `lib/services/admin/search.ts`, `app/admin/buscar/page.tsx` (resultado) + ligação com `search-box.tsx` da Task 3, `app/admin/buscar/export/route.ts`, `tests/admin-search.test.ts`

**Interfaces:**
- `lib/services/admin/search.ts`:
  ```ts
  export type Hit =
    | { kind: 'charge'; id; merchantId; tradeName; label; status; amountCents; createdAt }
    | { kind: 'payout'; id; merchantId; tradeName; label; status; amountCents; createdAt }
    | { kind: 'webhook'; id; merchantId; tradeName; eventType; status; createdAt }
    | { kind: 'merchant'; id; tradeName; emailMasked; status }
  export async function searchOperations(term: string, limit = 20): Promise<Hit[]>
  // casa por: charge.id/txid/providerChargeId/externalRef/endToEndId; payout.id/providerPayoutId/endToEndId/idempotencyKey;
  //           webhook_deliveries.eventId; merchants por tradeName/legalName e users.email.
  // Admin vê tudo (sem filtro de merchant). TUDO parametrizado (eq / ILIKE com placeholder), nunca string concatenada.
  export function searchCsvRows(hits: Hit[]): { header: string[]; rows: string[][] }
  ```
  Os `Hit` carregam só o que as telas já mostram (nunca `request_hash`, segredo, hash de senha). `label` = descrição curta. Cada hit linka para a tela de detalhe certa (`/admin/transacoes`, `/admin/saques/[id]`, `/admin/webhooks/[id]`, `/admin/clientes/[id]`).
- `buscar/page.tsx`: recebe `?q=`, chama `searchOperations`, mostra "Histórico operacional" paginado dos resultados agrupados por tipo; botões Consultar/Limpar/**Exportar resumo** (CSV via `csvResponse`, grava `export.search` na auditoria). `requireAdmin({ perm: "transacoes:ler" })` (admin-only já garantido).
- E-mail nos resultados **mascarado** (reusar a regra de e-mail mascarado do Sellers, Task 15).

- [ ] **Step 1: Teste** `tests/admin-search.test.ts`: busca por `end_to_end_id` acha a cobrança e o saque; por `txid` acha a cobrança; por nome acha o lojista; termo `' OR 1=1 --` / `%` **não** quebra a query nem traz tudo (parametrizado) e não vaza campo interno; `searchCsvRows` neutraliza célula com `=`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(admin): busca global de operação parametrizada e exportar resumo`.

---

### Task 15: Clientes/Sellers — tabela no molde Wavex + operação do cliente estendida

**Files:**
- Modify: `app/admin/clientes/page.tsx` (tabela Sellers: nome + `#id` + e-mail mascarado, **Conta**/**KYC**/**API**, Desde, botão **Operação**), `app/admin/clientes/[id]/page.tsx` (estender: usuários do cliente, MED do cliente, botão "Ajustar saldo" → pedido de quatro olhos da Task 8, link para saques/transações do cliente — a base já existe)
- Create: `app/admin/clientes/analise/page.tsx` (P1 — fila de análise de cadastro; **opcional nesta leva**), testes em `app/admin/admin.test.ts`

**Interfaces / UI:**
- `clientes/page.tsx`: manter abas de status e paginação que já existem; a **tabela** passa ao formato Wavex: coluna "Seller" = `tradeName` + `#<id curto>` + **e-mail mascarado** (`a•••@dominio`), **Conta** (Ativa/Suspensa/Pendente/Recusada — `StatusBadge kind="merchant"`), **KYC** (Aprovado / Em revisão — de `needsManualReview`/status), **API** (Liberada / Bloqueada — de `status==='active'`), **Desde** (`createdAt`), botão **Operação** → `/admin/clientes/[id]`. Subtítulo do bloco: "sem documento, telefone ou credenciais" (documento só na operação, mascarado). **Não reproduzir dados reais do print.** `requireAdmin({ perm: "clientes:ler" })`.
  - Helper novo `maskEmail(email): string` em `app/admin/admin-lib.ts` (reusado pela busca).
- `clientes/[id]/page.tsx` (estender o que já existe): adicionar seção "Usuários" (de `users` do merchant — e-mail, 2FA, último login; ações de usuário linkam para Equipe/Task 12), "MED do cliente" (reusar `listMedCases(merchantId,…)`), botão **"Ajustar saldo"** (abre formulário → `requestBalanceAdjustmentAction` da Task 8, com motivo obrigatório e step-up). Manter o documento completo só em revisão manual (regra `fullCnpj` já implementada).
- `clientes/analise/page.tsx` (P1): fila só de `pending`, mais antigos primeiro, mostrando `cnpjLookup` (razão social, situação, CNAEs) quando houver; recusar com **motivo** (grava `rejectionReason` — exige estender `rejectMerchant` para aceitar motivo, aditivo) e aviso ao lojista. *Se o tempo apertar, entregar só a tabela Sellers (P0/visual Wavex) e deixar a fila de análise para a próxima leva.*

- [ ] **Step 1: Teste** no `admin.test.ts`: a lista de Sellers mostra `#id`, e-mail mascarado (`maskEmail` nunca o e-mail cru) e os 3 selos Conta/KYC/API; a operação do cliente mostra "Ajustar saldo" só para quem tem `dinheiro:mover` e some para `suporte`; recusar com motivo grava `rejectionReason` (se a fila de análise entrar).
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS (testes de clientes da fase 1 seguem verdes).
- [ ] **Step 5:** Commit `feat(admin): Sellers no molde Wavex e operação do cliente estendida`.

---

### Task 16: Verificação, build, prova e revisão

**Files:** nenhum novo de produção; ajustes finos.

- [ ] **Step 1:** `npx vitest run` — tudo verde, inclusive os testes **da fase 1** (nada regrediu). `npx tsc --noEmit` limpo. `npx next build` sem erro.
- [ ] **Step 2: Migração no banco:** aplicar `drizzle/0005…0007` pelo MCP `apply_migration`; `get_advisors` = zero alertas de RLS (toda tabela nova com RLS ligado). *(Se o Supabase estiver pausado — ver memória — avisar o Lenda; não aplicar às cegas.)*
- [ ] **Step 3: Prova por mutação (papel no servidor):** um teste ao vivo/integração que forja um POST de `operador` e de `suporte` contra cada action sensível (taxa, aprovar cliente, ajuste, estorno, reset 2FA, aprovar quatro olhos) e confirma que **nada** é gravado — a prova de que o controle é servidor, não front. Mostrar a saída.
- [ ] **Step 4: Playwright como admin NOVO** (contexto limpo, 1440 e 390 px): entrar como `admin`, ver a Visão com gráficos; abrir Sellers; abrir um saque preso e "Consultar agora"; criar um pedido de ajuste de saldo como `operador` e aprovar como `admin` (ver o saldo mudar); abrir o monitor de webhooks e reenviar uma entrega falha; abrir a fila de MED por prazo; exportar auditoria e acessos (abrir o CSV e conferir que não tem segredo); usar a busca global por um E2E. Prints de cada passo.
- [ ] **Step 5:** `/code-review` no diff inteiro no nível `high` (foco: papel no servidor em toda rota/action, quatro olhos não-auto-aprovável, ajuste sem estouro/sem pular ledger, export sem segredo, busca parametrizada). Corrigir ou justificar cada achado. `supply-chain-risk-auditor` (não deve haver dependência nova).
- [ ] **Step 6:** Commit final e atualizar a memória do projeto (`project-vantri-gateway.md`: backoffice fase 2 no ar, papéis admin/operador/suporte no servidor, quatro olhos em dinheiro, deploy só por `scripts/deploy.sh`).

---

## Ondas de execução

| Onda | Tasks (paralelas dentro da onda) | Depende de |
|---|---|---|
| **1** | **1** (papéis + `requireAdmin` + migração `admin_role`) | — |
| **2** | 2 (schema aditivo) · 3 (casca Wavex) · 4 (auditoria/eventos nos serviços) | 1 |
| **3** | 5 (Visão) · 6 (fila MED) · 7 (auditoria/acessos) · 12 (equipe/usuários) · 10 (transações) | 1, 2, 3, 4 |
| **4** | 8 (quatro olhos + dinheiro manual) · 9 (saques op) · 11 (webhooks + saúde + cron) · 13 (tarifas) | 2, 3, 4 (9 e 8 acopladas: 9 pede pedido a 8) |
| **5** | 14 (busca global) · 15 (Sellers + operação do cliente) | 3, 8, 12 |
| **6** | 16 (verificação, build, prova, review) | todas |

> Dentro de cada onda as tarefas tocam arquivos disjuntos (serviços em `lib/services/admin/<nome>.ts`, telas em pastas próprias). O orquestrador commita ao fim de cada onda; agentes paralelos não commitam. **Task 1 é obrigatoriamente primeiro** — todas as outras chamam `requireAdmin({ perm })` e a maioria lê `user.adminRole`.

## Fora deste plano (P2 do mapa — não construir)

Limites e risco por lojista (`merchant_limits`, lista de bloqueio), "Ver como o lojista", conciliação bancária linha-a-linha com o parceiro (`reconciliation_items`), KYC documental (upload de contrato social/selfie), envio real de defesa de MED, "Abrir conta no parceiro" para contas `sim_`. Tudo isso é **plano 2 / P2** e entra quando o parceiro real for ligado ou o volume pedir. As telas que dependem do parceiro aparecem marcadas **"requer parceiro"** e desabilitadas no simulador.
