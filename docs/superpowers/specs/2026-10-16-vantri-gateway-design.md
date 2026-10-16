# Vantri — gateway Pix para venda digital (design)

**Data:** 16/10/2026 · **Dono:** Lenda · **Referência técnica:** `C:\tmp\cashyin-engenharia-reversa\RELATORIO.md` e `anexos\openapi-cashyin.json`

## Intenção

O Lenda quer um gateway de Pix "igual à Cashyin" — vitrine com a mesma estrutura e animações, painel do lojista, painel admin e API pública — com marca própria, funcionando com dinheiro real através de parceiros de Pix que ele já tem. Público: **infoprodutores e venda digital** (cursos, mentorias, e-books, comunidades, SaaS, eventos online).

## Decisões dele (literais)

- "faça tudo no automático" → nome, marca, stack e defaults são decisão do builder.
- Cadastro: "pode ter a opção de cadastrar e eu enviar as credenciais" → **dois caminhos**: cadastro pelo site (aguarda aprovação) **e** admin cria a conta e repassa login + senha temporária.
- Taxa: "posso ir mudando em % ou fixo" → por cliente, percentual e/ou fixo, Pix recebido e enviado separados, editável no admin.
- Hospedagem: Vercel.
- "dinheiro real" → produção com parceiro real. Parceiro **ainda não nomeado** → este design entrega o adaptador plugável + simulador; a integração do parceiro é um plano separado assim que ele disser o nome.

## Recusado e por quê

- **Bets:** o Lenda pediu "infoprodutos e bet". A MP 1.394/2026, art. 1º, proíbe "a exploração, a oferta, a intermediação e a publicidade" de apostas de quota fixa no território nacional desde 25/09/2026. O gateway **não atende bets**: segmento de aposta não existe no cadastro, CNPJ com CNAE 9200-x é recusado, e os termos proíbem.

## Objetivos

1. Vitrine em `/` com a estrutura da Cashyin (hero com mock do painel, faixa, contadores, recursos animados, bloco dev com webhook, preço, FAQ, CTA, rodapé), identidade Vantri, **sem nenhuma alegação inventada** (nada de volume processado, nº de clientes, nota, logo de cliente, "homologado").
2. Painel do lojista: login com 2FA (TOTP) obrigatório, dashboard, cobranças Pix com QR, extrato com CSV, saque com código 2FA, chaves de API com escopos e allowlist de IP, webhooks com histórico e reenvio, MED com defesa (texto + anexos).
3. Painel admin: clientes (aprovar, criar e mostrar credenciais uma vez, suspender, taxa), todas as transações, MED (abrir no simulador, encerrar).
4. API REST `/api/v1` no molde da Cashyin, com o que ela não tem: assinatura de webhook com timestamp, idempotência documentada, OpenAPI 3.1 servida em `/api/v1/openapi.json` e página `/docs`.
5. Conformidade RC 16/2025: cada lojista tem conta própria no parceiro (`createAccount` no adaptador ao aprovar); rodapé e termos dizem que a Vantri **não é instituição autorizada pelo BCB** e nomeiam o parceiro.

## Não-objetivos (agora)

- Integração com o parceiro real (plano 2, depende do nome).
- Ambiente de teste separado por chave (sk_test/sk_live) — um ambiente por deploy, escolhido por `PIX_PROVIDER`.
- Split, cartão, boleto, e-mail transacional, app mobile, multiempresa por login.

## Anti-objetivos

- Conta bolsão (saldo de todos numa conta só).
- Qualquer número, depoimento, logo ou selo sem lastro.
- Atender apostas.

## Restrições

- Next.js 15.5.28 (App Router) + TypeScript + Tailwind 4, hospedado na Vercel; Postgres (Supabase) via Drizzle; testes com Vitest + PGlite.
- Dinheiro sempre em centavos inteiros; taxa percentual em pontos-base (1,49% = 149).
- Checklist de lançamento do Zeus (20 itens) antes do deploy.
- Marca: **Vantri** (vantri.com.br livre em 16/10/2026). Sem "Pix", "banco" ou "bank" no nome.

## Deixado ao builder

Paleta, tipografia, logo, textos da vitrine (sem alegações), nomes internos, layout das telas.
