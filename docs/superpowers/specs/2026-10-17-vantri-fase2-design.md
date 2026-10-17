# Vantri — Fase 2: interior completo (design)

**Data:** 17/10/2026 · **Dono:** Lenda · **Mapa detalhado (fonte da verdade das telas):** `docs/superpowers/specs/2026-10-17-paridade-cashyin.md` (Partes 1, 2 e 3).

## Intenção

A fase 1 entregou o motor (cobrança, saque, extrato, webhooks, chaves, MED, API, vitrine, painel da loja e admin **básicos**), pronto e revisado. O Lenda viu o admin "vazio" e pediu o **interior completo com todas as opções**, no nível de um gateway de verdade, usando como molde o painel da Cashyin (mapeado) e o backoffice da **Wavex** (print que ele mandou: menu Atendimento/Integrações/Compliance, Sellers com status de Conta/KYC/API, busca de operação, exportar resumo). Decisão dele: **construir tudo primeiro, publicar no fim**, agentes em paralelo.

## Princípios (não se dobram)

- **Sincronia:** loja, admin e API usam os MESMOS serviços (`lib/services/*`, `lib/money/ledger.ts`). Toda tela nova consome serviço, nunca fala com o banco por fora do que já existe. Um número só, uma fonte só.
- **Segurança por cima (Zeus camada 7):** todo papel é checado NO SERVIDOR (não só escondendo botão); IDOR impossível (id sempre da sessão/escopo); nada de dado pessoal em log; o `cyber-chief`/checklist roda antes de publicar.
- **Honestidade:** nada de alegação falsa; a faixa "ambiente de demonstração" continua enquanto o Pix for simulado; o que depende do parceiro real (plano 2) fica claramente marcado e não finge funcionar.
- **Mobile:** tudo funciona a 390 px (a Cashyin falha nisso — a Vantri não copia esse defeito).
- **Não copiar os defeitos da Cashyin** (mapa, Resumo §3): sem menu no celular, filtros só da página carregada, retomada só na memória, erro cru, papel só no front, uma chave por conta. A Vantri faz melhor.

## Escopo — Plano A: painel do lojista (app/painel + app/conta)

Telas novas / completadas (detalhe campo-a-campo no mapa, Parte 1):
1. **Início rico:** seletor de período, entradas × saídas com variação, gráfico de fluxo (SVG, sem lib pesada), últimas transações, resumo do dia, alertas (webhook falhando, saldo bloqueado, MED com prazo curto), limites Pix (texto; valores reais = plano 2).
2. **Extrato completo:** filtro por tipo/data/busca, saldo corrido após cada lançamento, cards do período, Fecho Diário (data + saldo), export CSV **e XLSX**.
3. **Transações:** lista de cobranças e saques com detalhe lateral (abas) e, para saque, **comprovante** imprimível (PDF simples gerado no servidor; dados bancários completos = plano 2).
4. **Saque:** assistente Dados → Revisão → Verificação (TOTP) → Confirmação; **saque parcelado acima de um teto** (divisão gulosa, lote idempotente, retomar parcela que falhou — e, diferente da Cashyin, a retomada **persiste** no banco, não só na memória). Teto configurável; sem parceiro vale um default.
5. **Depósito/Receber:** QR com valor e descrição (já existe em cobranças; consolidar a nomenclatura).
6. **Integrações completas:** chaves (já ok); **webhooks**: criar, **editar, ativar/desativar, excluir, novo segredo, testar envio** (a Vantri terá o que a Cashyin não tem), inspetor de entregas com tentativas/filtros, saúde por faixa; allowlist com **CIDR** e "testar IP".
7. **Recuperar senha ("esqueci minha senha"):** depende de e-mail transacional → ver "Decisão pendente".
8. **Busca** por E2E / TxID / referência / nome.
9. **Conta/segurança:** trocar senha (ok), **resetar/reconfigurar 2FA pelo próprio dono** (com senha), ver sessões.

## Escopo — Plano B: admin/backoffice (app/admin) — molde Wavex

Telas novas (detalhe no mapa, Parte 3; ordem P0 → P1):
1. **Visão do suporte (home):** cartões + **gráficos por dia e por lojista** (volume, nº de Pix, saques, MED), saldos agregados, fila de pendências.
2. **Clientes/Sellers:** tabela com nome + #id + e-mail mascarado, **Conta (Ativa/Suspensa), KYC, API (Liberada)**, Desde, botão **"Operação"** → tela do cliente (saldo, transações, saques, taxas, MED, usuários, documento mascarado; completo só em revisão manual).
3. **Transações PIX (todos):** filtros por lojista/status/data, detalhe, export.
4. **Saques (todos):** operação (ver status, reenviar consulta), export.
5. **Monitor de webhooks:** entregas falhando, por lojista, reenvio.
6. **Fila de MED** ordenada por prazo, com ação (no simulador: abrir/encerrar; em produção: acompanhar).
7. **Auditoria:** tela do `audit_log` (hoje só grava, sem tela) + **registros de acesso (Marco Civil)** com filtro e **exportação**, e a limpeza de 6 meses no cron.
8. **Equipe e papéis:** usuários do admin com papéis **checados no servidor** (admin/operador/suporte), regra de "quatro olhos" em ajuste manual de saldo e estorno.
9. **Planos de tarifa, saúde do cron, busca global de operação, exportar resumo.**

## Não-objetivos da fase 2

- Integração com o parceiro real (plano 2). O que depende dele (DICT, Pix devolvido, devolução de cobrança, dados reais de MED, limites, conciliação bancária, split) é construído como **tela + serviço com o simulador**, marcado "requer parceiro" onde o dado real não existe.
- Maquininhas POS (a Vantri é só Pix).
- Multiempresa por login (fica para depois).

## Mudanças de dados previstas (detalhe no mapa)

Novas tabelas/colunas: usuários de admin com papel; retomada de lote de saque persistida; webhook endpoints com `active` editável e histórico de segredo; índice de busca por E2E/TxID; (e-mail transacional se a recuperação de senha entrar). Toda migração nova é aditiva e liga RLS.

## Decisão pendente do Lenda (não trava o resto)

- **"Esqueci minha senha" e verificação de e-mail** precisam de um serviço de e-mail transacional (Resend/Postmark/SES). Isso é uma conta/credencial nova. Enquanto ele não escolher, a recuperação de senha fica como "admin reseta" (já previsto no backoffice) e o cadastro segue sem verificação de e-mail. Perguntar antes de construir a tela de recuperação por e-mail.

## Deixado ao builder

Layout fino de cada tela (seguindo a marca Vantri já existente e o molde Wavex), nomes internos, componentes compartilhados em `app/components/ui/`.
