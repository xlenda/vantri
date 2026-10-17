# Paridade Cashyin × Vantri: o painel inteiro, tela por tela

**Coleta:** 16/10/2026 · **Documento:** 17/10/2026 · **Dono:** Lenda · **Repositório:** `C:\tmp\vantri` (sem commit)

**Fontes, todas já em disco e públicas.**
- Bundle JS do painel `finance.cashyin.com`: `index-Bnidu1sJ.js`, formatado em `scratchpad/cashyin/painel/pretty/index.js`, com 17.908 linhas.
- Os 33 arquivos de texto do painel (pt-BR, en, zh).
- O MVP público no GitHub (junho/2026).
- A OpenAPI e os anexos 1 e 2 de `C:\tmp\cashyin-engenharia-reversa`, mais os prints.
- Do lado da Vantri: `app/painel`, `app/admin`, `app/entrar`, `app/conta`, `app/cadastro` e `lib/`.

**Limites.**
- Nenhuma requisição a host da Cashyin, nenhum login, nenhum formulário enviado.
- Nada do código deles foi copiado para a Vantri. Este documento descreve comportamento, campos e o sentido dos textos para reimplementar com marca e palavras próprias.
- Os textos de interface aparecem entre aspas só para registrar o que a tela diz.

**Como foi feito.** Oito leitores em paralelo, cada um com uma faixa de linhas do bundle e os textos correspondentes. Os achados mais fortes foram conferidos direto no código:
- a divisão do saque parcelado;
- a lista de rotas sem menu no celular;
- a regra de saúde do webhook;
- o "Novo secret" que só gira o primeiro endpoint;
- o Fecho Diário com duas colunas;
- as regras de senha;
- a ausência de `failure_code` e de `refetchInterval`.

**Legenda.** [O] = observado no código ou no print · [I] = inferido.

---

## 0. Resumo

1. **O que o painel da Cashyin é.**
   - 11 telas internas: Início, Extrato, Transferências, Receber, Infrações (lista e detalhe), Integração & API (3 abas), PIX, Splits, Documentação e 404.
   - 3 telas de acesso: login com MFA e primeiro acesso, recuperar senha, seleção de conta.
   - 46 procedures tRPC e 10 rotas REST de autenticação.
   - Nada se atualiza sozinho: não há polling em lugar nenhum.
2. **Onde ele é forte.**
   - Busca no índice por E2E/TxID/referência/nome em 12 meses.
   - Fecho Diário com exportação CSV/XLSX.
   - Assistente de saque em 4 passos com TOTP sempre.
   - **Saque parcelado acima de R$ 15 mil.** A divisão é gulosa: parcelas cheias e o resto na última. Vai num lote com chave de idempotência e retomada a partir da parcela que falhou.
   - Allowlist com CIDR e "testar IP".
   - Webhooks com saúde, inspetor de entrega e reenvio.
   - MED com 6 KPIs e linha do tempo "recebida via DICT".
3. **Onde ele é fraco** (não copiar):
   - no celular as telas principais ficam **sem menu**;
   - filtros e KPIs valem só para a página carregada;
   - a retomada do lote vive só na memória do navegador;
   - erro cru do servidor;
   - papel checado só na interface (um "Auditor" consegue transferir);
   - uma chave de API por conta;
   - "Testar webhook", Splits, exportar infrações e histórico são "em breve".
4. **A Vantri já tem o núcleo** (cobrança, extrato com CSV, saque com 2FA, chaves, webhooks com reenvio, MED com defesa) e **está na frente** em:
   - cadastro self-service com Receita;
   - simulador;
   - assinatura de webhook com timestamp;
   - várias chaves por conta;
   - validação da chave Pix antes do 2FA;
   - tarifa visível;
   - validade da cobrança;
   - API de listagem;
   - OpenAPI 3.1;
   - painel admin;
   - funciona no celular.
5. **Lacunas de maior valor:**
   1. esqueci minha senha (não existe);
   2. detalhe e comprovante do saque;
   3. gestão completa de webhook com "testar envio";
   4. inspetor de entregas;
   5. extrato com filtros, saldo após e fechamento diário;
   6. busca por E2E/TxID;
   7. Início com período e alertas;
   8. MED com KPIs, linha do tempo e defesa pela API;
   9. equipe com papéis checados no servidor.
6. **O que depende do parceiro real (plano 2):** consulta DICT do favorecido, Pix devolvido, devolução de cobrança, dados reais de MED, limites, dados bancários no perfil e comprovante, conciliação, split. Todo o resto dá para fazer já com o simulador.
7. **Backoffice proposto, nesta ordem:**
   - **P0 (antes do dinheiro real):** papéis no admin com quatro olhos, razão e conciliação, operação de saques, fila de MED por prazo, monitor de webhooks, auditoria e registros de acesso do Marco Civil, saúde do cron.
   - **P1:** cadastro/KYC, gráficos, saldos, usuários, planos de tarifa, exportações.
   - **P2:** limites e risco, "ver como o lojista".

---

## Parte 1 — O painel do lojista da Cashyin, tela por tela

**Stack observada.** SPA React 19 + Vite, roteador wouter, tRPC v11 + TanStack Query, shadcn/Radix + Tailwind 4, Recharts, i18next, sonner. A casca segue o template web-app da Manus ("Please login (10001)", ErrorBoundary em inglês com "Reload Page"); o MVP de junho era Lovable/TanStack. O bundle chama **46 procedures tRPC** distintas. O anexo 2 contou 45; a lista completa está em 1.16. [O]

### 1.0 Casca: navegação, saldo, conta, sessão, papéis e idiomas

**Barra lateral** (desktop, a partir de 768 px; largura fixa de 256 px, sem recolher). De cima para baixo:
1. Logo, com link para `/`.
2. **Card de saldo**, que só aparece para login `cognito`:
   - rótulo "Saldo disponível" e valor em R$;
   - linha "Ag 0001 · Conta {n} · há 2 min" (a agência padrão é "0001"; o "há X min" não avança sozinho);
   - botões **"Receber"** (→ /deposit) e **"Transferir"** (→ /transfers);
   - olho "Ocultar saldos"/"Mostrar saldos".
3. **Menu**, nesta ordem exata:
   - "Início" (/);
   - **Pagamentos**: Extrato, Transferências, Infrações, Splits;
   - **Banking**: Receber;
   - **Conta**: Integração & API.
4. **Seletor de idioma** em largura total: "Português (BR)", "English" ou "中文".
5. **Rodapé do usuário**:
   - avatar com iniciais, nome, e-mail e documento mascarado (CNPJ `**.345.678/****-**`);
   - selo do papel: "Administrador", "Operador" ou "Auditor";
   - menu "Conta e sessão": o e-mail, "Ocultar/Mostrar saldos" (só para não-Cognito), "Trocar conta" (só com mais de uma conta) e "Sair" (vermelho). [O]

O item ativo casa por prefixo (o "Início" só com o caminho exato).

**Fora do menu:** `/pix`, `/documentacao`, `/infractions/:id`, as abas de `/integrations` e as telas de acesso. A chave "Documentação" existe nos textos, mas não está no menu.

O mock de barra lateral que a landing mostra (PAGAMENTOS: Transações, Saque, Extrato, Splits · ADQUIRENTES: PIX · BANKING: Depósito, Transferência · DESENVOLVEDORES: Chaves de API, Webhooks) é **o menu do MVP**, que não existe mais: a vitrine vende uma navegação antiga. [O]

**Regra do clientId fixo.** Só a conta `73b08c9f-…` vê, no card de saldo, um bloco de liquidação: razão social, "CNPJ … · {instituição}". O documento aparece completo. É uma feature flag por UUID no front, provavelmente a conta da casa. [O/I]

**Topo.** Cada página tem seu cabeçalho: título, subtítulo, um chip com o nome da conta e um botão "Perfil". **Os dois botões da direita não fazem nada.** O seletor global "Hoje / Semana / Mês" existe no código, mas é cosmético: nenhuma página o lê, e ele só aparece em `/documentacao`. Não há botão de tema nem de perfil funcional. [O]

**Perfil, configurações e segurança da conta: não existem.** [O]
- Não há rota de perfil nem de configurações. O botão "Perfil" do topo não faz nada.
- Logado, não dá para trocar a senha (só pelo "Esqueci minha senha", deslogado).
- Não dá para reconfigurar ou desligar o 2FA, nem ver ou derrubar sessões abertas.
- Não há convite de usuários nem tela de equipe: quem cria usuário e define papel é a equipe da Cashyin.
- As únicas "configurações" self-service são as de Integração & API.

**Celular: o painel fica sem navegação.** [O]
- Abaixo de 768 px a lateral some.
- O topo com hambúrguer (menu, saldo, sair) só é desenhado nas rotas que **não** estão na lista "full-bleed". Essa lista inclui **todas** as rotas principais.
- Resultado: no celular, Início, Extrato, Transferências, Infrações, Splits, Receber, Integração e PIX ficam sem menu, sem saldo, sem sair e sem idioma. Só se navega por links dentro das páginas.
- Defeito grave. Não copiar.

**Ocultar saldos.**
- Guardado no navegador (`cashyin-hide-balances`); troca valores por "••••••".
- O liga/desliga fica no card da lateral, no menu da conta ou no Início.
- O logout apaga a escolha.
- Há vazamentos (ver 1.4 e 1.6).

**Sessão e guarda de rota.**
- Toda rota interna consulta `auth.me` (`id, name, email, role, loginMethod, locale, needsAccountSelection`) e `auth.status`.
- Enquanto carrega, mostra um spinner em tela cheia.
- Sem sessão, olha `auth.status`: `pending_role` ou `disabled` vão para `/login?reason=role_required` ("Acesso ainda não liberado"); qualquer outra coisa vai para `/login`.
- Falha de rede mostra "Não foi possível carregar sua sessão. Verifique sua conexão e tente novamente." e o botão "Tentar novamente".
- Com `needsAccountSelection`, toda rota manda para `/select-account`.
- Logout e erro 10001 limpam o `localStorage` (menos `theme` e `sidebar-width`) e o `sessionStorage`.
- Não há timer de inatividade.
- CSRF: header `x-cashyin-csrf: 1` em tudo. Se vier 403 `csrf_required`, a página recarrega uma vez com `?_cv=`. [O]

**Papéis.**

| Papel | Rótulo | O que muda no front |
|---|---|---|
| `admin` | Administrador | tudo |
| `operator` | Operador | não revoga chave de API |
| `viewer` | Auditor | não cria nem gere chaves, IPs e webhooks (os botões somem) |
| `user` | (pendente) | barrado pela guarda (`pending_role`) |

O menu é o mesmo para os três papéis.

Login `cognito` conta como dono, qualquer que seja o papel. Como o login normal do painel é Cognito, é possível que **na prática ninguém sofra restrição no front** (ver 1.18).

Telas que **não olham papel nenhum**: Receber, Transferências, Extrato (inclusive exportar) e Infrações (inclusive enviar defesa). Ali um "Auditor" vê e usa os formulários; se houver bloqueio, ele está só no servidor. [O]

**Idiomas.**
- pt-BR (padrão), en e zh.
- Ordem de detecção: escolha salva → idioma do navegador → `lang` do HTML.
- Trocar de idioma logado grava no servidor (`users.setLocale`). Na entrada, o app adota o idioma da conta.
- Dinheiro sempre em BRL no formato pt-BR, mesmo em en/zh. Percentual com ponto ("12.3%").
- Datas sempre em America/Sao_Paulo. "16 out 2026 · 14h05 (BRT)" e "Sexta-feira, 16/10/2026 às 14h05" ficam fixos em pt-BR.
- Partes sem tradução: a 404, os nomes dos papéis, o menu do celular, várias mensagens novas (CSRF, busca por identificador, índice) e o ErrorBoundary (inglês). Em en/zh a interface fica misturada.

**Toasts.** São do sonner, no canto inferior direito, e não há toast global de erro. Muitos `onError` mostram **a mensagem crua do servidor**. Erros esperados (10001, 10002, FORBIDDEN, `step_up_mfa_invalid`, cancelamento) não vão para o Sentry.

**Tema.** Claro. O contexto aceitaria escuro, mas não há botão.

### 1.1 `/login` — Acesso (com MFA e primeiro acesso)

**Layout.** São duas colunas a partir de `lg`; no celular, uma só.

- **Coluna esquerda** (só no desktop), em gradiente menta:
  - logo;
  - pílula "Painel Cashyin";
  - título "Gerencie pagamentos, transferências e PIX com segurança.";
  - parágrafo "Tudo o que você precisa para acompanhar suas operações em um só lugar, com proteção em cada etapa.";
  - 3 cartões:
    - "Acesso protegido": "Login com verificação em duas etapas e confirmação extra em operações sensíveis."
    - "Acompanhe suas operações": "Saldo, extrato, PIX e transferências com visão em tempo real."
    - "Ambiente confiável": "Seus dados e movimentações ficam protegidos de ponta a ponta."
  - rodapé "© {ano} Cashyin. Todos os direitos reservados."
- **Coluna direita** (máx. 384 px):
  - "Acesse o painel";
  - "Entre com seu e-mail e senha. Operações sensíveis pedem uma confirmação extra em duas etapas.";
  - formulário;
  - caixa fixa embaixo: "Sua segurança em primeiro lugar. Operações sensíveis pedem uma confirmação em duas etapas, mesmo após o login. Todas as ações ficam registradas para sua proteção." [O, print + código]

**Campos.**
- **E-mail**: `type=email`, placeholder "seu@email.com". Cada tecla apara as pontas e passa para minúsculas.
- **Senha**: placeholder "Digite sua senha". **Sem olho** (botão de mostrar/esconder).
- O link "Esqueci minha senha" fica na linha do rótulo da senha.
- O botão "Entrar" (ícone de chave) vira só um spinner enquanto envia.
- Só existe validação nativa do navegador.
- **Não existe:** criar conta, "lembrar de mim", login social, captcha, seletor de idioma e seletor de tema.

**Envio.** `POST /api/auth/login {email, password}`. Pelo campo `status` da resposta:

| Resposta | O que acontece |
|---|---|
| `ok` | Navegação completa para `/select-account` (se `needsAccountSelection`) ou `/` |
| `mfa_required` + `mfaSession` | Estado **MFA** |
| `mfa_setup_required` | Chama sozinho `POST /api/auth/mfa-setup/associate` e vai para **Configurar 2FA** |
| `new_password_required` | Estado **Nova senha** |
| `csrf_reload` | Recarrega sem mostrar erro |

**Erros** (banner vermelho acima do formulário, some no próximo envio):

| Código | Texto |
|---|---|
| `invalid_credentials` (e 401 sem corpo) | "E-mail ou senha inválidos." |
| `mfa_invalid` | "Código de verificação inválido. Tente novamente." |
| `mfa_expired` | "A sessão de verificação expirou. Faça login novamente." |
| `invalid_password` | "Senha inválida. Use ao menos 12 caracteres com letras maiúsculas, minúsculas, número e símbolo." |
| `auth_provider_not_enabled` | "Login por Cognito não está habilitado neste ambiente." (vaza o Cognito) |
| `csrf_skew` | "Uma atualização do portal está disponível. Recarregue a página (Ctrl+F5) e tente novamente." |
| rede | "Falha de conexão. Verifique sua rede e tente novamente." |
| outros | a mensagem do servidor, ou "Não foi possível concluir o login. Tente novamente." |

Bloqueio por tentativas e rate limit não têm texto próprio no login.

`?reason=role_required` mostra o banner âmbar "Acesso ainda não liberado", com o texto: "Sua conta foi autenticada mas ainda não tem permissão de acesso. Solicite a um administrador a liberação antes de tentar novamente." Quem manda para essa URL é o guarda de rota, quando `auth.status` vem `pending_role` ou `disabled`. Por isso uma conta desativada vê o mesmo texto de "ainda não liberado". [O]

**Estado MFA** ("Verificação em duas etapas").
- Campo "Código do app autenticador (TOTP)" com 6 caixas e a dica "Digite os 6 dígitos gerados pelo seu app autenticador."
- Envio **automático** ao completar os 6 dígitos (digitando ou colando). O botão "Verificar e entrar" também existe.
- Chama `POST /api/auth/mfa {email, code, mfaSession}`.
- Código errado: as caixas ficam vermelhas, **tremem**, são limpas e o foco volta.
- `mfa_expired` volta para e-mail/senha.
- "Voltar" mantém o e-mail e a senha preenchidos.
- Rodapé: "Perdeu o acesso ao seu app autenticador? Fale com o suporte", com link mailto para o e-mail de suporte.
- Não há código de recuperação, SMS nem "lembrar este dispositivo".

**Primeiro acesso.** A conta é criada pela equipe com senha temporária.

1. **"Defina uma nova senha"**: "Sua conta foi criada com uma senha temporária. Defina uma nova senha para concluir o acesso."
   - Campos "Nova senha" e "Confirmar nova senha", **com** olho. A confirmação fica com borda vermelha se não bater.
   - **Regras** (todas obrigatórias): pelo menos 12 caracteres; uma maiúscula A–Z; uma minúscula a–z; um número; um símbolo (qualquer coisa fora de A–Z, a–z e 0–9; espaço e letra acentuada contam).
   - **Medidor**: "Fraca" (0–2 regras, vermelho), "Média" (3–4, âmbar), "Forte" (5, verde). Vem com checklist ✓ das 5 regras e de "As senhas coincidem", e anuncia para leitor de tela.
   - "Salvar e continuar" fica desabilitado até tudo passar.
   - Chama `POST /api/auth/new-password {email, newPassword, mfaSession}`.
2. **"Configurar verificação em duas etapas"**: "Escaneie o QR code no seu app autenticador (Google Authenticator, Authy, 1Password) ou cadastre a chave manualmente. Depois informe o código gerado para concluir."
   - Mostra a "Chave (configuração manual)" em texto mono, **sem botão de copiar**, acima do QR (176 px, gerado no navegador a partir da `otpauthUri`).
   - Código de 6 caixas com envio automático e o botão "Concluir e entrar".
   - Chama `POST /api/auth/mfa-setup/verify`.
   - Não tem "Voltar" nem códigos de backup.

### 1.2 `/forgot-password` — Recuperar acesso

Usa a mesma casca do login. Título "Recuperar acesso", subtítulo "Enviaremos um código para o seu e-mail para você definir uma nova senha."

1. **E-mail.** Botão "Enviar código" e o link "← Voltar para o login". Chama `POST /api/auth/password/forgot {email}`. O fluxo **sempre avança**, exista ou não a conta.
2. **Código + nova senha.** A frase é neutra: "Se houver uma conta para {email}, enviamos um código de verificação. Informe o código e defina uma nova senha."
   - Campo "Código de verificação": input simples, só dígitos, até 8, placeholder "000000".
   - "Nova senha" e "Confirmar nova senha" com o mesmo medidor e as mesmas regras.
   - Botão "Definir nova senha" chama `POST /api/auth/password/confirm {email, code, newPassword}`.
   - O link "Não recebi o código — solicitar novamente" volta ao passo 1 com o e-mail mantido. Não reenvia sozinho e não tem contador.
3. **Sucesso.** "Senha alterada com sucesso. Você já pode entrar com a nova senha. A verificação em duas etapas continua válida no login." e o botão "Ir para o login".

Erros:
- "Código de verificação inválido. Confira o e-mail e tente novamente."
- "O código expirou. Volte e solicite um novo código."
- `limit_exceeded` ou 429: "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente."
- "A recuperação de senha não está habilitada neste ambiente."

### 1.3 `/select-account` — Seleção de conta (multiempresa)

**Quando aparece.**
- Se a sessão vem com `needsAccountSelection`, qualquer rota redireciona para cá e o painel não renderiza.
- Se a sessão não precisa escolher, esta rota manda para `/`.

**Tela.**
- Cartão central (máx. 512 px): "Selecione a conta" / "Escolha a conta para continuar."
- Lista vinda de `accounts.accessible`. Cada linha é um botão com:
  - número da conta (`clientNumberDisplay` ou `accountNumber`), em mono;
  - nome (`legalName` → `tradeName` → e-mail), com capitalização corrigida ("EMPRESA X LTDA" vira "Empresa X Ltda");
  - documento (`documentDisplay`), em mono.
- Não tem busca, papel nem saldo.
- Estados: carregando mostra spinner; erro mostra "Não foi possível carregar as contas."; lista vazia mostra uma caixa vazia, sem texto.
- Rodapé: "Ao acessar a conta, você concorda com os nossos termos de uso." Texto sem link.

**Abrir uma conta.** Chama `POST /api/auth/accounts/start {clientId}`.
- `ok`: navegação completa para `/`.
- `mfa_required`: pede o **TOTP da conta escolhida** ("Digite o código do autenticador da conta {nome}."). Aqui **não** envia sozinho.
  - Chama `POST /api/auth/accounts/mfa {clientId, code, mfaSession, switchProof?}`.
  - Erro: "Código de verificação inválido."
- [I] Cada conta parece ter identidade e TOTP próprios no Cognito. `switchProof` prova que a troca nasceu de uma sessão já autenticada.

**Voltar a ela.** "Trocar conta" fica no menu "Conta e sessão". Só aparece com `loginMethod = "cognito"` e mais de uma conta acessível. Chama `POST /api/auth/accounts/picker` e depois navega para `/select-account`.

**Segurança no cliente (todas as telas de acesso).**
- Sessão em cookie, e todas as chamadas levam o header `x-cashyin-csrf: 1`.
- Se o servidor recusa por CSRF (403 `csrf_required`), a página recarrega uma vez com `?_cv=` (no máximo uma vez por minuto). Na segunda recusa aparece o texto de "atualização do portal".
- `mfaSession` e `switchProof` ficam só na memória: recarregar no meio obriga a refazer o login.
- Não há timer de inatividade.
- O erro "Please login (10001)" limpa o `localStorage` (mantém só `theme` e `sidebar-width`) e manda para `/login`.
- Nenhuma tela de acesso usa toast, só banners.
- O texto `csrf_skew` não existe em en nem em zh: aparece em português.

### 1.4 `/` — Início (dashboard)

**Propósito.** Mostrar o resumo do período: entradas, saídas, saldo, fluxo de caixa, últimas movimentações, resultado do dia, alertas e limites. Não tem polling. Atualiza só no botão ou ao trocar o período; recarregar ao focar a janela está desligado. O único automatismo é um timer que vira o "Resumo do dia" à meia-noite de Brasília. [O]

**Período padrão: "Este mês"** (do dia 1 até hoje, no fuso de Brasília). Comparação com o período anterior: é uma janela **de mesma duração** que termina 1 ms antes do início do atual. Não é o mesmo intervalo do mês anterior: o período 1–16/out compara com 15/set–30/set. [O]

**Chamadas.**
- `pix.balance`.
- `statement.summary` três vezes: período atual, período anterior e **hoje**.
- `statement.list {from, to, limit: 6}`.
- `webhooks.listDeliveries {status: "failed", limit: 1}`, usado no alerta.
- `pix.limits`, chamado pelo card de limites.
- Retry automático só em SERVICE_UNAVAILABLE e TOO_MANY_REQUESTS: 2 tentativas extras, esperando 1 s e depois 2 s (teto de 4 s). [O]

**Blocos, na ordem.**
1. **Cabeçalho.** Título "Início" e o subtítulo "{Bom dia|Boa tarde|Boa noite}, {nome} — aqui está o resumo da sua operação". A saudação segue a hora de Brasília: antes de 12 h, antes de 18 h, depois disso. O nome vem de `fullName`, depois `name`, senão "usuário".
2. **Barra.** Tem o seletor de período, o botão "Atualizar" e o botão "Ocultar saldos"/"Mostrar saldos" (ícone de olho). "Atualizar" recarrega saldo, os resumos e a lista, mas não recarrega webhooks nem limites.
3. **Faixa de erro (amarela).** Aparece só quando há código tRPC. A ordem de prioridade é lista, depois resumo, depois saldo. Textos por código:
   - FORBIDDEN: "Sua conta ainda não tem permissão para acessar estes dados. Fale com o administrador…"
   - PRECONDITION_FAILED: "Sua conta não tem um cliente vinculado…"
   - SERVICE_UNAVAILABLE ou TOO_MANY_REQUESTS: "Serviço temporariamente indisponível…"
   - Qualquer outro: "Não foi possível carregar os dados do período. Tente novamente."
   - Erro de rede sem código não mostra faixa.
4. **Três cards de KPI.**
   - **"Entradas do período"** (faixa verde no topo). Abaixo do valor:
     - "{n} Pix recebidos · ticket médio {R$}", com ticket = arredondamento de pagos ÷ quantidade;
     - "Sem Pix recebidos no período" quando não houve nenhum.
   - **"Saldo disponível"** (central, com gradiente). Abaixo do valor: "Bloqueado", "Saldo em MED" e "Total". Tem o olho próprio "Alternar visibilidade do saldo". Não depende do período. Se der erro, mostra "—".
   - **"Saídas do período"** (faixa vermelha). Abaixo do valor: "{n} transferências · taxa total {R$}".
   - **Delta** "+12.3% vs. período anterior" (uma casa decimal, com **ponto**):
     - cálculo: (atual − anterior) ÷ anterior;
     - fica oculto se o período anterior for ≤ 0;
     - cor: em Entradas, subir é verde; em Saídas, subir é vermelho.
5. **"Fluxo de caixa"** (2/3 da largura) e o link "Ver extrato →".
   - Gráfico: Recharts **AreaChart** com duas áreas *monotone*, "Entradas" (verde) e "Saídas" (vermelha). As áreas não são empilhadas e têm preenchimento em gradiente.
   - Eixo Y oculto. Grade só horizontal. Eixo X com rótulo "dd/mm".
   - Tooltip em R$, ou "••••••" com os saldos ocultos.
   - Legenda acima do gráfico com o total de cada série. Altura de 224 px.
   - A granularidade (hora ou dia) vem do servidor (`summary.series[{label, inflowCents, outflowCents}]`).
   - Estados: carregando mostra barras-esqueleto; vazio mostra "Sem dados de fluxo no período."
6. **"Últimas transações"**: até 6 itens, com o link "Ver extrato →".
   - Ícone por tipo: entrada verde, saída vermelha, tarifa âmbar.
   - Título: a descrição limpa. Tarifa vira "Taxa Administrativa"; descrição genérica como "pix sent" cai no rótulo do tipo.
   - Chips de tipo e de status.
   - Linha de baixo: "Taxa R$ x" com até 5 casas decimais (`feeExactMillicents`) e o tempo relativo.
   - À direita: "+ R$"/"− R$" e "Saldo R$" após o lançamento.
   - Clicar abre o detalhe (1.5).
   - Estados: 5 linhas-esqueleto ao carregar. Erro: "Não foi possível carregar as últimas transações." com "Tentar novamente". Vazio: "Nenhuma movimentação no período." e "As suas transações aparecerão aqui assim que houver atividade."
7. **Coluna direita.**
   - **"Ações rápidas"**: grade de 6 atalhos (Cobrar → /deposit, Transferir → /transfers, Extrato → /statement, **Pix → /pix**, Webhooks, API). É o único caminho visível para a tela escondida `/pix`.
   - **"Resumo do dia · dd/mm"**: sempre o dia de hoje em Brasília, seja qual for o período escolhido. Mostra "Entradas (n)", "Saídas (n)" e "Resultado do dia" com sinal e cor.
   - **Alertas** (cards clicáveis):
     - "Entregas de webhook falhando" (vermelho): "Há entregas com falha. Revise os endpoints e reenvie." Aparece se existir 1 entrega com falha, de qualquer data, e leva para /integrations/webhooks, que abre na sub-aba Endpoints, não em Entregas.
     - "Saldo bloqueado" (âmbar): "{R$} indisponível por reservas/MED. Toque para ver os detalhes." Aparece se `blocked_balance > 0` e leva para /statement.
     - Não há alerta próprio para saldo em MED.
   - **Card "Limites Pix"** (`pix.limits`):
     - uma barra por janela, rotulada "Limite diário", "Limite mensal" ou "Limite noturno";
     - textos "Usado {R$} de {R$}" e "{R$} disponível";
     - a barra fica âmbar a partir de 80% de uso;
     - se o servidor não informa limites, o card não aparece e não há estado de erro.

**Ocultar saldos.**
- Fica salvo no navegador (`localStorage` "cashyin-hide-balances") e troca os valores por "••••••" no dashboard, extrato, limites, drawer e na lateral.
- Vazamentos observados: a "Taxa R$" da lista recente, o valor grande do comprovante, o delta em % e o desenho do gráfico continuam visíveis. [O]

**MVP × atual.** O MVP tinha "Volume de Vendas" por hora, rosca de status, métodos de pagamento (PIX/Cartão/Boleto) e "Valor em Estornos". Tudo isso saiu. Entraram entradas/saídas com delta, saldo com MED, fluxo em duas séries, ações rápidas, resumo do dia, alertas e limites.

### 1.5 Detalhe de transação (painel lateral compartilhado)

**De onde abre.**
- Dashboard (últimas transações).
- Extrato: linhas e resultados da busca.
- Receber: tabela de cobranças.
- Transferências: tabela de saques.

Sheet à direita, até 576 px; no celular ocupa a largura toda. Os dados chegam da lista, então abre na hora, e depois são completados com `pix.getCashIn {txid}` ou `pix.getCashOut {id}`. Lançamentos que não são Pix (tarifas, estornos) ficam só com os dados do lançamento. [O]

**Cabeçalho.**
- Círculo com seta: verde para crédito, cinza para débito.
- Título: "Pix recebido", "Pix enviado" ou o tipo do lançamento.
- Selo de status e valor com sinal (respeita "ocultar saldos").
- Carregando: "Carregando detalhe…". Erro: "Não foi possível carregar o detalhe desta transação."

**Cash-out: comprovante, sem abas.** Card branco de 420 px com a logo e cores fixas.
- Ícone e título por status:
  - concluída: check e "Pix enviado";
  - processando: spinner e "Pix em processamento";
  - falhou: X e "Pix não enviado";
  - devolvida: ícone âmbar e "Pix devolvido".
- Valor grande e data em pílula ("16 out 2026 · 14h05 (BRT)").
- **Sobre a transação**: "Data e horário" ("Sexta-feira, 16/10/2026 às 14h05"), "Tipo" = Pix enviado, "Identificador (E2E)".
- **Quem recebeu**: nome em maiúsculas, CPF/CNPJ **completo**, sem máscara, instituição e chave Pix.
- **Quem pagou**: dados do pagador; a instituição é o banco ou "CashYin".
- `failure_reason` em vermelho, se houver.
- Rodapé: "Autenticação CashYin {e2e}", "CashYin Instituição de Pagamento · Documento emitido eletronicamente." e "Confira a autenticidade em cashyin.com/comprovante."
- **"Baixar PDF"**:
  - fica ativo **só** com status concluída;
  - chama `pix.getCashOutReceipt {id}` → `{contentBase64, filename, mimeType}`;
  - o navegador baixa com o nome e o tipo que o servidor mandar;
  - nos outros status, uma dica explica o motivo: "O comprovante fica disponível quando a transferência for concluída." / "Transferência não concluída — sem comprovante." / "Transferência devolvida — sem comprovante.";
  - erro mostra o toast "Não foi possível baixar o comprovante.".

**Cash-in ou lançamento: 7 abas** (padrão "Resumo").

| Aba | Conteúdo |
|---|---|
| Resumo | Identificadores: TxID, Referência (`external_ref`), E2E (no lançamento: Lançamento, Transação, TxID, E2E, Referência). Datas: Criada / Paga / Expira em. "Pagador (mascarado)": nome, documento mascarado (`***.456.789-**`), banco, agência e conta mascaradas. Descrição. |
| Pix | "Copia e cola" (EMV copiável, **sem imagem de QR**), "Expira em", E2E. No cash-out: tipo e chave mascarada (e-mail a•••@dominio, telefone 4 dígitos + ••••• + 2, EVP 8…4). |
| Financeiro | Valor, Direção, Moeda (BRL). "Taxa: Não informada pelo Core", "Valor líquido: —", "Provider: Não informado pelo Core", e a nota "serão exibidos quando o Core os expuser". |
| Webhooks | Placeholder: "Sem entregas de webhook vinculadas" (chega "no módulo de Webhook Deliveries"). |
| Timeline | Montada no navegador a partir das datas. Cash-in: Cobrança criada → Expiração → Pagamento recebido. Cash-out: Criada → Concluída / Falhou / Devolvida. Cada evento com data, hora e tempo relativo. |
| Auditoria | Tipo e ID do recurso, mais o placeholder "Trilha de auditoria por transação". |
| Payloads | JSON do Core com PII mascarada (document, cpf, cnpj, account, branch, bank_account, key, pix_key, tax_id) e o botão "Copiar" (toast "Payload copiado!"). |

Cada linha copiável mostra o toast "{campo} copiado!". Não há "compartilhar".

**Ausências que importam.** Não existe `failure_code` no painel: o bundle não tem nenhum mapeamento de código para texto, só o `failure_reason` livre que vem do Core. Também não aparecem ISPB do favorecido, detalhes da devolução nem a imagem do QR. [O]

### 1.6 `/statement` — Extrato (aliases `/extrato`, `/transacoes`, `/transactions`)

**Propósito.** Histórico do razão da conta: lista paginada, busca no índice, filtros, exportação e saldo de fechamento por dia. Título "Extrato", subtítulo "Histórico completo de movimentações da sua conta". [O]

**Blocos na ordem** (visão Lista):
1. **3 cards de resumo** (`statement.summary {from,to}`):
   - "Entradas no período" (verde).
   - "Saídas no período" (vermelho).
   - "Resultado" (`resultCents`, ou entradas − saídas).
   - Não há card de tarifa nem de contagem, e o resumo ignora o filtro de tipo.
   - Erro: os três mostram "—" e a nota "Não foi possível calcular os totais do período. Tente atualizar em instantes."
   - Os cards **não** obedecem ao "ocultar saldos" (inconsistência de privacidade).
2. **Barra 1**: período, busca, "Atualizar" (ícone) e "Exportar".
3. **Barra 2**: filtros.
4. **Painel "Resultados no índice"**, quando há busca.
5. **Abas de status** à esquerda e **seletor de visão** à direita.
6. **Aviso sobre a coluna Saldo**, quando há filtro de tipo.
7. **"Atualizando extrato..."**, durante a recarga.
8. **Lista.**
9. **Gaveta de detalhe** (1.5).

**Abas de status** (filtram só a página carregada):
- "Todos" (padrão).
- "Pendentes": transação `pending` ou `processing`.
- "Concluídas": todo o resto, inclusive falhas e canceladas. É um rótulo enganoso.

**Visões:** "Lista" (padrão), "Análise" e "Fecho Diário".

**Período** (componente compartilhado com o dashboard):
- Presets: "Hoje" (**padrão do Extrato**), "7 dias" (hoje + 6 dias anteriores) e "Este mês".
- Personalizado: calendário de intervalo com 2 meses, mais "Hora inicial (BRT)" e "Hora final (BRT)" com segundos. Padrão das horas: 00:00:00 a 23:59:59. Hora fora do intervalo é cortada para 23/59.
- Envio: os presets vão como ISO UTC; o personalizado vai como `AAAA-MM-DDTHH:MM:SS-03:00`, com offset fixo (quebra se o horário de verão voltar).
- O front não valida o período (nem o máximo de dias, nem início antes do fim). O servidor recusa e a tela mostra "Período inválido. Verifique se a data inicial é anterior à final e se o intervalo não excede 366 dias."
- O mesmo período vale para lista, resumo, exportação e Fecho Diário. [O]

**Filtros:** um campo por vez, escolhido no select "Filtro..", com o botão "Limpar".
- **Valor**: "Valor mín (R$)" até "Valor máx (R$)".
  - Filtra **só no navegador e só a página atual**.
  - Usa o valor sem sinal, com limites inclusivos.
  - Não confere se o mínimo é menor que o máximo.
  - "10.50" vira R$ 1.050,00, porque o ponto é tratado como milhar.
- **Movimento**: "Entradas (Pix recebido)" ou "Saídas (Pix enviado)".
  - Vai ao servidor como `type=pix_cash_in` ou `pix_cash_out`.
  - Estornos e taxas ficam de fora.
  - O parâmetro `direction` existe no hook, mas nunca é enviado.
- **Tipo**: Pix recebido · Pix enviado · Taxa de recebimento · Taxa de envio · Estorno de Pix · Estorno de taxa (`pix_cash_in`, `pix_cash_out`, `fee_cash_in`, `fee_cash_out`, `reversal_cash_out`, `reversal_fee_cash_out`). Vai ao servidor como um único `type`.
- Com filtro de Tipo ou Movimento aparece o aviso: "Com filtro por tipo ou movimento ativo, a coluna **Saldo** fica indisponível (—): o saldo corrido só é calculável sobre a conta inteira." Na prática a linha "Saldo" some.

**Busca** (campo "Busque por ID, End-to-End ou referência...").

O mesmo texto é usado de dois jeitos:
1. **Filtro local imediato** na página carregada: tipo, descrição, contraparte, txid, E2E e external_ref.
2. **Consulta ao índice**: depois de 350 ms sem digitar e com pelo menos 2 caracteres, chama `pix.search {term, limit: 20}` → `{cashIn[], cashOut[], partial}`.

O índice cobre 12 meses e **ignora** período, filtros e página. Texto da tela: "Busca direta no histórico por E2E, TxID, referência ou nome (até 12 meses), independente do período e da página."

Resultados:
- Dois grupos: "Cobranças (Pix recebido)" e "Transferências (Pix enviado)".
- Cada item mostra o nome do pagador ou do favorecido, o status, o tempo relativo, o identificador e o valor.
- O clique abre a gaveta de detalhe.

Estados:
- "Buscando no índice…"
- "Nenhuma transação encontrada para “{termo}”."
- "Falha ao buscar no índice. Tente novamente — isto não significa que a transação não exista."
- Âmbar para resultado parcial: "Parte da busca falhou. Estes resultados podem estar incompletos."
- Âmbar para resultado velho: "Não foi possível atualizar a busca…"

Um resultado vazio e parcial é tratado como **falha**, e não como "não existe". É um cuidado bom contra falso negativo. [O]

**Lista de lançamentos** (linhas em cartão, não é tabela).
- Ícone: taxa âmbar, estorno azul, crédito verde, débito vermelho.
- Título: o tipo, com um selo de status ("Concluída", "Pendente", "Processando", "Falhou", "Cancelada").
- Segunda linha:
  - contraparte: "Taxa Administrativa" para taxas; nos outros casos, a descrição, descartando textos genéricos em inglês como "pix sent";
  - data e hora com segundos (fuso de São Paulo);
  - chip do identificador, nesta prioridade: E2E, depois TxID, depois Ref. O chip encurta para 8…4 caracteres, mostra o valor inteiro no tooltip e tem botão de copiar ("Copiado!" por 2 s).
- À direita:
  - "+ R$" ou "− R$";
  - um ícone "Valor ajustado por arredondamento", com o tooltip "Tarifa exata: R$ 0,14925 (ajustada por arredondamento de centavos)" (a tarifa vem em milésimos de centavo e aparece com 2 a 5 casas);
  - embaixo, "Saldo R$ X", o saldo corrido depois do lançamento.
- Paginação:
  - por cursor, com "Anterior"/"Próxima" e "Página N";
  - "Itens por página" 25/50/100, padrão 25 (o hook aceitaria 50; a API vai até 200);
  - trocar o tamanho volta à página 1.
- Clicar na linha (ou Enter/Espaço) abre o detalhe.
- Sobras de um layout antigo de tabela: as chaves "De"/"Para", "Carregar mais" e a dica da coluna Saldo não são usadas, e o esqueleto ainda tem 7 colunas.

**Visão "Análise".** Não tem gráfico. Mostra "Resumo desta página (N linhas)" e uma contagem por tipo, da maior para a menor, calculada sobre a página filtrada. [O]

**Visão "Fecho Diário".**
- Some tudo, menos o período e o seletor de visão.
- Chama `statement.dailyBalances {from, to, timezone: "America/Sao_Paulo"}`.
- Tabela de **duas colunas**: "Data" (dd/mm/aaaa) e "Saldo de Fecho". Não há abertura, entradas, saídas nem tarifas.
- Introdução: "Saldo de fecho ao fim de cada dia (America/Sao_Paulo). A série é contínua — dias sem movimento repetem o saldo do dia anterior."
- "Exportar" abre as opções CSV e "Excel (XLSX)", que chamam `statement.exportDailyBalances {from, to, timezone, format}`. Toast "Exportação concluída: {n} dia(s)".
- Vazio: "Sem saldos de fecho no período" com "Selecione um período com movimentação para ver o saldo de fecho diário."
- O termo "fecho" é português de Portugal.

**Exportação do extrato.**
- "Exportar" abre as opções **CSV** e **Excel (XLSX)**. Não há PDF.
- Chama `statement.export {from, to, type, format}` → `{contentBase64, filename, mimeType, rowCount, truncated}`.
- O navegador baixa o arquivo com o nome que o servidor dá.
- Só período e tipo vão no pedido; abas, valor e busca **não** entram no arquivo.
- Toasts:
  - "Exportação concluída: {n} linha(s)";
  - truncado: "Exportação concluída: {n} linhas (limitado a {n})";
  - erro: "Falha ao exportar.".
- Nada bloqueia por papel no front: um leitor também exporta.

**Estados.**
- Carregando: esqueleto 7×8.
- Erros, conforme a mensagem:
  - "Extrato indisponível no momento. Tente novamente mais tarde."
  - "Sem permissão para consultar o extrato desta conta."
  - "Período inválido. Verifique se a data inicial é anterior à final e se o intervalo não excede 366 dias."
  - "Não foi possível carregar o extrato. Tente novamente."
- Vazio: "Nenhuma movimentação encontrada", com "Ainda não há movimentações nesta conta." (engana quando o vazio é só no período "Hoje") ou "Nenhuma movimentação corresponde aos filtros. Tente outro período ou busca."
- Armadilha: se os filtros locais esvaziam a página, a paginação some junto e as páginas seguintes ficam inacessíveis. [O]

### 1.7 `/transfers` — Transferências e saque (aliases `/transferencias`, `/transferencia`, `/saque`)

**Página.** Título "Transferências", subtítulo "Gerencie suas transferências e saques Pix". Blocos, de cima para baixo:
1. **Card de saldo**:
   - "Saldo disponível", que respeita "ocultar saldos";
   - "Bloqueado: R$ X" quando há saldo bloqueado, em vermelho;
   - botão **"Nova transferência Pix"**.
2. **3 mini-cards** contados **só sobre a página atual**: "Aprovados" (concluídas), "Pendentes" (em processamento), "Recusados" (falhou + devolvida).
3. **Período**: padrão "Hoje"; atalhos Hoje, 7 dias e Este mês; personalizado com hora em BRT.
4. **Busca** "Busque por ID, End-to-End, chave ou referência..." (espera 350 ms) e botão "Atualizar".
5. **Abas**: Todos · Em processamento · Concluídas · Recusadas.
6. **Tabela** (`pix.listCashOut`, cursor, 25/50/100):
   - Data, com segundos;
   - Status;
   - Favorecido;
   - Chave Pix, com o tipo;
   - E2E / Ref., chip copiável;
   - Valor ("− R$").
   - Clicar na linha abre o comprovante (1.5).
   - Erro: "Não foi possível carregar as transferências. Tente novamente."
   - Vazio: "Nenhuma transferência encontrada".

**Ninguém é barrado na tela.** A página não olha papel: um "Auditor" vê o botão e percorre o assistente inteiro. [O]

**Assistente em modal** ("Transferência Pix — Envie saldo da sua conta de forma segura."). São 4 passos, com stepper: **Dados → Revisão → Verificação → Confirmação**.
- O passo atual fica na cor primária; os anteriores ficam verdes, mesmo depois de uma falha.
- O assistente é um único formulário: Enter avança.
- Fechar o modal zera tudo 300 ms depois, inclusive durante o envio.

**Passo 1 — Dados.**

| Campo | Comportamento |
|---|---|
| Valor (R$) | Máscara de centavos que "empurram" ("R$ 1.234,56"). Mínimo > 0, ou seja R$ 0,01. Sem máximo e sem "usar saldo todo". Colar "1234" vira R$ 12,34. |
| Tipo de Chave | Select manual, CPF por padrão: CPF, CNPJ, E-mail, Telefone, Aleatória. Não há detecção automática. |
| Chave Pix | Obrigatória, placeholder "Digite a chave...". **Sem máscara, regex ou dígito verificador, sem normalização** (nem +55 nem minúsculas). Vai como foi digitada, só com trim. |
| Nome Favorecido (Opcional) | Texto livre. |
| Doc. Favorecido (Opcional) | Só dígitos. Se preenchido, exige 11 ou 14 dígitos, sem conferir dígito verificador. |
| Descrição (Opcional) | Sem limite no front. |

- Acima do teto aparece um banner ao vivo: **"Saque parcelado — Valor acima do limite de {R$ 15.000,00} por transferência. Serão {n} parcelas para o mesmo favorecido."**
- Mostra uma barra do **limite diário** (`pix.limits`): "Usado X de Y", "R$ Z disponível", âmbar a partir de 80%.
- O limite **não** entra na validação: só o servidor recusa.
- Toasts:
  - "Por favor, digite um valor válido maior que zero."
  - "A chave Pix é obrigatória."
  - "Documento do favorecido deve ter 11 (CPF) ou 14 (CNPJ) dígitos."
- Ao avançar, o navegador gera **duas chaves UUID v4**: uma para o saque simples, outra para o lote. Elas ficam em memória.

**Passo 2 — Revisão.**
- "Você vai transferir" e o valor.
- Caixa "Quem vai receber":
  - Favorecido (ou "Não informado");
  - Documento mascarado;
  - Tipo de chave;
  - **Chave Pix completa**;
  - Descrição.
- No parcelado, a lista "Parcelas (n)" mostra "Parcela 1 … R$" e o "Total".
- **Não mostra a tarifa nem o saldo depois da operação.** A checagem compara valor (ou total do lote) com o disponível **sem somar a tarifa**.
- Se o valor passa do saldo: caixa vermelha "O valor excede o saldo disponível. Ajuste o valor para continuar." e o botão fica travado.
- Senão: caixa amarela "Confira os dados do favorecido. Transferências Pix são irreversíveis após a confirmação."

**Passo 3 — Verificação (step-up TOTP), sempre exigida.** Não depende de valor nem de papel.
- Caixa "Verificação de Segurança (Step-up)":
  - simples: "Digite o código do seu app autenticador para liberar a transferência de **{R$}**.";
  - lote: "…liberar o lote de **{n}** parcelas (total **{R$}**)."
- Campo de 6 caixas com a dica "O preenchimento automático do 1Password / chaveiro funciona aqui."
- Aqui **não** há envio automático nem visual de erro, embora o componente suporte os dois. É preciso clicar "Confirmar e Enviar".
- Código errado: o toast genérico "Erro ao solicitar transferência: {mensagem do servidor}", e o código continua no campo.

**Envio do saque simples.**
- Chama `pix.createCashOut {totpCode, idempotencyKey, cashOut: {amount, pix {key_type, key}, receiver? {name, document_number}, description?}}`.
- A chave de idempotência é a mesma em todo reenvio daquela sessão do assistente, **mesmo se o usuário voltar e mudar os dados**. Isso pode gerar 409 `idempotency_key_conflict`, que só aparece como toast genérico.

**Saque parcelado: como funciona exatamente** [O, linhas 14406–14661]
1. **Teto.** Vem de `pix.splitPolicy → maxChunkCents`. Se a consulta não respondeu ou falhou, vale **R$ 15.000,00** (1.500.000 centavos).
2. **Quando parcela.** Só quando o valor é **maior** que o teto: R$ 15.000,00 é um saque só; R$ 15.000,01 já vira duas parcelas.
3. **Como divide.** Divisão gulosa: parcelas cheias do teto, e a última leva o resto. R$ 40.000 = 15.000 + 15.000 + 10.000; R$ 15.000,01 = 15.000,00 + 0,01. Tudo em centavos inteiros, sem arredondamento. A lista é **só uma prévia**: quem divide de verdade é o servidor.
4. **Envio.** Uma única chamada `pix.createSplitCashOut {totpCode, batchIdempotencyKey, totalAmountCents, cashOut (sem amount), batchId?, startFromIndex}`. Na primeira vez, `batchId` vai vazio e `startFromIndex` = 0. Durante o envio, o botão mostra "Enviando {n} parcelas…".
5. **Resposta.** `{batchId, partial, failedAtIndex, chunks[{index, amountCents, status, error}]}`. Não há progresso parcela a parcela em tempo real: tudo chega no fim.
6. **Se uma parcela falha:**
   - título "Lote enviado parcialmente";
   - lista "Parcelas enviadas", com o selo "Falhou" (e o erro), "Concluída" ou "Enviada";
   - dica "Algumas parcelas foram enviadas. Corrija o problema e retome as parcelas pendentes.";
   - botão **"Retomar parcelas pendentes"**.
7. **Retomar.** Usa `failedAtIndex` como novo `startFromIndex`, **apaga o TOTP e volta ao passo 3** (é preciso um código novo). Reenvia com a **mesma** `batchIdempotencyKey`, o `batchId` devolvido, o mesmo total e o mesmo destino. A resposta é somada às parcelas que já tinham dado certo. O ciclo pode se repetir. [I] Como só existe um `failedAtIndex`, o servidor provavelmente para na primeira falha.
8. **Fragilidade.** A chave do lote, o `batchId` e o índice de retomada **vivem só na memória do navegador**. Fechar o modal, clicar em "Nova transferência" ou recarregar a página perde a retomada. Refazer o lote gera uma chave nova, com risco de pagar parcelas em dobro. **Não copiar: a retomada tem de ficar no servidor.**
9. **Resultado completo.** "Lote enviado!", com o total e a lista. Não há PDF de lote. O selo de status mostra "Concluída" até quando o lote é parcial (bug).

**Passo 4 — Confirmação.**

| Status | Título | O que aparece |
|---|---|---|
| `processing` | "Pix em processamento" (spinner) | "O comprovante em PDF ficará disponível quando a transferência for concluída." **Não há polling: fica girando para sempre.** |
| `completed` | "Pix enviado!" | botão **"Baixar comprovante (PDF)"** (`pix.getCashOutReceipt`) |
| `failed` | "Não foi possível enviar" | caixa "Motivo" (`failure_reason`) + "Nenhum valor foi debitado da sua conta. Você pode tentar novamente." |
| `returned` | "Pix devolvido" | "Motivo" + a mesma frase de "nada foi debitado" (estranha numa devolução) |
| outro | "Pix enviado!" | status desconhecido aparece **como sucesso** (bug) |

- Linha "para **{nome}**". Sem nome, mostra a chave mascarada.
- Data em pílula ("16 out 2026 · 14h33 (BRT)").
- Caixa "E2E ID (comprovante)" com "Copiar" (toast "E2E copiado!").
- Botões "Nova transferência" e "Fechar".
- `failure_code` não é usado: o painel mostra só o texto livre `failure_reason`.
- Os textos prontos de `validation.json` (`INSUFFICIENT_FUNDS`, `INVALID_PIX_KEY`, `LIMIT_EXCEEDED`, `RATE_LIMITED`) **não são usados em lugar nenhum**: o usuário vê a mensagem crua do servidor.

### 1.8 `/deposit` — Receber Pix (alias `/deposito`)

**Acesso.** Pelo menu "Banking → Receber", pelo botão "Receber" do card de saldo da lateral e pelo atalho "Cobrar" do Início. Não há checagem de papel na tela: um leitor também vê o botão de gerar. [O]

**Blocos na ordem.**
1. Cabeçalho "Receber Pix", com o subtítulo "Gere cobranças via QR Code e acompanhe os pagamentos recebidos".
2. Duas colunas: o card **"Nova cobrança"** e o card do **QR**.
3. Quatro KPIs. **Atenção: valem só para a página carregada.**
   - "Saldo Disponível".
   - "Recebido (página)": soma bruta das cobranças pagas da página.
   - "Aguardando": quantas estão pendentes.
   - "Expiradas": quantas expiraram.
4. Barra com período, busca e o botão-ícone "Atualizar".
5. Abas de status.
6. Tabela de cobranças com paginação.
7. Detalhe em painel lateral (1.5).

**Nova cobrança.** Subtítulo: "Informe o valor e gere um QR Code Pix para receber."
- **Valor**
  - Máscara de centavos que "empurram": cada dígito entra pela direita e o campo mostra "R$ 1.234,56".
  - Placeholder "R$ 0,00", com a dica fixa "Mínimo R$ 1,00".
  - O botão fica desabilitado abaixo de R$ 1,00. Se mesmo assim o clique passar, aparece o toast "Informe um valor de no mínimo R$ 1,00.".
  - Não há máximo no front. A API aceita até 100.000.000 centavos (R$ 1 milhão).
- **Descrição (opcional)**
  - Até 140 caracteres, placeholder "Depósito via Painel CashYin".
  - Se ficar vazia, vai o texto padrão **traduzido no idioma da tela**.
- **O que é enviado:** `pix.createCashIn {amount (centavos), description, external_ref: "deposito-<8 hex>"}`.
  - O `external_ref` é novo a cada clique, então não há idempotência entre cliques.
  - Sucesso: toast "Cobrança Pix gerada com sucesso!" e a lista recarrega.
  - **O formulário não é limpo**: um segundo clique gera outra cobrança igual.
- **Não existe campo de expiração.** O painel não manda prazo e a API nem aceita um.

**Card do QR.**
- Sem cobrança: "O QR Code Pix aparecerá aqui após você gerar uma cobrança."
- Com cobrança:
  - Topo: "QR Code gerado" e o selo de status.
  - QR desenhado no navegador (200 px, nível M).
  - "Pix copia e cola" com o botão "Copiar" (toast "Código Pix copiado!").
  - "Valor" e "Expira em". Este valor **não** obedece a "ocultar saldos".
  - TxID clicável que copia ("TxID copiado!").
  - "Atualizar status": chama `pix.getCashIn {txid}` e mostra o toast "Status: Paga".
  - "Nova cobrança": limpa tudo.
- Paga: bloco verde "Pagamento recebido! em {data}" e o QR some.
- Sem EMV: o aviso "Cobrança criada, mas sem código Pix", com a explicação "O EMV não foi retornado. Use “Atualizar status”…".
- **Não há polling, contagem regressiva, websocket nem confete.** O status só muda pelo botão. Cobrança expirada continua mostrando o QR. [O]

**Lista de cobranças.**
- Chama `pix.listCashIn {limit, cursor, from, to, filter, status[]}`, com paginação por cursor (25/50/100).
- Período padrão: **7 dias**.
- Busca "Busque por TxID, referência, E2E, pagador..." com 350 ms de espera. Vai ao servidor como `filter`.
- Abas (filtradas no servidor): Todas · Aguardando (`pending`) · Pagas (`paid`) · Expiradas (`expired`) · Outras (`cancelled`, `failed`, `refunded`).
- Colunas:
  - Criado em
  - Status
  - Pagador (ou "Não informado")
  - Documento (mascarado: `***.456.789-**` e `**.345.678/****-**`)
  - E2E / TxID (chip copiável)
  - Pago em
  - Valor ("+ R$" verde)
  - Botão "Pix", que copia o EMV
- A tabela tem largura mínima de 820 px e rola na horizontal.
- Estados:
  - Carregando: esqueleto 7×8.
  - Erro: "Não foi possível carregar as cobranças." com o botão "Tentar novamente".
  - Vazio: "Nenhuma cobrança encontrada", com o texto "Nenhuma cobrança Pix corresponde ao período/filtros. Gere a primeira cobrança no card acima."

**MVP × atual.** O MVP era um assistente "Dados → QR Code → Confirmação" com QR falso e o botão "Já paguei". A produção manteve a máscara de valor e o mínimo de R$ 1,00.

### 1.9 `/infractions` e `/infractions/:id` — Infrações / MED (alias `/infracoes`)

**Lista.**
- Título "Gerenciamento de Infrações PIX", subtítulo "Monitore, conteste e gerencie notificações de infrações e solicitações de MED recebidas."
- Fonte: `infractions.list {limit: 200}` → `{data[], medHeldCents, available}`.
  - **Não tem cursor.** Abas, busca, datas e KPIs são calculados no navegador sobre esses até 200 casos. Caso além do 200º some.
- O botão "Exportar relatório" só mostra o toast "Relatório em preparação — em breve via API.".

**Seis KPIs** (sempre sobre a lista inteira):

| KPI | Cálculo | Dica |
|---|---|---|
| Bloqueio cautelar | `medHeldCents` em R$ | "Sem bloqueios ativos" (fixa, aparece mesmo com valor: bug) |
| Em aberto | nº de `open` (âmbar se > 0) | "Requer atenção urgente" |
| Aguardando (PSP) | nº de `waiting_psp` | "Sob análise do banco" |
| Defesa enviada | nº de `defense_sent` | "Aguardando parecer" |
| Favorável | nº de `favorable` | "Defesas ganhas" |
| Estornado | soma de `refunded` em R$ | "{n} reembolso(s)" |

**Filtros.**
- "Data inicial" até "Data final", comparando a data de criação. Pode errar casos abertos entre 21 h e 24 h BRT, se a data vier em UTC.
- Busca "Busque por ID da transação, End-to-End ou pagador...".
  - **Bug [O]:** termo sem dígitos (ex.: "maria") vira "contém vazio" no documento e passa sempre. A busca por nome não filtra nada.
- Abas: Todos · Em aberto · Aguardando · Com defesa · Encerradas (`favorable` + `refunded` + `closed`).

**Tabela** (largura mínima 900 px).
- Colunas:
  - Status.
  - Data de criação.
  - **Data limite.** Fica **vermelha quando faltam menos de 48 h** (2.880 min) num caso aberto, ou quando já venceu. É calculada só ao desenhar a tela, sem timer.
  - Valor.
  - Pagador. O nome vem com o CPF/CNPJ **formatado sem máscara**.
  - End-to-End (ID PIX).
  - Tipo de infração: Fraude, Falha operacional, Devolução cancelada, Bloqueio cautelar ou Não informado.
  - Ações.
- A linha inteira abre o detalhe.
- Ações:
  - "Ver detalhes" e "Contestar" abrem o detalhe.
  - "Ver histórico" e "Anexos da defesa" só mostram toast de "em breve".
- Estados:
  - Carregando: spinner.
  - Indisponível: "Não foi possível carregar as infrações. Tente novamente em instantes."
  - Vazio: "Nenhuma infração encontrada para os filtros selecionados." Não há texto próprio para conta sem nenhuma infração.

**Status do caso no painel** (6). A API tem 17 status de MED; o BFF os resume nestes:

| Status | Rótulo | Cor | Significado |
|---|---|---|---|
| `open` | Em aberto | âmbar | aguarda ação; é o **único** que aceita defesa |
| `waiting_psp` | Aguardando (PSP) | ardósia | em análise no banco |
| `defense_sent` | Defesa enviada | violeta | aguarda parecer |
| `favorable` | Favorável | menta | defesa ganha |
| `refunded` | Reembolsado | cinza | valor devolvido (o KPI chama de "Estornado") |
| `closed` | Encerrada | cinza | encerrado |

Um status fora da lista quebra o selo: não há fallback.

**Detalhe** (`infractions.getDetail {id}` → `{detail, available}`).
- Topo: breadcrumb "Início / Infrações / Detalhes da Infração", "Voltar" e o selo de status.
- Botões "Histórico de Transações" e "Infrações deste documento": os dois só mostram "em breve".
- **Coluna esquerda**
  - **Resumo**:
    - "Valor da infração" (vermelho).
    - "Prazo para defesa" (vermelho).
    - "Data de criação".
    - "Categoria de fraude": Golpe (scam), Transação não autorizada, Conta invadida, Coação, Desacordo comercial ou Não informada.
    - "Relato da abertura (pagador)", entre aspas.
  - **Transação**: nome e CPF/CNPJ do pagador, data, valor original, End-to-End (copiável), TXID e ID Bacen.
  - **Linha do tempo**:

| Evento | Título | Detalhe |
|---|---|---|
| `received` | Infração recebida (DICT) | "notificação recebida via DICT" |
| `precautionary_block` | Bloqueio cautelar aplicado | "{R$} bloqueados" |
| `awaiting_defense` | Aguardando defesa | "prazo: {n} dias corridos" |
| `defense_sent` | Defesa enviada | — |
| `analysis` | Em análise | — |
| `favorable` | Defesa favorável | — |
| `refunded` | Valor estornado | — |
| `closed` | Infração encerrada | — |

- **Coluna direita (fixa)**: o formulário **"Apresentar defesa"**.
  - Subtítulo: "Você tem até {prazo} para contestar esta infração."
  - Caixa "Provas recomendadas": comprovante de entrega / nota fiscal, conversas com o pagador, histórico de relacionamento.
  - "Justificativa *" (6 linhas). O **mínimo de caracteres vem do servidor por caso** (`minJustificationLength`). Não há máximo nem contador.
  - "Anexos (PDF, PNG, JPG)", "Clique para enviar arquivos", "Máx 5MB cada":
    - acima de 5 MiB, o arquivo é recusado com o toast "{nome} excede 5MB.";
    - **sem limite de quantidade** e sem checar o conteúdo;
    - duplicatas são ignoradas e cada anexo tem botão para remover;
    - os arquivos vão em **base64 dentro do JSON**.
  - Chama `infractions.submitDefense {id, defenseText, attachments[{filename, contentType, base64}]}`.
  - Não há confirmação. Sucesso: toast "Defesa enviada com sucesso.".
  - **Quando aparece:** só com status `open` e nenhuma defesa anterior. **Prazo vencido não bloqueia no front.**
  - Defesa rejeitada também impede uma nova pelo painel, embora a API aceite tentar de novo.
- **Pós-envio**: "Defesa enviada com sucesso — Sua contestação foi registrada e encaminhada para análise. O resultado será informado em até 7 dias corridos." (texto fixo).
- "Histórico de defesas": "Defesa #n — Em análise / Rejeitada", data, justificativa e os **nomes** dos anexos, sem link para baixar.
- O que o detalhe **não** mostra:
  - os valores bloqueado, estornado e liberado separados;
  - banco e conta do pagador;
  - a situação (`situation_type`);
  - o motivo.
- Estados:
  - Erro: "Não foi possível carregar a infração", com "Houve uma falha temporária ao consultar este caso. Tente novamente em instantes."
  - Inexistente: "Infração não encontrada", com "Esta infração não existe ou não está disponível para a sua conta."

**API pública × painel.**
- Pela API, a defesa é multipart, com até 10 arquivos de 10 MiB cada.
- Status da defesa na API: `pending_submission`, `submitting`, `submitted`, `failed`, `rejected`.
- A defesa não move dinheiro.
- Eventos públicos são só 3: `infraction_opened`, `funds_blocked` e `defense_submitted`. Os outros 5 da linha do tempo vêm do BFF.

### 1.10 `/integrations/:tab?` — Integração & API

**Rotas.** `/integrations` (aba Chaves, padrão), `/integrations/webhooks`, `/integrations/security`. Qualquer outro slug cai em Chaves. Aliases que redirecionam: `/integracoes/webhooks` e `/webhooks` → Webhooks; `/integracoes/seguranca`, `/ip-allowlist`, `/whitelist-ips` → Segurança; `/integracoes/*`, `/api-keys`, `/chaves-api`, `/api-credentials` → Chaves. [O]

**Cabeçalho.** Sobretítulo "Desenvolvedor". Título e subtítulo mudam por aba:
- Chaves de API: "Autentique seu sistema nas APIs da CashYin com escopos por chave."
- Webhooks: "Receba notificações dos eventos da sua conta em tempo real."
- Segurança & IPs: "Restrinja o acesso via API a uma lista de IPs confiáveis."

À direita, o botão "Documentação da API" abre a doc externa em nova aba. Abaixo vêm as abas sublinhadas nesta ordem: Chaves de API (ícone de chave) · Webhooks · Segurança & IPs (ícone de escudo). Trocar de aba troca a URL. [O]

**Quem pode o quê.** Cada aba lê `auth.me` (`role`, `loginMethod`):

| Perfil | Ver | Criar chave | Rotacionar | Revogar | Gerir IPs / testar IP | Gerir webhooks |
|---|---|---|---|---|---|---|
| `loginMethod = "cognito"` (qualquer papel) | sim | sim | sim | sim | sim | sim |
| `admin` | sim | sim | sim | sim | sim | sim |
| `operator` | sim | sim | sim | **não** | sim | sim |
| `viewer` / sem papel | sim | não | não | não | não | não |

Quem não pode gerenciar não vê os botões: eles somem, sem desabilitar, sem tooltip e sem explicação. [O]

Há uma contradição em aberto. Todo login real do painel passa pelo Cognito, então, se `loginMethod` for sempre "cognito", as restrições de papel nunca valeriam no front. O mais provável é que operadores e leitores entrem com outro `loginMethod` (convite?), ou que o servidor repita a checagem. Não deu para determinar. [I]

#### Aba Chaves de API

**Fonte e lista.**
- A fonte é `apiKeys.list` (sem retry). O retorno é `keys[]` com `id`, `keyPrefix`, `label`, `scopes[]`, `status`, `createdAt` e `lastUsedAt`.
- Só aparecem chaves `active`, da mais nova para a mais antiga. Chaves revogadas e rotacionadas somem da lista: não há histórico.
- Bloco "Suas chaves", com a dica "Mantenha as credenciais em segredo. Rotacione periodicamente." e um botão de atualizar que gira enquanto busca.

**Cartão de cada chave** (não é tabela), da esquerda para a direita:
- ícone;
- nome (ou "Chave sem nome") e o selo verde "ATIVA";
- prefixo mascarado em fonte mono: `ck_<prefixo> •••• ••••`;
- uma data só: "Último uso" se a chave já foi usada, senão "Criada em" (só a data, fuso de São Paulo);
- os botões "Rotacionar" e "Revogar";
- rodapé com um chip por grupo de escopo ("Pix entrada · 2 permissões"). O tooltip do chip lista os rótulos completos.

**Uma chave ativa por conta** [I forte]. O botão "Gerar nova chave" só aparece quando há **zero** chaves ativas. Com uma ativa, não existe caminho para criar a segunda. Isso contradiz a dica da rotação ("crie uma nova chave e revogue esta em seguida"). Há também um bug de borda: em estado de erro a lista fica vazia e o botão aparece ao lado da mensagem de erro.

**Estados.**
- Carregando: esqueleto de 3 linhas.
- Erro: "Não foi possível carregar suas chaves. Tente novamente." Para o caso 404 o texto é "…no momento. Tente novamente mais tarde."
- Vazio: "Crie a sua primeira Chave de API", com o texto "As chaves autenticam o seu sistema nas APIs da CashYin. Cada chave tem escopos próprios e pode ser rotacionada ou revogada a qualquer momento." e o botão "Gerar primeira chave".

**Criar (diálogo "Nova API Key").**
- Texto do diálogo: "Escolha um nome e o que esta chave poderá fazer na sua conta."
- Campo "Nome da chave", placeholder "Ex: Integração Produção". É obrigatório depois de aparar espaços e não tem limite de tamanho no front.
- "Permissões": os 6 escopos vêm marcados e é preciso deixar pelo menos 1.
- Sem nome ou sem escopo, o botão "Gerar chave" fica desabilitado, sem mensagem.
- Chama `apiKeys.create {label, scopes}`.

**Escopos.** São 3 grupos. Cada grupo tem um switch "Selecionar todas as permissões de {grupo}", e cada escopo tem um checkbox com o ID em fonte mono:

| Grupo | Escopo | Ação | Rótulo |
|---|---|---|---|
| Pix entrada | `pix:cash_in:create` | Criar cobranças | Pix entrada — criar cobranças |
| Pix entrada | `pix:cash_in:read` | Consultar status | Pix entrada — consultar status |
| Pix saída | `pix:cash_out:create` | Criar transferências | Pix saída — criar transferências |
| Pix saída | `pix:cash_out:read` | Consultar status | Pix saída — consultar status |
| Saldo & Extrato | `balance:read` | Consultar saldo | Saldo — leitura |
| Saldo & Extrato | `statement:read` | Consultar extrato | Extrato — leitura |

A doc cita `pix_med:write` (defesa de MED pela API), mas esse escopo não aparece no painel. O anexo 2 escreveu os escopos com `_`; o bundle usa `:`.

**Credenciais (exibição única).**
- A resposta traz `rawKey` e `signingSecret` (opcional).
- Título: "Chave criada com sucesso" na criação, "Credenciais geradas com sucesso" na rotação.
- Aviso amarelo: "Copie agora — o segredo não será exibido novamente. Guarde num cofre seguro (ex.: gestor de segredos) e configure no seu servidor, nunca no navegador. Se perder, será necessário rotacionar a chave."
- Dois campos com "Copiar": "CHAVE DE API" e "SEGREDO DE ASSINATURA". O segundo só aparece se o segredo vier na resposta.
- "Copiar ambos" copia as duas linhas e mostra o toast "Credenciais copiadas!". "Concluí — guardei a chave" fecha.
- Não há confirmação obrigatória: X, Esc e clique fora também fecham. Ao fechar, as credenciais somem da memória.

**Rotacionar (diálogo "Rotacionar API Key").**
- Texto: "Uma nova chave será gerada e a atual deixará de funcionar. Atualize o sistema que usa esta chave assim que receber a nova credencial."
- Mostra as "Permissões (mantidas)" só para leitura.
- Dica: "Para alterar permissões, crie uma nova chave e revogue esta em seguida."
- Chama `apiKeys.rotate {id}`. No sucesso, o toast "Nova chave gerada — a anterior foi desativada." e as credenciais em modo rotação.
- **Sem período de graça**: a chave antiga morre na hora.

**Revogar (alerta "Revogar API Key?").**
- Texto: "A chave **{nome}** deixará de funcionar imediatamente. Esta ação não cria uma chave substituta."
- Não pede para digitar o nome. Botão vermelho "Revogar".
- Chama `apiKeys.revoke {id}` e mostra o toast "Chave revogada!".

Enquanto qualquer criação, rotação ou revogação estiver em curso, todos os botões ficam travados.

#### Aba Webhooks (`/integrations/webhooks`)

**Sub-abas "Endpoints" e "Entregas".** A sub-aba **não vai para a URL**, então não há link direto para Entregas. Por isso o alerta do dashboard "Entregas de webhook falhando" abre em Endpoints. [O]

**Endpoints**

*Modelo de dados.*
- `webhooks.list` devolve endpoints do Core: `{id, targetUrl, events[], status active|disabled, createdAt, description}`.
- O painel **agrupa por URL exata**. Uma linha da tela pode ser N endpoints do Core com a mesma URL.
- Dados da linha agrupada:
  - eventos: a união dos eventos dos endpoints;
  - status: ativo se algum endpoint estiver ativo;
  - nome: a `description`, ou o hostname da URL.
- [I] O Core parece assinar por padrão de evento, e cada endpoint tem seu próprio segredo.
- Salvar chama `webhooks.syncGroup {endpointIds, targetUrl, description, events}` e aplica o formulário a todo o grupo.

*Tabela.*
- Colunas: **Saúde** · **Endpoint** (nome em negrito + URL em mono) · **Eventos** ("N eventos", com tooltip dos rótulos) · **Status** ("Ativo" verde / "Inativo" cinza) · **Ações** ("Editar", "Testar").
- Busca "Busque por nome ou URL...".
- Chips "Todos / Ativos / Inativos" com contagem e rodapé "Mostrando X de Y".
- Botões "Atualizar" e "Novo webhook".
- Sem paginação. Sem ativar/desativar pela tela: "Inativo" só vem do Core.
- **"Testar" está sempre desabilitado**, com o tooltip "Envio de teste em breve (depende do Core)". [O]

*Saúde.*
- Amostra: as **100 entregas mais recentes da conta** (`listDeliveries {limit: 100}`), agrupadas por URL.
- Taxa: entregues ÷ (entregues + falhas + descartadas). Pendentes não contam.

| Taxa | Rótulo | Cor |
|---|---|---|
| ≥ 95% | "Saudável" | verde |
| ≥ 80% | "Instável" | âmbar |
| < 80% | "Com falhas" | vermelho |
| sem amostra | "Sem dados" | cinza |

Tooltip: "Saudável · 97% de sucesso nas últimas 34 entregas".

*Criar/editar* (painel lateral "Configurar webhook" / "Editar webhook"). Texto de abertura: "Informe uma URL HTTPS do seu sistema e escolha quais eventos deseja receber."
- Campos:
  - "Nome do endpoint" (opcional, "Apenas para identificar o endpoint no painel.").
  - "URL de destino" (placeholder "https://seusistema.com/webhooks/pix").
  - "Eventos".
- Validação no front:
  - vazio: "Informe a URL do endpoint";
  - sem `http://` ou `https://` no começo: "Use uma URL começando com http:// ou https://";
  - nenhum evento marcado: "Selecione ao menos um evento".
- **O front aceita `http`** (o texto fala em HTTPS) e não bloqueia localhost nem IP privado. Não confere duplicidade nem tamanho.
- Eventos vêm de `webhooks.eventCatalog`, com cache de 5 min. Três grupos com o switch "Selecionar todos", o contador "X de Y selecionados", o rótulo pt-BR e o nome técnico.
- Na criação, **cash-in e cash-out vêm marcados e MED não** (MED é opt-in).

| Evento | Rótulo no painel |
|---|---|
| `pix.cash_in.paid` | Cobrança PIX paga |
| `pix.cash_in.cancelled` | Cobrança PIX cancelada |
| `pix.cash_in.expired` | Cobrança PIX expirada |
| `pix.cash_in.failed` | Cobrança PIX falhou |
| `pix.cash_in.refunded` | Cash-in estornado |
| `pix.cash_out.completed` | Pagamento PIX enviado (cash-out concluído) |
| `pix.cash_out.failed` | Saque PIX falhou |
| `pix.cash_out.returned` | Saque estornado (devolvido) |
| `pix.med.opened` | Caso MED aberto contra uma cobrança PIX |
| `pix.med.hold_placed` | Saldo retido por caso MED aberto |
| `pix.med.released` | Retenção MED liberada — saldo disponível novamente |
| `pix.med.refunded` | Devolução MED executada — valor retido devolvido à contraparte |
| `pix.med.closed` | Caso MED encerrado sem devolução (ex.: infração arquivada) |

- Caixa de aviso: "Depois de salvar, o signing secret aparece uma única vez. Use-o para verificar a assinatura HMAC de cada entrega. Evite cadastrar a mesma URL mais de uma vez."
- Rodapé na edição: "Excluir" (vermelho), "Novo secret", "Cancelar" e "Salvar alterações".

*Excluir.*
- Confirmação "Excluir webhook?": "O endpoint **{nome}** será excluído permanentemente e deixará de receber eventos."
- Chama `webhooks.removeMany {ids}`, que apaga todos os endpoints daquela URL.

*Novo secret.*
- Confirmação "Gerar novo signing secret?": "O secret atual deixa de valer. Copie o novo valor na tela seguinte e atualize o seu sistema."
- Chama `webhooks.rotateSecret`.
- Bug provável: só gira o segredo do **primeiro** endpoint do grupo. Os outros endpoints da mesma URL continuam com o segredo antigo. [O/I]

*Exibição do segredo.*
- Aparece uma vez, com "Copie agora — o segredo não será exibido novamente…" e "Concluí — guardei o segredo".
- Toasts: "Webhook criado!", "Webhook atualizado!", "Webhook excluído!", "Novo signing secret gerado!" e "Webhook criado, mas o signing secret não veio na resposta. Rotacione o secret para gerar um novo."

*Estados.*
- Vazio: "Nenhum webhook configurado" / "Receba notificações em tempo real no seu sistema quando eventos de Pix acontecerem." e o botão "Configurar primeiro webhook".
- Filtro sem resultado: "Nenhum webhook corresponde aos filtros."
- Erro: "Não foi possível carregar seus webhooks. Tente novamente."

**Entregas**

*Disponibilidade.* Se `listDeliveries.available` for falso, a aba inteira vira o aviso "Observabilidade de entregas indisponível", dizendo que o histórico "ainda não está disponível no Core para esta conta". É uma flag por conta. [O]

*KPIs.* `deliveryStats {window: "24h"}`, sempre 24 h:

| Card | Valor |
|---|---|
| Entregues (24h) | quantidade, com "{taxa}% de sucesso" |
| Falhas (24h) | quantidade |
| Latência média | média em ms |
| Aguardando retry | quantidade |

*Filtros.*
- **Endpoint**: select com "Todos os endpoints" mais um item por endpoint do Core.
- **Período**: "Hoje", "7 dias" (padrão) ou "30 dias". Atenção: "Hoje" começa à meia-noite **do navegador**, não de Brasília.
- **Abas de status**: Todas · Entregues · Falhas · Reprocessando · Pendentes · Descartadas.
- **Busca**:
  - Se o texto é um nome de evento do catálogo, filtra por `eventType`.
  - Senão, com 8 ou mais caracteres, procura o **identificador da transação** (ID, txid, external_ref ou E2E) **em todo o histórico, ignorando o período**: "A busca por identificador percorre todo o histórico, ignorando o período."
  - Com menos de 8 caracteres não consulta. Mostra "Digite o identificador completo…".
  - Sem debounce.

*Tabela.*
- Colunas: Data (com segundos) · Status · Evento · Endpoint · HTTP (2xx verde, ≥400 vermelho) · Tentativa ("n/máx") · Latência.
- Paginação por cursor com "Página N" e 25/50/100 itens.
- Sem ordenação na UI e sem atualização automática.
- Status das entregas:

| Status | Rótulo | Cor |
|---|---|---|
| `delivered` | Entregue | verde |
| `failed` | Falhou | vermelho |
| `dead_letter` | Descartada | vermelho |
| `in_progress` | Reprocessando | âmbar |
| `pending` | Pendente | âmbar |

*Inspetor* (painel lateral, abre no clique da linha, `webhooks.getDelivery {id}`). Blocos na ordem:
1. Cabeçalho "Inspetor de entrega", com "evento · HTTP".
2. Grade com Status, Tentativa, Latência e "Criada em".
3. Faixa âmbar "Próxima tentativa agendada para {quando}", se houver.
4. **"Request enviado"**: método, URL, escudo "Assinado com HMAC (X-CashYin-Signature)" quando a assinatura está presente, e "Copiar". O corpo JSON aparece formatado. Os headers e o valor da assinatura **não** são mostrados.
5. **"Resposta da sua API"**: HTTP, latência, Content-Type e trecho do corpo. Sem resposta: "Sem resposta registada (entrega pendente ou em reprocessamento)."
6. **"Timeline de tentativas"**: "Tentativa n · HTTP nnn · N ms", data, tempo relativo e o erro em vermelho.

Rodapé:
- **"Reenviar entrega"**: sem confirmação e sem regra de status (aparece até para entregue). Chama `webhooks.redeliver {id}`; toast "Reenvio solicitado.".
- **"Exportar JSON"**: baixa `webhook-delivery-<id>.json` com payload, resposta e tentativas.

*Permissão.* Gerenciar exige `loginMethod = cognito`, admin ou operator. Quem não pode abre o "Editar" só para leitura. Ver, inspecionar e exportar JSON fica liberado para todos. [O]

*Textos sem tradução.* Sete chaves da busca por identificador não existem em en nem em zh: aparecem em português. [O]

#### Aba Segurança & IPs

**Modelo.**
- A allowlist é **da conta** e vale para todas as chaves de API. Nunca vale para o painel.
- Fonte: `ipAllowlist.list` → `{entries[{id, cidr, label, status active|disabled, createdAt}], hasActiveAllowlist}`.
- A restrição não é um campo próprio: ela fica "ligada" quando existe pelo menos 1 entrada ativa.

**Faixa de estado no topo.**
- Restrição ativa (verde): "Restrição por IP ativa — As chamadas de API só são aceitas a partir dos IPs/CIDRs abaixo. {n} IPs autorizados."
- Restrição inativa (cinza): "Restrição por IP inativa — Sua API key aceita chamadas de qualquer origem. Adicione e ative um IP para restringir."

**Switch geral** ("Ativar restrição por IP"):
- Ligar com a lista vazia: toast "Adicione um IP autorizado para ativar a restrição." e o foco vai para o campo de IP.
- Ligar com entradas: abre a confirmação "Ativar a restrição por IP?", que lista os IPs que serão reativados.
- Desligar: abre "Desativar a restrição por IP?" com o texto "Os IPs da lista são mantidos e podem ser reativados a qualquer momento."
- A ação em massa dispara N chamadas `ipAllowlist.setStatus` em paralelo.
- Se alguma falhar: "Não foi possível atualizar todos os IPs. Tente novamente." A lista pode ficar em estado parcial, sem desfazer.

**Formulário de adicionar.**
- "IP ou CIDR" (mono, placeholder "203.0.113.10 ou 203.0.113.0/24").
- "Descrição (opcional)" com até 140 caracteres, placeholder "Ex.: IP fixo produção".
- Botões "Adicionar" e "Testar um IP".
- Validação no front:
  - O valor é aparado. Espaço no meio invalida.
  - IPv4 tem 4 octetos de 0 a 255, sem zero à esquerda.
  - IPv6 aceita no máximo um `::`, IPv4 embutido no fim e nenhuma zona `%`.
  - Prefixo CIDR: 0 a 32 no IPv4, 0 a 128 no IPv6. O mínimo exigido é **/24 no IPv4 e /64 no IPv6**.
  - IP sem prefixo vale como host único.
  - O front não confere bits de host: `203.0.113.5/24` passa.
- Erros (aparecem depois que o campo foi tocado):
  - "Prefixo muito amplo: aceito IPv4 a partir de /24 e IPv6 a partir de /64."
  - "Informe um IPv4, IPv6 ou CIDR válido."
  - "Este IP/CIDR já está cadastrado." A duplicidade compara em minúsculas, com /32 e /128 implícitos. Formas longa e curta do IPv6 não são unificadas.
- Primeira entrada ativa: abre a confirmação "Esta é a primeira entrada ativa. Ao adicioná-la, sua API key passa a aceitar chamadas apenas de {cidr}. Use o "Testar um IP" em caso de dúvida." com o botão "Adicionar e ativar". Com a restrição já ativa, adiciona direto.
- Chama `ipAllowlist.create {cidr, label?}` e mostra o toast "IP/CIDR adicionado ({cidr})".

**Tabela "IPs autorizados".**
- O contador "{n} endereços" conta ativas e inativas.
- Colunas: IP / CIDR · Descrição · Status (selo "Ativo" verde ou "Inativo" cinza) · Adicionado (data e hora) · ações.
- Ações por linha:
  - Ativar/Desativar, **sem confirmação**, mesmo quando isso liga ou desliga a restrição inteira. Toasts: "Entrada ativada" / "Entrada desativada".
  - Lixeira com a confirmação "Remover {cidr} pode bloquear chamadas da sua integração se ele estiver em uso. Deseja continuar?" Chama `ipAllowlist.remove {id}` e mostra o toast "Entrada removida da whitelist".
- Estados:
  - Carregando: tabela-esqueleto de 6×8.
  - Erro: "Não foi possível carregar suas configurações. Tente novamente."
  - Vazio: "Nenhum IP cadastrado. Sua API key aceita chamadas de qualquer origem enquanto a lista estiver vazia."

**Testar um IP** (popover).
- Texto: "Verifique se um IP passaria pela restrição atual — útil antes de ativar."
- Aceita só IP puro, sem `/`. Com prefixo, o toast é "Informe um IP (sem prefixo CIDR) para testar."
- Chama `ipAllowlist.validate {ip}` → `{ip, allowed, matchedCidr?, hasActiveAllowlist}`.
- Resultados possíveis:
  - "{ip} seria **permitido** (casa com {cidr})."
  - "…**permitido**."
  - "…**permitido** — a restrição está inativa (acesso público)."
  - "{ip} seria **bloqueado** com a restrição atual."

**Rodapé.** "Este painel de gestão nunca é bloqueado pela restrição — você não corre risco de perder o acesso. A restrição vale apenas para chamadas feitas com a sua API key."

**Comparação com o MVP.** O MVP tinha uma chave "secreta" sempre legível, com botão de olho e "acesso total", e um "Gerar nova chave" falso. O produto atual trocou isso por escopos, exibição única e rotação.

### 1.11 `/pix` — Adquirente PIX (fora do menu)

- Cabeçalho "PIX".
- Card "Adquirente PIX": "Veja por qual processador os pagamentos PIX da sua empresa são roteados. Esta é uma visualização somente leitura."
- Caixa de aviso: "Configuração gerida pela plataforma — O roteamento de adquirente é definido pela CashYin. Para solicitar uma alteração, fale com o suporte — esta tela não altera a configuração."
- Dados: `config.routing` → `[{operation, provider_name}]`. Cada linha traz a operação, o nome do provedor e o selo "Ativo" (sempre verde). Operações:
  - "Pix recebido (cash-in)"
  - "Pix enviado (cash-out)"
  - "Todas as operações Pix"
  - …
- Erro ou vazio: "Adquirente ativo indisponível…"
- Rodapé: "Em breve: taxa de conversão por adquirente nesta tela, para você comparar desempenho com mais clareza."
- **Fora do menu lateral.** Só se chega pela URL ou pelo atalho "Pix" das Ações rápidas do Início.
- No MVP o lojista **escolhia** a adquirente (opção única "PAY2M - FYHUB", "id interno 44"). A produção tirou a escolha.

### 1.12 `/splits` — Splits (placeholder)

- Cabeçalho "Splits", com "Configure divisões automáticas de pagamento".
- Card "Splits configurados" com o botão "Novo split", que só mostra o toast "Em breve: criação de splits".
- Estado vazio fixo: "Nenhum split criado — Crie regras para dividir automaticamente o valor das transações entre múltiplos recebedores."
- **Nenhuma chamada de API.** Está no menu para todos.

### 1.13 `/documentacao`, `/404` e erro geral

- `/documentacao`: exige login, mostra "Abrindo documentação…" e troca a página pela doc externa (`location.replace`). Fica fora do menu. O link de verdade é o "Documentação da API" em Integrações.
- `/404` (e qualquer rota desconhecida): "404 — Página não encontrada — O caminho informado não existe ou foi movido. Volte ao painel para continuar a operação." com o botão "Voltar ao painel". Texto fixo em pt-BR, sem tradução.
- Erro geral (ErrorBoundary do template): tela com "Reload Page", em inglês.

### 1.14 Todos os status e selos

| Entidade | Valor → rótulo (cor) |
|---|---|
| Cobrança (cash-in) | `pending` Aguardando (âmbar) · `paid` Paga (verde) · `expired` Expirada (cinza) · `cancelled` Cancelada (cinza) · `failed` Falhou (vermelho) · `refunded` Estornada (vermelho) |
| Transferência (cash-out) | `processing` Em processamento (âmbar) · `completed` Concluída (verde) · `failed` Falhou (vermelho) · `returned` Devolvida (vermelho) |
| Lançamento do extrato | `paid` Concluída · `pending` Pendente · `processing` Processando · `failed` Falhou · `cancelled` Cancelada (sempre cinza no drawer) |
| Tipo de lançamento | Pix recebido · Pix enviado · Taxa de recebimento · Taxa de envio · Estorno de Pix · Estorno de taxa |
| Infração (painel) | `open` Em aberto · `waiting_psp` Aguardando (PSP) · `defense_sent` Defesa enviada · `favorable` Favorável · `refunded` Reembolsado · `closed` Encerrada |
| MED (API, 17) | `received`, `correlation_pending`, `hold_pending`, `held`, `partially_held`, `analysis_agreed`, `analysis_disagreed`, `refund_requested`, `refunded`, `partially_refunded`, `released`, `cancelled`, `rejected`, `expired`, `dismissed`, `manual_review`, `failed` (o BFF resume nos 6 de cima) |
| Defesa (API) | `pending_submission`, `submitting`, `submitted`, `failed`, `rejected`. No painel: "Em análise", "Rejeitada"; os outros aparecem com a chave crua. |
| Entrega de webhook | `delivered` Entregue (verde) · `failed` Falhou (vermelho) · `dead_letter` Descartada (vermelho) · `in_progress` Reprocessando (âmbar) · `pending` Pendente (âmbar) |
| Saúde do endpoint | ≥95% Saudável · ≥80% Instável · <80% Com falhas · Sem dados |
| Chave de API | só "ATIVA" (as outras somem) |
| IP da allowlist | Ativo / Inativo |
| Papel | Administrador · Operador · Auditor |
| Falha de cash-out (API, 12) | `pix_key_not_found`, `pix_key_invalid`, `pix_key_validation_failed`, `recipient_bank_rejected`, `recipient_account_invalid`, `amount_not_allowed`, `recipient_timeout`, `returned_by_recipient`, `temporarily_unavailable`, `duplicate_request`, `under_review`, `processing_failed` (o painel **não** usa) |

### 1.15 Papéis: matriz consolidada

| Ação | Cognito (dono) | admin | operator | viewer |
|---|---|---|---|---|
| Ver todas as telas | sim | sim | sim | sim |
| Gerar cobrança, transferir, enviar defesa, exportar extrato | sim | sim | sim | **sim (a tela não checa)** |
| Criar/rotacionar chave de API | sim | sim | sim | não |
| Revogar chave de API | sim | sim | **não** | não |
| Gerir IPs, testar IP | sim | sim | sim | não |
| Criar/editar/excluir webhook, novo secret, reenviar entrega | sim | sim | sim | não (edição só para leitura) |
| Card de saldo na lateral, "Trocar conta" | sim | — | — | — |

O papel é checado **só para mostrar ou esconder botão**. Não deu para ver se o servidor repete a checagem.

### 1.16 As 46 procedures tRPC e onde aparecem

| Router | Procedures | Tela |
|---|---|---|
| auth | `me`, `status`, `logout` | guarda de rota, menu |
| accounts | `profile`, `accessible` | card de saldo, rodapé, troca de conta, `/select-account` |
| users | `setLocale` | seletor de idioma |
| config | `routing` | `/pix` |
| pix | `balance`, `limits`, `splitPolicy`, `createCashIn`, `getCashIn`, `listCashIn`, `createCashOut`, `createSplitCashOut`, `getCashOut`, `listCashOut`, `getCashOutReceipt`, `search` | Início, Receber, Transferências, Extrato, detalhe |
| statement | `list`, `summary`, `dailyBalances`, `export`, `exportDailyBalances` | Início, Extrato |
| infractions | `list`, `getDetail`, `submitDefense` | Infrações |
| apiKeys | `list`, `create`, `rotate`, `revoke` | Chaves de API |
| webhooks | `list`, `eventCatalog`, `create`, `syncGroup`, `removeMany`, `rotateSecret`, `listDeliveries`, `getDelivery`, `deliveryStats`, `redeliver` | Webhooks, alerta do Início |
| ipAllowlist | `list`, `create`, `remove`, `setStatus`, `validate` | Segurança & IPs |

REST de acesso: `/api/auth/login`, `/mfa`, `/mfa-setup/associate`, `/mfa-setup/verify`, `/new-password`, `/password/forgot`, `/password/confirm`, `/accounts/start`, `/accounts/mfa`, `/accounts/picker`.

Tudo é paginado por cursor (`page {hasMore, nextCursor}`), com valores em centavos. Nenhuma consulta tem `refetchInterval`: **não existe atualização automática em lugar nenhum do painel.**

### 1.17 Defeitos da Cashyin que a Vantri não deve copiar

1. **No celular não há menu** em nenhuma tela principal (1.0).
2. **Filtros e KPIs só da página carregada.** Valor no extrato, KPIs de Receber e Transferências, abas "Pendentes/Concluídas". Os números mudam com a paginação e escondem dados.
3. **Retomada do saque parcelado só na memória.** Fechar o modal perde o lote, e refazer pode pagar em dobro.
4. **Chave de idempotência presa** mesmo depois de editar os dados.
5. **Sem polling.** "Em processamento" gira para sempre, e cobrança paga só aparece no clique.
6. **Erro cru do servidor** nos toasts, às vezes em inglês. Os textos prontos de `validation.json` nunca são usados.
7. **Status desconhecido vira "Pix enviado!"**, e lote parcial ganha o selo "Concluída".
8. **Checagem de saldo sem a tarifa**, e o limite diário não é conferido antes do envio.
9. **Papel checado só na interface**, e várias telas nem isso (viewer transfere e envia defesa).
10. **Busca de infração por nome não filtra nada**: termo sem dígito casa com qualquer documento.
11. **Infrações limitadas a 200**, sem paginação. "Exportar relatório", "Histórico" e "Anexos" são falsos ("em breve").
12. **"Novo secret" do webhook só gira o primeiro endpoint** do grupo da mesma URL.
13. **Busca por identificador sem debounce**, e "Hoje" das entregas no fuso do navegador.
14. **CPF/CNPJ completo sem máscara** no comprovante e na lista de infrações, enquanto outras telas mascaram.
15. **Tela de erro mostra a stack trace** ao usuário, em inglês.
16. **Botões inertes** no topo (conta e perfil) e seletor de período global que não filtra nada.
17. **Uma chave de API ativa por conta.** Não dá para ter uma chave por integração.
18. **Front aceita webhook em `http://`** e não bloqueia IP interno (o texto da tela fala em HTTPS).
19. **clientId fixo no código** para liberar um bloco de informação.
20. **Textos misturados** entre pt-BR, en e zh, e "fecho"/"registada" (português de Portugal) na versão brasileira.

### 1.18 O que não deu para determinar

- **Papéis no servidor.** Se o servidor repete a checagem de papel. Quais `loginMethod` existem além de "cognito". Se, na prática, todo login real é "cognito", o que anularia as restrições de papel no front.
- **Saque parcelado.** Como o servidor divide e deriva a chave de cada parcela, se para na primeira falha e se aceita reusar o TOTP.
- **Limites e comprovante.** Os valores e o horário dos limites diário, mensal e noturno. O nome e o formato do PDF do comprovante. O que a página pública de autenticidade mostra.
- **MED.** Como os 17 status de MED viram os 6 do painel. O `minJustificationLength` real. Se o BFF limita a quantidade de anexos.
- **Webhooks.** O que `syncGroup` faz no servidor e o que marca um endpoint como inativo. Diferença exata entre `failed` e `dead_letter`. Regras do `redeliver`.
- **Exportação e índice.** Limite de truncamento e colunas da exportação CSV/XLSX. O que o índice de busca pesquisa e o que dispara `partial`.
- **Detalhes visuais.** Nomes dos ícones (chunk do vendor) e o CSS dos estados ativos.
- **Telas sem imagem.** MFA, configuração do TOTP, nova senha e seleção de conta não têm print. Foram descritas só pelo código.

---

## Parte 2 — Lacunas da Vantri em relação ao painel da Cashyin

### 2.1 O que a Vantri tem hoje (lido no código em 17/10)

| Área | Rota | O que faz |
|---|---|---|
| Acesso | `/entrar`, `/entrar/2fa` | E-mail + senha + Turnstile. Bloqueio de 15 min após 5 erros, limite por IP. 2FA TOTP obrigatório em toda sessão. Link "Criar conta". `?motivo=suspenso`. |
| | `/conta/2fa` | Ativação do TOTP: QR, link `otpauth://`, chave em grupos de 4. A chave muda a cada recarga, com aviso. |
| | `/conta/senha` | Troca de senha (12–256 caracteres). Derruba as outras sessões. É **forçada** no primeiro acesso de conta criada pelo admin, mas **não tem link** em lugar nenhum do painel. |
| | `/cadastro` | CPF ou CNPJ, segmento (7 opções), e-mail, senha, declaração "não opero apostas", Turnstile. CNPJ consultado na Receita e CNAE 9200 recusado. Resultado: "Cadastro enviado". |
| Painel | `/painel` | Saldo (Disponível, Bloqueado "Em disputa de MED", Total). Recebido bruto hoje e em 7 dias. Barras SVG de 7 dias. Últimas 5 cobranças. |
| | `/painel/cobrancas` | Nova cobrança: valor, descrição, **validade de 15 min a 24 h**, tarifa exibida. Detalhe em `?id=`: QR, copia e cola, validade, "Atualizar status", "Simular pagamento" no simulador, tarifa, "Você recebe", pagador, E2E, IDs. Histórico com filtro de status e cursor de 20. |
| | `/painel/extrato` | De/Até (padrão 30 dias, máximo 366). Tabela Data / Lançamento / Saldo (disponível ou bloqueado) / Referência / Valor, cursor de 50. "Baixar CSV" com `;`, BOM e proteção contra fórmula. |
| | `/painel/saques` | Disponível para saque. Formulário com valor (R$ 1 a R$ 50.000), tipo de chave, chave validada e normalizada, descrição e **código 2FA no mesmo formulário**. Histórico com Pedido em, Chave, Valor, Tarifa e Status. Alerta de resultado. |
| | `/painel/integracoes` | Chaves: criar com nome, 7 escopos e até 20 IPs; exibida uma vez; revogar. Webhooks: criar com URL e eventos; segredo exibido uma vez; lista. Últimas 50 entregas com "Reenviar". Link para `/docs`. |
| | `/painel/med` | Explicação do MED. Lista com prazo e contagem de dias. Detalhe com motivo, prazo, cobrança, defesa enviada e anexos baixáveis. Defesa de 20 a 5000 caracteres com até 5 arquivos (PDF/PNG/JPEG, 4 MB somados, tipo conferido pelos bytes). |
| Admin | `/admin/*` | Ver Parte 3.1. |
| API | `/api/v1/*` | `balance`, `charges` (POST/GET), `charges/{id}`, `payouts` (POST com `Idempotency-Key`, GET), `payouts/{id}`, `statement`, `med`, `med/{id}`, `openapi.json` (3.1). Página `/docs`. |
| Serviços | `lib/` | Razão com `available`/`blocked` e idempotência por UNIQUE. Tarifa em pontos-base + fixo. Simulador do parceiro. Webhooks com `t=,v1=` e 7 tentativas. Cron (expira cobrança, consulta saque, envia webhook, limpa sessão e rate limit). `access_logs`, `audit_log`. |

Não existem: página 404 ou de erro própria (cai no padrão do Next, em inglês), "esqueci minha senha", vários usuários por lojista, papéis, multiempresa, idioma além do pt-BR, atualização automática de tela.

### 2.2 Tabela de lacunas, tela a tela

**Legenda.** *Situação*: igual · parcial · diferente · ausente · à frente (a Vantri faz melhor). *Tam.*: **P** até 1 dia · **M** 2 a 4 dias · **G** 1 a 2 semanas. *Parceiro*: "plano 2" quando precisa do parceiro Pix real; "—" quando dá para fazer já com o simulador.

#### Casca, conta e acesso

| Recurso da Cashyin | Vantri hoje | Situação | O que falta (UI · serviço · schema · API) | Tam. | Parceiro |
|---|---|---|---|---|---|
| Menu lateral em seções (Pagamentos, Banking, Conta) | Lista plana de 6 itens. No celular vira faixa rolável no topo | à frente no celular | Opcional: agrupar em seções quando passar de 7 itens | P | — |
| Card de saldo na lateral com "Receber"/"Transferir" | Saldo só no Início e em Saques. A lateral mostra nome e e-mail | ausente | UI: `getBalance` no layout do painel + botões "Cobrar" e "Sacar" | P | — |
| Ocultar saldos (guardado no navegador) | Não existe | ausente | UI: botão de olho + classe no `<html>` que troca os valores por "••••••". Aplicar em **todas** as telas (a Cashyin vaza em várias) | P | — |
| Identidade da conta (agência, conta, instituição de liquidação) | `providerAccountId` só no admin | ausente | UI em "Minha conta" + campos da conta no parceiro (`merchants.bank_branch`, `bank_account`, `settlement_institution`) | P | plano 2 |
| Menu "Conta e sessão" (e-mail, ocultar saldos, trocar conta, sair). A Cashyin **não tem** perfil, troca de senha logado nem gestão de 2FA ou sessões | Só "Sair". `/conta/senha` existe, mas sem link | parcial | UI: página `/painel/conta` com dados do lojista, "Trocar senha", "Reconfigurar 2FA" (pedindo o código atual), sessões abertas com "Encerrar" e parceiro de liquidação (RC 16). Serviço: listar e derrubar sessões. **Com isso a Vantri passa a Cashyin** | M | — |
| Papéis admin / operador / leitor | 1 usuário por lojista (`role = merchant`) | ausente | Schema: `merchant_members(user_id, merchant_id, role)` ou `users.merchant_role`. UI: "Equipe" com convite (senha temporária mostrada uma vez, como o admin já faz) e troca de papel. Serviço: **checar papel em toda Server Action e rota**, não só esconder botão (o erro da Cashyin) | G | — |
| Multiempresa (`/select-account`, TOTP por conta, "Trocar conta") | Não existe (não-objetivo do spec) | ausente | Schema: vínculo N:N usuário × lojista + `sessions.current_merchant_id`. UI: seletor depois do 2FA e "Trocar conta". Pedir step-up ao trocar. Fazer depois dos papéis | G | — |
| "Acesso ainda não liberado" (`pending_role`/`disabled`) | "Seu cadastro está em análise." / "Sua conta está suspensa." / `?motivo=suspenso` | à frente | — | — | — |
| Login: layout com painel de marca e 3 cartões de segurança | Cartão central (AuthShell) | diferente | Opcional, só estético | P | — |
| Sem cadastro | `/cadastro` self-service com Receita e CNAE | à frente | — | — | — |
| MFA de 6 caixas com envio automático e "tremida" no erro | Campo único de 6 dígitos com botão | parcial | Opcional: enviar sozinho no 6º dígito | P | — |
| "Perdeu o acesso ao app autenticador? Fale com o suporte" | Nada. Sem caminho de recuperação | ausente | UI: link de suporte na tela de 2FA. Admin: "Resetar 2FA" (Parte 3) | P | — |
| Primeiro acesso: nova senha (12+, maiúscula, minúscula, número, símbolo, medidor) → configurar TOTP | Configurar TOTP → trocar senha (12+, sem regra de composição) | diferente | Nada obrigatório: tamanho mínimo vale mais que composição (NIST 800-63B). Opcional: medidor de força e bloqueio de senhas vazadas | P | — |
| **Esqueci minha senha** (código por e-mail + nova senha + mensagem neutra) | **Não existe**: quem esquece depende de SQL | ausente | Provedor de e-mail transacional (Resend tem cota grátis). Schema: `password_resets(user_id, code_hash, expires_at, attempts, used_at)`. UI: `/entrar/esqueci` em 2 passos. Regras: resposta neutra, limite por IP e por e-mail, código de uso único, derrubar sessões. **Precisa do OK do Lenda**: e-mail estava fora do escopo | M | — |
| 404 e tela de erro | Padrão do Next, em inglês | ausente | UI: `app/not-found.tsx` e `app/error.tsx` em pt-BR. **Nunca** mostrar a stack trace (a Cashyin mostra) | P | — |
| Idiomas pt-BR / en / zh | Só pt-BR | ausente | G (extrair todos os textos). **Não recomendo** para infoprodutor brasileiro | G | — |
| Tema escuro | Não | ausente | A Cashyin também não oferece (não há botão). Não fazer | — | — |

#### Início

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| Seletor de período (Hoje, 7 dias, Este mês, personalizado com hora BRT) | Fixo: hoje e 7 dias | ausente | UI: `?de&ate` + 3 atalhos e datas. Serviço: consultas por dia de Brasília (já existe `diaBrasilia`) | M | — |
| KPIs Entradas e Saídas do período, com nº, ticket médio, tarifa total e delta vs período anterior | "Recebido (bruto)" hoje e em 7 dias, com nº de Pix | parcial | Serviço `summary(merchantId, de, ate)` sobre o razão (soma de `cash_in`, `cash_out`, `fee_*`) + período anterior de mesma duração | M | — |
| Saldo com Bloqueado / Em MED / Total | Disponível / Bloqueado (= MED) / Total | igual | Nada. Na Vantri o saque debita na hora, então "bloqueado" é só MED | — | — |
| Gráfico de fluxo de caixa (entradas × saídas, áreas) | Barras SVG só de recebido, 7 dias | parcial | UI: segunda série (saídas) no mesmo SVG, sem biblioteca. Respeitar o período | P | — |
| Últimas transações (6, os dois sentidos, saldo após) | Últimas 5 cobranças | parcial | Ler do razão em vez de `charges` | P | — |
| Ações rápidas (Cobrar, Transferir, Extrato, Pix, Webhooks, API) | Não existe | ausente | 4 atalhos: Cobrar, Sacar, Extrato, Integrações | P | — |
| Resumo do dia (entradas, saídas, resultado) | Só "Recebido hoje" | parcial | Junto com o serviço `summary` | P | — |
| Alertas (webhook falhando, saldo bloqueado) | Não existe | ausente | Consultas: entregas `failed` nos últimos 7 dias, `blocked > 0` e **MED com prazo < 48 h** (a Cashyin não alerta prazo). Cards com link para a tela certa | P | — |
| Card de limites Pix (diário, mensal, noturno; âmbar a partir de 80%) | Não existe | ausente | Depende de limites existirem (ver Saques) | P | plano 2 |

#### Detalhe de transação e comprovante

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| Painel lateral único com abas (Resumo, Pix, Financeiro, Webhooks, Timeline, Auditoria, Payloads) | Cartão de detalhe da cobrança em `?id=`, com tarifa e "Você recebe" (a Cashyin mostra "Não informada pelo Core") | parcial / à frente em tarifa | UI: linha do tempo (criada, paga, expirada), "Entregas de webhook desta cobrança" e JSON público (`toChargeJson`). Schema: `webhook_deliveries.ref_id` (ou índice no `payload->data->id`) para achar as entregas | M | — |
| Detalhe do saque | **Não existe**: só lista e o alerta pós-envio | ausente | UI: `/painel/saques?id=` com chave mascarada, valor, tarifa, status, E2E, datas, motivo legível da falha e entregas de webhook | P | — |
| **Comprovante do Pix enviado** (visual + PDF + "confira a autenticidade") | Não existe | ausente | UI: `/painel/saques/[id]/comprovante` em HTML com `@media print` ("Salvar como PDF" do navegador, sem dependência nova). Código de autenticação = HMAC do id. Página pública `/comprovante/[codigo]` que confirma valor, data e E2E sem dado pessoal. Nome e instituição do favorecido vêm do parceiro | M | plano 2 (dados do favorecido) |
| Máscara de CPF/CNPJ/chave em toda a UI | O admin mascara; o painel mostra a chave inteira em Saques | parcial | Usar o `maskDocument` existente também no painel | P | — |

#### Extrato

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| Cards Entradas / Saídas / Resultado do período | Não existe | ausente | Mesmo serviço `summary` do Início | P | — |
| Período com atalhos e hora BRT | Datas De/Até (dia inteiro). Padrão 30 dias | parcial | UI: atalhos Hoje / 7 dias / Este mês. Hora fina só se pedirem | P | — |
| Filtro por tipo e por movimento | Não existe | ausente | Serviço: `kind[]` e `direction` (sinal do `amount_cents`) no `listStatement` e no CSV. UI: select. Também na API (`?kind=`) | P | — |
| Filtro por faixa de valor | Não existe | ausente | Fazer **no servidor** (na Cashyin é só na página e erra "10.50"). Opcional | P | — |
| Busca indexada (E2E, TxID, referência, nome; 12 meses) | Não existe | ausente | Serviço `search(merchantId, termo)` em `charges` (`txid`, `external_ref`, `end_to_end_id`, `payer_name`) e `payouts` (`id`, `end_to_end_id`, `pix_key`). Schema: índices em `end_to_end_id` (+ `pg_trgm` em `payer_name` se o volume pedir). UI: campo no Extrato com resultados agrupados | M | — |
| Saldo após cada lançamento | Não existe | ausente | SQL com `sum() over (order by created_at, id)` sobre o bucket disponível, mais o saldo anterior à página (uma consulta) | M | — |
| Tarifa exata em milésimos de centavo com aviso de arredondamento | Tarifa em centavos inteiros (`Math.round`) | diferente | Nada (mais simples e auditável) | — | — |
| Paginação com Anterior e 25/50/100 | Cursor só para frente ("Voltar ao início", "Próxima"), 50 fixo | parcial | UI: tamanho de página na URL. "Anterior" com pilha de cursores na URL | P | — |
| Abas Pendentes / Concluídas | Razão não tem lançamento pendente | diferente | Nada | — | — |
| Visão "Análise" (contagem por tipo da página) | Não existe | ausente | Baixo valor; pular | — | — |
| **Fecho Diário** (saldo de fechamento por dia, BRT, CSV/XLSX) | Não existe | ausente | Serviço: `generate_series` dos dias de Brasília + soma acumulada. Fazer **melhor** que a Cashyin, que só mostra o fechamento: abertura, entradas, saídas, tarifas, MED e fechamento. CSV com o mesmo `csvCell` | M | — |
| Exportar CSV e **XLSX** com filtro de tipo | CSV do período (sem tipo) | parcial | Tipo no CSV: P. XLSX: só se pedirem (o CSV com BOM já abre no Excel) | P | — |

#### Saques / transferências

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| Assistente Dados → Revisão → Verificação → Confirmação | Um formulário com o código 2FA junto e alerta no fim | diferente | UI: passo "Revisão" **com tarifa e saldo depois** (a Cashyin ignora a tarifa). Duas ações: `previewPayout` (sem efeito) e depois a atual com TOTP | M | — |
| Tipo + chave, sem validação | Tipo + chave validada (dígito do CPF/CNPJ, e-mail, +55, UUID) **antes** do 2FA | à frente | — | — | — |
| Nome e documento do favorecido (opcionais, digitados) | Não existe | ausente | Melhor esperar a consulta DICT do parceiro (nome real), em vez de texto livre. Schema: `payouts.recipient_name`, `recipient_document_masked`, `recipient_ispb` | P | plano 2 |
| Step-up TOTP em todo saque | Sim, com anti-replay e limite de tentativas | igual / à frente | — | — | — |
| **Saque parcelado** acima do teto por Pix (R$ 15 mil, lote, retomada) | Teto de R$ 50 mil por saque, sem lote | ausente | Só se o parceiro limitar valor por Pix. Schema: `payout_batches(id, merchant_id, total, chunk_cents, idempotency_key, status, failed_at_index)` + `payouts.batch_id`, `batch_index`. Serviço: cria as parcelas em sequência com chave `${lote}:${i}`, para na primeira falha e **guarda a retomada no servidor** (a Cashyin perde ao fechar o modal). UI: prévia das parcelas e "Retomar" | G | plano 2 (teto) |
| Status `returned` (Pix devolvido pelo recebedor) | `processing`, `completed`, `failed` | ausente | Schema: enum + estorno com o `cash_out_reversal` que já existe. Evento `payout.returned` do parceiro e webhook ao lojista | M | plano 2 |
| Motivo da falha | `failure_code` cru entre parênteses | parcial | Tabela código → texto pt-BR ("Chave Pix não encontrada", …), na UI e no comprovante | P | — |
| Lista com período, busca, abas e mini-cards | Lista simples, cursor de 20 | parcial | UI: abas por status e busca por chave/E2E. Contadores de **verdade** (não só da página) | P | — |
| Limites diário / mensal / noturno, com uso | Não existe (só tetos fixos no código) | ausente | Schema: `merchant_limits`. Serviço: somar os saques da janela (dia de Brasília, mês, 20h–6h) **dentro da transação** de `createPayout` (o `lockMerchant` já serializa). UI: card. Valores alinhados ao parceiro | M | plano 2 (valores) |
| "Em processamento" sem atualização | Mesmo comportamento (só recarregando) | igual | Opcional: atualizar a tela a cada 5 s enquanto houver saque em processamento (`router.refresh`) | P | — |

#### Receber (cobranças)

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| Valor + descrição; ref gerada | Valor + descrição + **validade** + tarifa exibida | à frente | — | — | — |
| Máscara de moeda "centavos que empurram" | Texto livre com leitura estrita ("49,90") | diferente | Opcional | P | — |
| QR, copia e cola, copiar TxID, "Atualizar status" | QR, copia e cola, IDs, "Atualizar status" | igual | — | — | — |
| Polling do pagamento | Nenhum dos dois tem | igual | Opcional: atualizar a cada 3 s enquanto pendente. **Passaria a Cashyin** | P | — |
| KPIs (da página) | Não existe | ausente | Totais **reais** do período: recebido, aguardando, expiradas | P | — |
| Lista com período, busca (TxID, ref, E2E, pagador), abas e colunas Pagador, Documento mascarado, E2E/TxID, Pago em, botão copiar Pix | Filtro de status e colunas Criada / Descrição / Valor / Status | parcial | UI: período, busca e colunas de pagador e pagamento. Serviço: `filter` no `listCharges` | M | — |
| Status `cancelled`, `failed`, `refunded` | `pending`, `paid`, `expired` | ausente | Cancelar cobrança: P no simulador (API `POST /charges/{id}/cancel`), mas o parceiro precisa suportar. Devolução (`refunded`) iniciada pelo lojista: G | P/G | plano 2 |
| "Simular pagamento" | Só a Vantri tem | à frente | — | — | — |

#### Infrações / MED

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| 6 KPIs (bloqueio cautelar, em aberto, aguardando PSP, defesa enviada, favorável, estornado) | Não existe | ausente | Contagens no servidor sobre **todos** os casos (não só 200) | P | — |
| Filtros (datas, busca, abas) e tipo de infração | Lista com prazo, motivo e status, cursor de 20 | parcial | UI: abas por status e busca por E2E. Schema: `med_cases.fraud_type` | P | plano 2 (tipo) |
| Prazo crítico (< 48 h em vermelho) | ≤ 2 dias em vermelho, "faltam N dias", "Encerrado em" | igual / à frente | — | — | — |
| Detalhe com categoria de fraude, relato do pagador, pagador, TXID, ID Bacen | Motivo, prazo, link para a cobrança, encerrado em | parcial | Schema: `fraud_type`, `payer_report`, `situation`, `bacen_id`, `payer_name`, `payer_document_masked`. Os dados vêm do parceiro | P | plano 2 |
| Linha do tempo (recebida via DICT, bloqueio, aguardando defesa, defesa enviada, análise, favorável, estornado, encerrada) | Não existe | ausente | Schema: `med_events(case_id, type, at, meta)`, gravados em `applyMedOpened`, `submitDefense` e `applyMedClosed`. UI: lista vertical. Serve também ao admin | M | — |
| Defesa com mínimo de caracteres do servidor; anexos de 5 MB cada, sem limite de quantidade, em base64 | 20 a 5000 caracteres; até 5 arquivos, 4 MB somados; tipo conferido pelos bytes | igual / à frente (conteúdo) | Subir o teto dos anexos: upload por Route Handler em vez de Server Action, ou `bodySizeLimit` maior. 4 MB somados aperta para prints de conversa | P | — |
| Defesa pela API (`pix_med:write`, multipart) | API de MED só leitura | ausente | API: `POST /api/v1/med/{id}/defense` multipart + escopo `med:write` + OpenAPI | M | — |
| Histórico de defesas (várias, com status) | Uma defesa por caso | parcial | Só se o parceiro aceitar reenvio. Schema: `med_defenses` | M | plano 2 |
| Baixar os próprios anexos | Sim (a Cashyin só mostra os nomes) | à frente | — | — | — |
| Webhooks de MED granulares (`opened`, `hold_placed`, `released`, `refunded`, `closed`) | `med.opened`, `med.closed` (com o desfecho) | diferente | Nada obrigatório. Mesma informação | — | — |
| Retenção limitada ao saldo (`partially_held`) | Bloqueia o valor inteiro mesmo sem saldo (disponível fica negativo) | diferente | Decisão consciente; manter | — | — |

#### Integração & API

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| Abas com URL (Chaves, Webhooks, Segurança) | Uma página com seções | diferente | UI: `?aba=`, quando entrar o inspetor de entregas | P | — |
| **Uma** chave ativa por conta | **Várias** chaves, cada uma com nome, escopos e IPs; mostra "último uso" e "Nunca" | à frente | — | — | — |
| Escopos agrupados com rótulos e "selecionar grupo" | 7 checkboxes com rótulo e ID. A tabela mostra os IDs crus | parcial | UI: agrupar (Cobranças, Saques, Saldo e extrato, MED) e mostrar os rótulos na tabela | P | — |
| Exibição única de "Chave de API" + "Segredo de assinatura", "Copiar ambos" | Exibição única da chave | parcial | Assinatura de requisição: **não fazer** (a Cashyin nem documenta o algoritmo) | — | — |
| Rotacionar chave (mesmos escopos, a antiga morre na hora) | Não existe (criar outra e revogar) | ausente | Serviço: `rotateApiKey` copia nome, escopos e IPs, revoga a antiga e devolve a nova uma vez. Opcional: período de graça (`api_keys.expires_at`) | P | — |
| Revogar com confirmação | Revoga direto, sem confirmar | parcial | UI: confirmação | P | — |
| Allowlist **da conta** com CIDR (mínimo /24 e /64), descrição, ativar/desativar, liga/desliga geral | Allowlist **por chave**, IP exato, até 20, definida na criação, sem edição | diferente / parcial | Serviço: aceitar CIDR com `node:net` `BlockList` (já usado em `ssrf.ts`), mantendo os prefixos mínimos. UI: editar os IPs de uma chave existente, com descrição por IP. Schema: `api_key_ips(key_id, cidr, label, active)` ou jsonb | M | — |
| "Testar um IP" | Não existe | ausente | Serviço: `checkIp(keyId, ip)`. UI: campo e resultado (permitido / bloqueado / sem restrição) | P | — |
| Webhooks: nome, URL, eventos | URL + eventos | parcial | Schema: `webhook_endpoints.description` | P | — |
| Editar endpoint | Não existe | ausente | UI + serviço `updateEndpoint` (revalida a URL contra SSRF) | P | — |
| Excluir endpoint (com confirmação) | Não existe | ausente | Serviço: apagar (entregas em cascata) ou desativar | P | — |
| Ativar/desativar endpoint | Coluna `active` existe, sem tela | parcial | UI: botão | P | — |
| Novo segredo de webhook (exibição única) | Não existe | ausente | Serviço: `rotateEndpointSecret`. A Vantri tem 1 segredo por endpoint, sem o bug de grupo da Cashyin | P | — |
| **Testar envio** ("em breve" na Cashyin) | Não existe | ausente | Serviço: enfileirar `test.ping` (ou um `charge.paid` de exemplo com `"test": true`) só para aquele endpoint. **Passaria a Cashyin** | P | — |
| Saúde por endpoint (95% / 80%) | Não existe | ausente | SQL sobre as últimas 100 entregas de cada endpoint | P | — |
| KPIs de entregas 24 h (entregues, falhas, latência média, aguardando retry) | Não existe | ausente | Schema: latência por tentativa. Serviço de agregação | P | — |
| Filtros (endpoint, período, status, evento ou identificador da transação) e página de 25/50/100 | Só as últimas 50 | parcial | Serviço `listDeliveries(merchantId, filtros, cursor)`. Busca por identificador usa `ref_id` (ver Detalhe) | M | — |
| **Inspetor de entrega** (request, corpo, resposta, timeline de tentativas, próxima tentativa, exportar JSON) | Status, HTTP, tentativas e próxima tentativa na tabela | parcial | Schema: `webhook_attempts(delivery_id, n, at, status_code, latency_ms, error, response_snippet ≤ 1 KB)`, gravada no `dispatchDue`. UI: `/painel/integracoes/entregas/[id]` com payload, cabeçalhos enviados (sem o segredo), tentativas e "Baixar JSON" | M | — |
| Reenviar | Sim (escondido para entrega nunca tentada) | igual | — | — | — |
| DLQ "Descartada" | `failed` depois de 7 tentativas | igual | — | — | — |

#### Outras telas

| Recurso da Cashyin | Vantri hoje | Situação | O que falta | Tam. | Parceiro |
|---|---|---|---|---|---|
| `/pix` Adquirente PIX (somente leitura, fora do menu) | Não se aplica: um parceiro só | diferente | Mostrar o parceiro de liquidação em "Minha conta" (transparência da RC 16; a Cashyin esconde por desenho) | P | plano 2 |
| `/splits` (placeholder "em breve") | Não existe | ausente | **Não copiar o placeholder.** Split de verdade só se o parceiro suportar subconta ou divisão na liquidação | G | plano 2 |
| `/documentacao` (redireciona para a doc externa) | `/docs` público com OpenAPI 3.1 em português | à frente | — | — | — |

### 2.3 As lacunas que mais valem, em ordem

| # | Lacuna | Por que vale | Tam. | Parceiro |
|---|---|---|---|---|
| 1 | **Esqueci minha senha** | Hoje um lojista que esquece a senha fica preso, e o admin só resolve no banco. É o primeiro chamado de suporte de qualquer painel. | M | — (precisa de e-mail) |
| 2 | **Detalhe do saque + motivo legível + comprovante** | Lojista de infoproduto manda comprovante ao fornecedor e ao afiliado. Sem ele, cada saque vira pergunta. | P + M | comprovante completo no plano 2 |
| 3 | **Webhooks completos**: editar, excluir, ativar/desativar, novo segredo, **testar envio**, saúde | A integração é o produto para quem usa a API. "Testar" é algo que a Cashyin não tem. | M (soma de P) | — |
| 4 | **Inspetor de entregas** (tentativas, resposta, filtros, busca por transação) | O lojista para de abrir chamado com "não recebi o webhook". | M | — |
| 5 | **Extrato que fecha conta**: filtro por tipo, cards do período, saldo após, Fecho Diário | É o que o contador pede todo mês. | M | — |
| 6 | **Busca por E2E / TxID / referência / nome** | Atendimento ao comprador final ("paguei e não liberou"). | M | — |
| 7 | **Início com período, entradas × saídas, alertas e ações rápidas** | Primeira tela, uso diário. Os alertas incluem prazo de MED, que a Cashyin não avisa. | M | — |
| 8 | **MED: KPIs, linha do tempo, defesa pela API** | Perder prazo é perder dinheiro, e quem tem volume quer defender pela API. | M | dados finos no plano 2 |
| 9 | **Equipe e papéis com checagem no servidor** | Infoprodutor tem sócio, financeiro e dev. Hoje todos usariam o mesmo login e o mesmo 2FA. | G | — |
| 10 | **Minha conta** (trocar senha, 2FA, sessões, parceiro) | `/conta/senha` existe, mas está órfã. | M | — |
| 11 | **Limites de saque** | Antifraude básico e exigência provável do parceiro. | M | plano 2 |
| 12 | **Allowlist com CIDR, edição e "testar IP"** | Integração em nuvem raramente tem IP fixo único. | M | — |
| 13 | 404 e tela de erro em pt-BR | Barato e evita tela em inglês no meio do fluxo. | P | — |
| 14 | Multiempresa | Agências e quem tem mais de um CNPJ. Só depois dos papéis. | G | — |
| 15 | Saque parcelado | Só se o parceiro limitar o valor por Pix. | G | plano 2 |

### 2.4 Onde a Vantri já está na frente

| Tema | Vantri (16/10) | Cashyin (público) |
|---|---|---|
| Cadastro | Self-service em `/cadastro` (CPF ou CNPJ, segmento, senha), CNPJ consultado na Receita na hora, CNAE de apostas recusado, Turnstile, limite de 10 cadastros/h por IP; e também "admin cria e entrega senha temporária". | Sem cadastro. Conta criada pela equipe, senha temporária entregue fora do sistema. |
| Ambiente de teste | Simulador completo: cobrança com BR Code válido, "Simular pagamento" no painel, saque que falha de propósito (`falha@teste.com`), MED de teste aberto e encerrado pelo admin, mesmo caminho de código do parceiro real. | "Sandbox" citado em uma frase, sem URL nem credencial. "Testar webhook" desabilitado ("depende do Core"). |
| Assinatura de webhook | `X-Vantri-Signature: t=<unix>,v1=<hmac>` sobre `"<t>.<corpo>"`, tolerância de 5 min (anti-replay), exemplo de verificação na doc. | `sha256=<hmac(corpo)>` sem timestamp: replay possível. |
| Retentativas de webhook | 7 tentativas em ~33 h (1 min, 5 min, 30 min, 2 h, 6 h, 24 h). | 5 tentativas em ~96 min e DLQ. |
| Proteção de webhook | URL só `https`, bloqueio de IP interno também pelo DNS na hora do envio, `redirect: manual`, erro mostrado só como categoria. | Não observável no front. |
| Expiração da cobrança | `expires_in` de 5 min a 24 h (API) e seletor no painel (15 min a 24 h). | Sem parâmetro de expiração. |
| API de listagem | `GET /charges`, `/payouts`, `/med` com cursor, pela API pública. | Listagem e busca só pelo painel (BFF). |
| Contrato | OpenAPI 3.1 servida em `/api/v1/openapi.json` + `/docs` renderizado no próprio site, em português. | OpenAPI 3.0.3, download desligado, docs com links quebrados e contradições. |
| Limite de taxa da API | 120 req/min por chave, 429 com `Retry-After`, documentado. | Não documentado (só 503). |
| Allowlist de IP | Por **chave** (cada integração com sua lista). | Por conta (vale para todas as chaves). |
| Segurança de login | Bloqueio de 15 min após 5 erros (atômico), limite por IP, hash argon2, TOTP com anti-replay do mesmo código (RFC 6238 §5.2), 2FA obrigatório antes de qualquer tela, troca de senha derruba as outras sessões. | Cognito (bom), detalhes de bloqueio não observáveis. |
| Cabeçalhos | CSP definida (com Turnstile), HSTS preload, `frame-ancestors 'none'`. | Sem CSP. |
| Painel admin | Existe: aprovar/recusar/suspender/reativar, criar cliente, taxas por cliente (% e fixo, entrada e saída), transações de todos, MED. | Não público (não dá para comparar). |
| Registro legal | `access_logs` (Marco Civil art. 15) e `audit_log` desde o início. | Não observável. |
| Regulatório | Uma conta no parceiro por lojista (RC 16/2025), aviso "não é instituição autorizada" e nome do parceiro no rodapé/termos; sem apostas. | Conta-bolsão no provedor ("conta de liquidação da CashYin"), provedor escondido por desenho. |
| CSV | Separador `;`, BOM para o Excel, proteção contra injeção de fórmula, recusa acima de 50 mil linhas em vez de cortar calado. | CSV/XLSX (melhor em formato; proteção não observável). |
| MED no saldo | Bloqueio entra mesmo sem saldo (disponível fica negativo e a dívida não some). | Retenção limitada ao saldo (`partially_held`): o resto pode se perder. |
| Celular | Menu vira faixa rolável no topo em todas as telas. | Abaixo de 768 px as telas principais ficam **sem menu** (1.0). |
| Chaves de API | Várias chaves, cada uma com nome, escopos, IPs e "último uso". | Uma chave ativa por conta. |
| Saque | Chave Pix validada e normalizada (dígito do CPF/CNPJ, +55, e-mail, UUID) **antes** de gastar o código 2FA. Saldo conferido **com a tarifa**. | Chave sem validação nenhuma no front; saldo conferido sem a tarifa. |
| Cobrança | Tarifa e "Você recebe" no detalhe; validade escolhida pelo lojista. | "Taxa: Não informada pelo Core"; sem validade. |
| MED | Lojista baixa os próprios anexos; anexos conferidos pelo conteúdo (bytes), não pela extensão. | Só os nomes dos anexos; tipo conferido só pelo seletor de arquivo. |
| Erros | Mensagens em português escritas por código, sem dado interno. | Mensagem crua do servidor no toast. |

### 2.5 O que depende do parceiro real (plano 2) e o que dá para fazer já com o simulador

**Precisa do parceiro real (plano 2):**
- Consulta DICT antes do saque (nome do favorecido, instituição, ISPB) e o passo "Revisão" mostrando isso.
- Status `returned` (Pix devolvido pelo recebedor) e o estorno correspondente.
- Devolução de cobrança (`refunded`) iniciada pelo lojista ou por MED, se o parceiro oferecer.
- MED real: tipo de fraude, situação, relato do pagador, eventos "recebido via DICT", envio da defesa ao parceiro e o desfecho.
- Limites diário/mensal/noturno que o parceiro impõe e o teto por transferência (define se precisa de "saque parcelado").
- Dados da conta de liquidação no perfil (agência, conta, instituição) e no comprovante.
- Comprovante com dados bancários reais e verificação pública.
- Conciliação com o extrato do parceiro.
- Split, se o parceiro suportar subcontas ou divisão na liquidação.

**Dá para fazer agora, com o simulador:**
- Tudo de interface e serviço do painel: assistente de saque com revisão, comprovante, saque em parcelas (com teto configurável), limites próprios, extrato com filtros/busca/saldo acumulado/fechamento diário/exportação, dashboard com período e gráficos, alertas, ocultar saldos.
- Integrações: rotacionar chave, CIDR e "testar IP", editar/desativar/remover webhook, rotacionar segredo, evento de teste, inspetor de entrega com tentativas, filtros e KPIs.
- Conta: recuperar senha (precisa só de um provedor de e-mail), página de perfil e segurança, vários usuários por lojista com papéis, seletor de empresa.
- MED: KPIs, linha do tempo com os eventos que o simulador gera, defesa pela API.
- Todo o backoffice da Parte 3, menos conciliação com o parceiro e envio de defesa.

---

## Parte 3 — Backoffice da Vantri: o que o operador precisa ter por dentro

O backoffice da Cashyin não é público, então nada aqui copia telas dele. A proposta sai de três fontes: (1) o que o painel e a API da Cashyin **pressupõem** que exista do outro lado (alguém vincula usuário a cliente, define o roteamento de adquirente, ajusta limite, acompanha MED que "chega via DICT", reprocessa webhook que caiu na DLQ, responde a "contacte o suporte"); (2) o que a Vantri já tem em `/admin`; (3) prática padrão de quem opera dinheiro de terceiros (conciliação diária, quatro olhos em ajuste manual, trilha de auditoria imutável, guarda de registro de acesso do Marco Civil).

### 3.1 O que já existe no `/admin` da Vantri (16/10)

| Tela | O que faz hoje |
|---|---|
| `/admin` Início | 4 cartões: cadastros pendentes, recebido hoje (bruto), saques em processamento (qtd + R$), MEDs abertos/defendidos. Sem gráfico, sem período. |
| `/admin/clientes` | Lista com abas de status (Todos, Pendentes, Ativos, Suspensos, Recusados), selo "revisão manual", paginação por página (25). "Criar cliente" (CNPJ consultado na hora, nasce ativo, senha temporária mostrada uma vez). |
| `/admin/clientes/[id]` | Dados (documento mascarado, segmento, logins, conta no parceiro), ações de status (aprovar com checagem manual de CNAE, recusar, suspender, reativar), saldo (disponível/bloqueado/total), 4 taxas (% e R$, entrada e saída), 10 últimas cobranças e saques. |
| `/admin/transacoes` | Cobranças ou saques de todos, filtro por cliente/status/período (dia de Brasília), 25 por página. |
| `/admin/med` | Casos com abas de status, defesa e anexos; com o simulador: abrir MED de teste e encerrar. |
| Registro | `audit_log` grava só 6 ações, todas de cadastro (criar, aprovar, recusar, suspender, reativar cliente e mudar taxa). `access_logs` grava login e falha de login do painel. Nenhum dos dois tem tela. |

Papel único `admin`: quem é admin pode tudo. Não há dois níveis, nem regra de quatro olhos.

### 3.2 Telas propostas, por prioridade

**P0 = antes de ligar o parceiro real (dinheiro de verdade). P1 = primeiras semanas de operação. P2 = quando o volume pedir.**

| # | Tela | Prioridade | Por que | Tamanho |
|---|---|---|---|---|
| 1 | Papéis do admin + quatro olhos | P0 | Hoje um admin sozinho muda taxa, aprova cliente e (no simulador) encerra MED. Com dinheiro real, ajuste de saldo e estorno manual precisam de duas pessoas. | M |
| 2 | Razão e conciliação | P0 | É o único jeito de provar que o saldo de cada lojista bate com a conta dele no parceiro. | G |
| 3 | Saques (operação) | P0 | Saque preso em `processing` é o chamado mais comum de um gateway. Hoje só dá para ver a lista. | M |
| 4 | Fila de MED com prazos | P0 | O prazo de defesa é curto. Perder prazo é perder dinheiro do lojista. | M |
| 5 | Monitor de webhooks | P0 | Entrega que falha 7 vezes vira `failed` sem ninguém saber. | M |
| 6 | Trilha de auditoria (tela + mais eventos) | P0 | A tabela existe, mas sem tela e cobrindo só 6 ações de cadastro. | M |
| 7 | Registros de acesso (Marco Civil, art. 15) | P0 | Ordem judicial pede IP, data e hora de um usuário; hoje só dá para responder com SQL na mão. | P/M |
| 8 | Saúde do sistema (cron, parceiro) | P0 | O `/api/cron/tick` devolve contagens e erros, mas ninguém guarda nem vê. | P |
| 9 | Fila de análise de cadastro (KYC/KYB) | P1 | Já existe a aprovação; falta motivo da recusa, documentos, histórico e aviso ao lojista. | M |
| 10 | Início com gráficos por dia e por lojista | P1 | Os 4 cartões não mostram tendência nem concentração. | M |
| 11 | Saldos por lojista | P1 | Visão única de quanto a Vantri "deve" a cada lojista e quem está com disponível negativo. | P |
| 12 | Usuários e acessos | P1 | Resetar 2FA, desbloquear, forçar troca de senha, derrubar sessões. Hoje só por SQL. | M |
| 13 | Planos de tarifa | P1 | Taxa por cliente em 4 campos soltos; falta modelo reutilizável e histórico com data de vigência. | M |
| 14 | Exportações | P1 | Contador e jurídico vão pedir CSV/XLSX de transações, razão, fechamento e acessos. | M |
| 15 | Limites e risco | P2 | Limite diário/mensal/noturno por lojista, teto por saque, lista de bloqueio de chave/documento. | G |
| 16 | Ver como o lojista (só leitura) | P2 | Suporte enxergar o painel do cliente sem pedir print. Com banner e registro de auditoria. | M |

### 3.3 O que cada tela tem por dentro

**1. Papéis do admin + quatro olhos (P0, M)**
- Papéis: `superadmin` (tudo, inclusive gerir admins), `financeiro` (razão, conciliação, saques, ajustes), `compliance` (cadastros, MED, registros de acesso, auditoria), `suporte` (só leitura de clientes e transações, reset de 2FA com verificação). Hoje `users.role` só tem `admin|merchant`: virar `admin_role` à parte ou uma tabela `admin_roles`.
- Quatro olhos: ajuste manual de saldo, estorno manual de saque, mudança de taxa acima de um teto e reativação de cliente suspenso por risco viram **pedido** (`pending_approvals`: quem pediu, o quê, por quê, valor) que **outro** admin aprova. Quem pediu não pode aprovar.
- Toda ação de admin pede o código TOTP de novo (step-up), como o saque do lojista já pede.

**2. Razão e conciliação (P0, G)**
- Razão por lojista: todos os lançamentos (`cash_in`, `fee_in`, `cash_out`, `fee_out`, `cash_out_reversal`, `med_hold`, `med_release`, `med_debit`, `adjustment`), filtro por tipo, saldo (disponível/bloqueado), período e referência; coluna de saldo acumulado; link para a cobrança, o saque ou o MED de origem.
- Fechamento diário (dia de Brasília): saldo de abertura, entradas, saídas, tarifas, MED, saldo de fechamento, por lojista e somado. É a mesma conta do "Fecho Diário" da Cashyin, vista pelo operador.
- Conciliação com o parceiro (**plano 2**): para cada conta do lojista no parceiro, comparar o extrato do parceiro com o nosso razão, linha a linha, por `end_to_end_id`. Divergências em fila: pago no parceiro e pendente aqui; saque concluído lá e falho aqui; valor diferente; lançamento sem par. Cada divergência tem dono, status e nota.
- Receita da Vantri: soma de `fee_in` + `fee_out` por dia/lojista. Hoje não aparece em lugar nenhum.
- Ajuste manual: lançamento `adjustment` com motivo obrigatório, anexo opcional e quatro olhos. Nunca editar ou apagar lançamento existente: só lançar o contrário.

**3. Saques — operação (P0, M)**
- Lista de todos os saques com idade ("há 14 min em processamento"), `failure_code`, id no parceiro, E2E, chave mascarada, valor e tarifa. Filtro rápido "presos há mais de 10 min".
- Ações: "Consultar no parceiro agora" (roda o `pollProcessingPayouts` só para aquele id), "Reenviar ao parceiro" (mesma chave de idempotência, só se ainda não tem id do parceiro), "Marcar como falho e estornar" (quatro olhos + evidência do parceiro). Tudo vai para a auditoria.
- Detalhe do saque: linha do tempo (pedido, enviado, resposta do parceiro, cada consulta do cron, resultado), payload enviado e recebido (sem dado pessoal além do necessário).

**4. Fila de MED com prazos (P0, M)**
- Ordenada pelo prazo de defesa: vermelho com menos de 24 h, amarelo com menos de 72 h. Contadores no topo: abertos, valor bloqueado total, prazo vencendo hoje, defesas pendentes de envio ao parceiro.
- Detalhe: cobrança de origem, valor bloqueado, motivo/tipo de fraude (vindo do parceiro), defesa e anexos do lojista, linha do tempo de eventos (aberto, bloqueio, defesa enviada, resposta, encerramento). Hoje o caso só tem `status` e datas soltas: falta a tabela de eventos.
- Ações: "Enviar defesa ao parceiro" (**plano 2**), "Cobrar o lojista" (e-mail/aviso no painel), anotações internas. Encerrar só com o desfecho do parceiro (como já é fora do simulador).
- Taxa de MED por lojista (casos ÷ cobranças pagas, 30 dias) com alerta acima de um limite: é o principal sinal de lojista fraudador.

**5. Monitor de webhooks (P0, M)**
- Todas as entregas de todos os lojistas: filtro por lojista, endpoint, evento, status, período. Taxa de sucesso por endpoint em 24 h e 7 dias.
- Fila de "falhou de vez" (o equivalente à DLQ da Cashyin): reenviar uma ou em lote.
- Detalhe de uma entrega: payload, cabeçalhos enviados, cada tentativa (hora, código HTTP, latência, categoria do erro). Para isso o schema precisa guardar as tentativas (`webhook_attempts`), não só a última.
- Endpoint que falha há N dias seguidos: desativar e avisar o lojista (com registro).

**6. Trilha de auditoria (P0, M)**
- Tela com filtro por quem fez, ação, lojista e período; detalhe com o `meta` em JSON. Somente leitura, sem botão de apagar.
- Ampliar o que é gravado (o login já fica em `access_logs`): abrir/encerrar MED, ajuste manual, ações em saque, reset de 2FA/senha, revogação de chave pelo admin, exportações (quem baixou o quê), mudança de limite, aprovação/recusa de quatro olhos.
- Do lado do lojista também: criar/revogar chave, criar/remover webhook, pedir saque (usuário + IP), enviar defesa. Hoje nada disso fica registrado com o autor.

**7. Registros de acesso — Marco Civil (P0, P/M)**
- Busca por e-mail, usuário, IP ou período; resultado com data, hora e fuso (UTC e Brasília), IP, evento (login, falha de login).
- Exportação em CSV para responder a ordem judicial, com hash SHA-256 do arquivo gravado na auditoria.
- Guarda de 6 meses (art. 15) com limpeza no cron (o comentário do schema já prevê; o passo ainda não existe no `/api/cron/tick`).
- Lacunas para fechar: as chamadas da API (`/api/v1`) não registram IP; a sessão do painel só registra o login, não cada uso. Avaliar guardar a porta de origem quando o provedor de hospedagem entregar (decisões do STJ pedem porta lógica em caso de CGNAT). **Confirmar com advogado** o escopo exato antes de lançar.

**8. Saúde do sistema (P0, P)**
- Última rodada do cron e de cada passo (cobranças expiradas, saques liquidados, webhooks enviados, erros), guardada numa tabela e mostrada com "há quanto tempo". Alerta se o cron não roda há mais de 5 min.
- Provedor ativo (`simulator` ou o parceiro), últimas falhas de chamada ao parceiro, webhooks do parceiro recebidos/recusados (401/400).

**9. Fila de análise de cadastro (P1, M)**
- Fila só de `pending`, mais antigos primeiro, com o resultado da consulta de CNPJ (razão social, situação, CNAEs) guardado no cadastro (hoje é consultado e descartado; só fica o `needs_manual_review`).
- Recusar com **motivo** (lista + texto) e aviso ao lojista; hoje a recusa não guarda motivo.
- KYC/KYB de verdade quando o parceiro exigir (**plano 2**): contrato social, documento do sócio, comprovante de endereço, selfie. Upload pelo lojista, conferência aqui, status por documento.
- Histórico do cadastro: quem aprovou, quando, com qual checagem.

**10. Início com gráficos (P1, M)**
- Seletor de período (hoje, 7 dias, 30 dias, mês, personalizado; dias de Brasília).
- Cartões: recebido bruto, recebido líquido, enviado, receita de tarifa, nº de cobranças pagas, conversão (pagas ÷ criadas), ticket médio, saques com falha (%), MED aberto (R$).
- Gráfico de barras por dia: recebido × enviado. Tabela "maiores lojistas no período" (volume, nº, tarifa, MED %).
- Alertas: saques presos, webhooks falhando, cron parado, lojista com disponível negativo, prazos de MED vencendo.

**11. Saldos por lojista (P1, P)**
- Uma linha por lojista ativo: disponível, bloqueado, total, último movimento; ordenar por qualquer coluna; destaque para disponível negativo (MED aberto depois de um saque, regra atual do serviço). Soma no rodapé.

**12. Usuários e acessos (P1, M)**
- Lista de usuários (admins e lojistas): e-mail, papel, lojista, 2FA ativo, último login, bloqueado até, troca de senha pendente.
- Ações (com step-up e auditoria): desbloquear, forçar troca de senha (gera senha temporária mostrada uma vez, como já é na criação), resetar 2FA (só depois de verificar identidade fora do sistema), derrubar todas as sessões.
- Quando o lojista tiver vários usuários e papéis (ver Parte 2), esta tela mostra os vínculos usuário × lojista × papel.

**13. Planos de tarifa (P1, M)**
- Planos nomeados ("Padrão: 1,49% recebido + R$ 1,00 enviado"), atribuídos a vários lojistas; taxa personalizada continua possível.
- Histórico com data de vigência (`fee_history`): hoje mudar a taxa sobrescreve os 4 campos, e a auditoria guarda só o valor novo.
- Simulador: "para uma venda de R$ 197,00, o lojista recebe R$ X".

**14. Exportações (P1, M)**
- CSV (e XLSX, se valer a dependência) de: transações, razão, fechamento diário, MED, registros de acesso, auditoria. Período em dias de Brasília, como o extrato.
- Toda exportação registrada na auditoria (quem, o quê, período).

**15. Limites e risco (P2, G)**
- Por lojista: limite diário, mensal e noturno de saque, teto por saque, valor máximo de cobrança. Hoje os tetos são fixos no código (cobrança até R$ 100.000, saque até R$ 50.000).
- Lista de bloqueio: chave Pix, documento, e-mail. Retenção cautelar manual de saldo (com quatro olhos).
- Os limites que o parceiro impõe entram aqui como teto (**plano 2**).

**16. Ver como o lojista (P2, M)**
- Abre o painel do lojista em modo leitura, com faixa "Você está vendo como <Loja>", sem nenhuma ação de escrita, registrado na auditoria. Alternativa mais simples: as telas do lojista renderizadas dentro do `/admin/clientes/[id]`.

### 3.4 Mudanças de schema que o backoffice pede

| Mudança | Para quê |
|---|---|
| `admin_role` (ou tabela `admin_roles`) | papéis do admin |
| `pending_approvals` (id, tipo, payload, pedido_por, aprovado_por, status, datas) | quatro olhos |
| `webhook_attempts` (delivery_id, n, hora, http, latência, erro) | inspetor de entrega |
| `med_events` (case_id, tipo, hora, origem, meta) | linha do tempo do MED |
| `merchants.rejection_reason`, `merchants.cnpj_lookup jsonb` | fila de cadastro |
| `fee_plans` + `fee_history` (merchant_id, valores, vigente_desde, autor) | planos e histórico de tarifa |
| `merchant_limits` (diário, mensal, noturno, teto por saque) | limites |
| `cron_runs` (passo, início, fim, resultado, erro) | saúde do sistema |
| `access_logs.event` ganha `api_call`/`session_use` (ou tabela à parte, com retenção curta) | Marco Civil completo |
| `reconciliation_items` (fonte, e2e, valor_nosso, valor_parceiro, status, dono, nota) | conciliação (plano 2) |

### 3.5 Ordem de construção sugerida

1. P0 que não depende do parceiro: papéis + quatro olhos, auditoria (tela e eventos), registros de acesso (tela, exportação, limpeza de 6 meses), saúde do cron, monitor de webhooks, fila de MED, operação de saques, razão por lojista e fechamento diário.
2. Ao ligar o parceiro (plano 2):
   - conciliação com o extrato do parceiro;
   - envio de defesa de MED;
   - KYC exigido por ele;
   - limites dele;
   - a ação **"Abrir conta no parceiro"** para os clientes que nasceram no simulador (`provider_account_id` começando com `sim_`). Desde o commit `26ae341`, essas contas recusam cobrança e saque fora do simulador, com o código `simulated_account`.
3. P1 e P2 conforme o volume.
