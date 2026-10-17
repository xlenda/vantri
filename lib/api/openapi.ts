import { SITE_URL } from "@/app/(site)/site";
import { SCOPES } from "./keys";

// Contrato OpenAPI 3.1 escrito à mão. Mudou rota, campo ou erro? Atualize aqui (o /docs renderiza este objeto).

const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({ $ref: `#/components/responses/${name}` });
const param = (name: string) => ({ $ref: `#/components/parameters/${name}` });
const body = (description: string, s: object) => ({ description, content: { "application/json": { schema: s } } });
const nullable = (type: string, extra: object = {}) => ({ type: [type, "null"], ...extra });
const dateTime = (description: string) => ({ type: "string", format: "date-time", description });
const cents = (description: string) => ({ type: "integer", description });
const page = (item: string) => ({
  type: "object",
  required: ["data", "next_cursor"],
  properties: {
    data: { type: "array", items: schema(item) },
    next_cursor: nullable("string", { description: "Passe em `cursor` para a próxima página. `null` = acabou." }),
  },
});
const auth = {
  "401": response("Unauthorized"),
  "403": response("Forbidden"),
  "429": response("RateLimited"),
  "500": response("InternalError"),
};

const SCOPE_DOC: Record<(typeof SCOPES)[number], string> = {
  "balance:read": "consultar o saldo",
  "charges:read": "listar e consultar cobranças",
  "charges:write": "criar cobranças",
  "payouts:read": "listar e consultar saques",
  "payouts:write": "pedir saques",
  "statement:read": "consultar o extrato",
  "med:read": "listar e consultar casos de MED",
};

const NODE_EXAMPLE = [
  "```js",
  'import { createHmac, timingSafeEqual } from "node:crypto";',
  "",
  "// corpo: o corpo cru da requisição (string), antes de qualquer JSON.parse.",
  "export function assinaturaValida(corpo, header, segredo, toleranciaSeg = 300) {",
  '  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");',
  "  if (!m) return false;",
  "  const t = Number(m[1]);",
  "  if (Math.abs(Date.now() / 1000 - t) > toleranciaSeg) return false;",
  '  const esperado = createHmac("sha256", segredo).update(t + "." + corpo).digest();',
  '  return timingSafeEqual(Buffer.from(m[2], "hex"), esperado);',
  "}",
  "",
  "// Exemplo com Next.js (App Router): app/webhooks/vantri/route.js",
  "export async function POST(req) {",
  "  const corpo = await req.text();",
  '  const header = req.headers.get("x-vantri-signature");',
  "  if (!assinaturaValida(corpo, header, process.env.VANTRI_WEBHOOK_SECRET)) {",
  '    return new Response("assinatura inválida", { status: 401 });',
  "  }",
  "  const evento = JSON.parse(corpo);",
  "  // Já processou evento.id? Responda 200 e ignore: a mesma entrega pode chegar de novo.",
  "  return new Response(null, { status: 200 });",
  "}",
  "```",
].join("\n");

const WEBHOOKS_DOC = [
  "## Webhooks",
  "",
  "Cadastre a URL (HTTPS) e os eventos no painel; o segredo do endpoint (`whsec_…`) aparece uma vez só. Cada evento chega como `POST` com corpo JSON `{ id, type, created_at, data }`, em que `data` tem o mesmo formato da resposta da API (a cobrança vem sem `qr_code_base64`).",
  "",
  "Eventos: `charge.paid`, `charge.expired`, `payout.completed`, `payout.failed`, `med.opened` e `med.closed`.",
  "",
  "### Assinatura",
  "",
  "Header `X-Vantri-Signature: t=<unix>,v1=<hex>`:",
  "",
  "- `t`: momento do envio, em segundos Unix;",
  "- `v1`: HMAC-SHA256 em hexadecimal, com o segredo do endpoint, sobre `<t>.<corpo cru>` (o `t`, um ponto e o corpo exatamente como chegou).",
  "",
  "Recuse o evento se a assinatura não conferir ou se `t` estiver a mais de **300 segundos** do seu relógio. Calcule sobre o corpo cru: o JSON reformatado não confere.",
  "",
  "### Tentativas",
  "",
  "Responda com qualquer status 2xx em até 10 segundos. Outro status, redirecionamento ou tempo esgotado contam como falha. São até **7 tentativas**: a primeira logo após o evento e as seguintes 60 s, 5 min, 30 min, 2 h, 6 h e 24 h depois da falha anterior. Depois da 7ª falha a entrega fica como falha e pode ser reenviada pelo painel. A mesma entrega pode chegar mais de uma vez: use o `id` do evento para não processar duas vezes.",
  "",
  "### Exemplo de verificação em Node",
  "",
  NODE_EXAMPLE,
].join("\n");

const DESCRIPTION = [
  "API REST da Vantri para cobranças Pix, saldo, extrato, saques e casos de MED (Mecanismo Especial de Devolução).",
  "",
  "## Autenticação",
  "",
  "Crie a chave no painel e envie em toda requisição: `Authorization: Bearer vk_live_…`. A chave aparece uma vez só (guardamos apenas o hash). Cada chave tem escopos e, se você quiser, uma lista de IPs permitidos; com a lista preenchida, vale o IP de origem da requisição.",
  "",
  "| Escopo | Permite |",
  "| --- | --- |",
  ...SCOPES.map((s) => `| \`${s}\` | ${SCOPE_DOC[s]} |`),
  "",
  "## Convenções",
  "",
  "- Valores em centavos, sempre inteiros: `14990` = R$ 149,90.",
  "- Datas em ISO 8601, UTC.",
  "- Listas: mais novos primeiro, `limit` de 1 a 100 (padrão 20) e `cursor` com o `next_cursor` da página anterior.",
  "- Campo ou parâmetro desconhecido é recusado com 422.",
  "",
  "## Idempotência",
  "",
  "- **Cobrança:** `external_ref` é único na sua conta. Repetir com o mesmo valor devolve a mesma cobrança (200); com outro valor, 409.",
  "- **Saque:** o header `Idempotency-Key` é obrigatório (8 a 64 caracteres ASCII visíveis, sem espaços). Mesma chave e mesmo corpo devolvem o mesmo saque (200); mesma chave com outro corpo, 409.",
  "",
  "## Limite de requisições",
  "",
  "120 requisições por minuto por chave. Acima disso a resposta é 429, com o header `Retry-After` em segundos.",
  "",
  "## Erros",
  "",
  'Todo erro vem como `{ "error": { "code": "…", "message": "…" } }`, com a mensagem em português.',
  "",
  "| Código | HTTP | Quando |",
  "| --- | --- | --- |",
  "| `invalid_request` | 422 | corpo, parâmetro ou header inválido |",
  "| `unauthorized` | 401 | chave ausente, inválida ou revogada |",
  "| `forbidden` | 403 | chave sem o escopo ou IP fora da lista |",
  "| `merchant_inactive` | 403 | conta não está ativa |",
  "| `simulated_account` | 403 | conta do ambiente de demonstração (Pix simulado): não movimenta dinheiro de verdade |",
  "| `not_found` | 404 | recurso não existe ou é de outra conta |",
  "| `idempotency_conflict` | 409 | `external_ref` ou `Idempotency-Key` já usados com outro conteúdo |",
  "| `insufficient_balance` | 422 | saldo disponível não cobre o saque e a tarifa |",
  "| `rate_limited` | 429 | limite de requisições atingido |",
  "| `provider_error` | 502 | a instituição parceira não respondeu; tente de novo |",
  "| `internal_error` | 500 | erro nosso; tente de novo |",
  "",
  WEBHOOKS_DOC,
].join("\n");

const webhook = (type: string, summary: string, description: string, data: string) => ({
  post: {
    operationId: `webhook_${type.replace(".", "_")}`,
    tags: ["Webhooks"],
    summary,
    description: `${description}\n\nConfira o header \`X-Vantri-Signature\` antes de usar o corpo (veja **Webhooks** na introdução).`,
    security: [],
    parameters: [param("Signature")],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["id", "type", "created_at", "data"],
            properties: {
              id: { type: "string", description: "Id único do evento.", examples: ["evt_4hT9qLx2VbN7cR1mZs8KdWfE"] },
              type: { type: "string", const: type },
              created_at: dateTime("Quando o evento aconteceu."),
              data: schema(data),
            },
          },
        },
      },
    },
    responses: { "200": { description: "Recebido. Qualquer status 2xx confirma a entrega." } },
  },
});

export const openapi = {
  openapi: "3.1.0",
  info: { title: "API Vantri", version: "1.0.0", description: DESCRIPTION },
  servers: [{ url: `${SITE_URL}/api/v1`, description: "Produção" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Saldo" },
    { name: "Cobranças" },
    { name: "Saques" },
    { name: "Extrato" },
    { name: "MED", description: "Mecanismo Especial de Devolução do Pix." },
    { name: "Webhooks" },
  ],
  paths: {
    "/balance": {
      get: {
        operationId: "getBalance",
        tags: ["Saldo"],
        summary: "Consultar saldo",
        description: "Escopo `balance:read`.",
        responses: { "200": body("Saldo da conta.", schema("Balance")), ...auth },
      },
    },
    "/charges": {
      post: {
        operationId: "createCharge",
        tags: ["Cobranças"],
        summary: "Criar cobrança Pix",
        description:
          "Escopo `charges:write`. Gera o Pix copia e cola (`brcode`) e o QR Code. Idempotente por `external_ref`: repetir com o mesmo valor devolve a mesma cobrança com status 200.",
        requestBody: { required: true, content: { "application/json": { schema: schema("ChargeCreate") } } },
        responses: {
          "201": body("Cobrança criada.", schema("Charge")),
          "200": body("Já existia cobrança com este `external_ref` e o mesmo valor.", schema("Charge")),
          "409": response("Conflict"),
          "422": response("InvalidRequest"),
          "502": response("ProviderError"),
          ...auth,
        },
      },
      get: {
        operationId: "listCharges",
        tags: ["Cobranças"],
        summary: "Listar cobranças",
        description: "Escopo `charges:read`.",
        parameters: [param("Limit"), param("Cursor")],
        responses: { "200": body("Página de cobranças.", page("Charge")), "422": response("InvalidRequest"), ...auth },
      },
    },
    "/charges/{id}": {
      get: {
        operationId: "getCharge",
        tags: ["Cobranças"],
        summary: "Consultar cobrança",
        description: "Escopo `charges:read`.",
        parameters: [param("Id")],
        responses: { "200": body("A cobrança.", schema("Charge")), "404": response("NotFound"), ...auth },
      },
    },
    "/payouts": {
      post: {
        operationId: "createPayout",
        tags: ["Saques"],
        summary: "Pedir saque Pix",
        description:
          "Escopo `payouts:write`. Debita valor + tarifa do saldo disponível na hora. O saque pode voltar `processing` e terminar depois (evento `payout.completed` ou `payout.failed`); se falhar, valor e tarifa voltam ao saldo.",
        parameters: [param("IdempotencyKey")],
        requestBody: { required: true, content: { "application/json": { schema: schema("PayoutCreate") } } },
        responses: {
          "201": body("Saque criado.", schema("Payout")),
          "200": body("Mesma `Idempotency-Key` e mesmo corpo: devolve o saque já criado.", schema("Payout")),
          "409": response("Conflict"),
          "422": response("InvalidRequest"),
          ...auth,
        },
      },
      get: {
        operationId: "listPayouts",
        tags: ["Saques"],
        summary: "Listar saques",
        description: "Escopo `payouts:read`.",
        parameters: [param("Limit"), param("Cursor")],
        responses: { "200": body("Página de saques.", page("Payout")), "422": response("InvalidRequest"), ...auth },
      },
    },
    "/payouts/{id}": {
      get: {
        operationId: "getPayout",
        tags: ["Saques"],
        summary: "Consultar saque",
        description: "Escopo `payouts:read`.",
        parameters: [param("Id")],
        responses: { "200": body("O saque.", schema("Payout")), "404": response("NotFound"), ...auth },
      },
    },
    "/statement": {
      get: {
        operationId: "listStatement",
        tags: ["Extrato"],
        summary: "Extrato",
        description:
          "Escopo `statement:read`. Lançamentos do razão da conta, mais novos primeiro. Sem `from` e `to`, traz os últimos 30 dias. O período pode ter no máximo 366 dias.",
        parameters: [
          {
            name: "from",
            in: "query",
            description: "Primeiro dia (AAAA-MM-DD, horário de Brasília).",
            schema: { type: "string", format: "date" },
          },
          {
            name: "to",
            in: "query",
            description: "Último dia, inclusive (AAAA-MM-DD, horário de Brasília).",
            schema: { type: "string", format: "date" },
          },
          param("Limit"),
          param("Cursor"),
        ],
        responses: {
          "200": body("Página do extrato.", page("StatementEntry")),
          "422": response("InvalidRequest"),
          ...auth,
        },
      },
    },
    "/med": {
      get: {
        operationId: "listMedCases",
        tags: ["MED"],
        summary: "Listar casos de MED",
        description: "Escopo `med:read`.",
        parameters: [param("Limit"), param("Cursor")],
        responses: { "200": body("Página de casos.", page("MedCase")), "422": response("InvalidRequest"), ...auth },
      },
    },
    "/med/{id}": {
      get: {
        operationId: "getMedCase",
        tags: ["MED"],
        summary: "Consultar caso de MED",
        description: "Escopo `med:read`.",
        parameters: [param("Id")],
        responses: { "200": body("O caso.", schema("MedCase")), "404": response("NotFound"), ...auth },
      },
    },
  },
  webhooks: {
    "charge.paid": webhook(
      "charge.paid",
      "Cobrança paga",
      "A cobrança foi paga e o valor líquido entrou no saldo disponível. Pode chegar mesmo depois de `charge.expired`, se o pagamento cair após o vencimento: o dinheiro entrou.",
      "Charge",
    ),
    "charge.expired": webhook("charge.expired", "Cobrança vencida", "A cobrança venceu sem pagamento.", "Charge"),
    "payout.completed": webhook("payout.completed", "Saque concluído", "O saque chegou ao destino.", "Payout"),
    "payout.failed": webhook(
      "payout.failed",
      "Saque falhou",
      "O saque não foi concluído; valor e tarifa voltaram ao saldo disponível. `failure_code` traz o motivo.",
      "Payout",
    ),
    "med.opened": webhook(
      "med.opened",
      "MED aberto",
      "O pagador contestou uma cobrança paga pelo MED. O valor sai do disponível e fica bloqueado. Envie a defesa pelo painel até `defense_deadline`.",
      "MedCase",
    ),
    "med.closed": webhook(
      "med.closed",
      "MED encerrado",
      "Caso encerrado: `merchant_won` devolve o valor bloqueado ao disponível; `payer_refunded` devolve o valor ao pagador.",
      "MedCase",
    ),
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Chave de API `vk_live_…` criada no painel.",
      },
    },
    parameters: {
      Id: { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      Limit: {
        name: "limit",
        in: "query",
        description: "Itens por página.",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      Cursor: {
        name: "cursor",
        in: "query",
        description: "O `next_cursor` da página anterior.",
        schema: { type: "string", format: "uuid" },
      },
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description: "Chave única por saque, gerada por você (por exemplo, um UUID). Repetir a mesma chave não cria outro saque.",
        schema: { type: "string", minLength: 8, maxLength: 64, pattern: "^[\\x21-\\x7E]{8,64}$" },
      },
      Signature: {
        name: "X-Vantri-Signature",
        in: "header",
        required: true,
        description:
          "`t=<unix>,v1=<hex>`: HMAC-SHA256 com o segredo do endpoint sobre `<t>.<corpo cru>`. Recuse se `t` estiver a mais de 300 s do seu relógio.",
        schema: { type: "string", pattern: "^t=\\d+,v1=[0-9a-f]{64}$" },
        example: "t=1792159331,v1=c1eb8b186ce44f9ce22f8d4694a55e6429cf1b2012eb653e2a6bc2e37f7707bb",
      },
    },
    responses: {
      InvalidRequest: body("Requisição inválida (`invalid_request` ou `insufficient_balance`).", schema("Error")),
      Unauthorized: body("Chave ausente, inválida ou revogada (`unauthorized`).", schema("Error")),
      Forbidden: body(
        "Sem o escopo, IP fora da lista (`forbidden`), conta inativa (`merchant_inactive`) ou conta de demonstração (`simulated_account`).",
        schema("Error"),
      ),
      NotFound: body("Não existe ou é de outra conta (`not_found`).", schema("Error")),
      Conflict: body("Chave de idempotência já usada com outro conteúdo (`idempotency_conflict`).", schema("Error")),
      RateLimited: {
        ...body("Limite de 120 requisições por minuto por chave (`rate_limited`).", schema("Error")),
        headers: {
          "Retry-After": { description: "Segundos até poder tentar de novo.", schema: { type: "integer" } },
        },
      },
      ProviderError: body("A instituição parceira não respondeu (`provider_error`). Tente de novo.", schema("Error")),
      InternalError: body("Erro interno (`internal_error`). Tente de novo.", schema("Error")),
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                enum: [
                  "invalid_request",
                  "unauthorized",
                  "forbidden",
                  "merchant_inactive",
                  "simulated_account",
                  "not_found",
                  "idempotency_conflict",
                  "insufficient_balance",
                  "rate_limited",
                  "provider_error",
                  "internal_error",
                ],
              },
              message: { type: "string", description: "Mensagem em português, para gente ler." },
            },
          },
        },
      },
      Balance: {
        type: "object",
        required: ["available", "blocked", "total"],
        properties: {
          available: cents("Disponível para saque. Pode ficar negativo se um MED bloquear valor já sacado."),
          blocked: cents("Bloqueado por MED em aberto."),
          total: cents("available + blocked."),
        },
      },
      ChargeCreate: {
        type: "object",
        additionalProperties: false,
        required: ["external_ref", "amount"],
        properties: {
          external_ref: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "Sua referência (ex.: id do pedido). Única na conta: é a chave de idempotência.",
          },
          amount: {
            type: "integer",
            minimum: 100,
            maximum: 10000000,
            description: "Valor em centavos. Precisa ser maior que a tarifa.",
          },
          description: { type: "string", maxLength: 140, description: "Aparece para o pagador." },
          expires_in: {
            type: "integer",
            minimum: 300,
            maximum: 86400,
            default: 3600,
            description: "Segundos até vencer.",
          },
        },
        examples: [{ external_ref: "pedido_1042", amount: 19700, description: "Curso de Fotografia", expires_in: 3600 }],
      },
      Charge: {
        type: "object",
        required: [
          "id",
          "txid",
          "external_ref",
          "amount",
          "fee",
          "net",
          "description",
          "status",
          "brcode",
          "expires_at",
          "paid_at",
          "payer",
          "end_to_end_id",
          "created_at",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          txid: { type: "string", description: "Identificador da cobrança no Pix (25 caracteres)." },
          external_ref: { type: "string" },
          amount: cents("Valor cobrado, em centavos."),
          fee: cents("Tarifa da Vantri, em centavos."),
          net: cents("amount − fee: o que entra no saldo quando for paga."),
          description: nullable("string"),
          status: { type: "string", enum: ["pending", "paid", "expired"] },
          brcode: { type: "string", description: "Pix copia e cola." },
          qr_code_base64: {
            type: "string",
            contentEncoding: "base64",
            contentMediaType: "image/png",
            description: "QR Code em PNG. Vem nas respostas da API; não vem nos webhooks.",
          },
          expires_at: dateTime("Vencimento."),
          paid_at: nullable("string", { format: "date-time" }),
          payer: {
            type: ["object", "null"],
            description: "Quem pagou (depois do pagamento).",
            required: ["name", "document_masked"],
            properties: {
              name: nullable("string"),
              document_masked: nullable("string", { description: "CPF/CNPJ mascarado.", examples: ["***.456.789-**"] }),
            },
          },
          end_to_end_id: nullable("string", { description: "Identificador do Pix no Banco Central (depois do pagamento)." }),
          created_at: dateTime("Criação."),
        },
      },
      PayoutCreate: {
        type: "object",
        additionalProperties: false,
        required: ["amount", "pix_key", "pix_key_type"],
        properties: {
          amount: {
            type: "integer",
            minimum: 100,
            maximum: 5000000,
            description: "Valor em centavos. A tarifa é debitada à parte.",
          },
          pix_key: {
            type: "string",
            maxLength: 100,
            description: "Chave Pix de destino. Telefone no formato +55DDDNÚMERO.",
          },
          pix_key_type: { type: "string", enum: ["cpf", "cnpj", "email", "phone", "evp"] },
          description: { type: "string", maxLength: 140 },
        },
        examples: [{ amount: 10000, pix_key: "52998224725", pix_key_type: "cpf" }],
      },
      Payout: {
        type: "object",
        required: [
          "id",
          "amount",
          "fee",
          "pix_key",
          "pix_key_type",
          "description",
          "status",
          "failure_code",
          "end_to_end_id",
          "created_at",
          "completed_at",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          amount: cents("Valor enviado, em centavos."),
          fee: cents("Tarifa, em centavos."),
          pix_key: { type: "string", description: "Chave normalizada." },
          pix_key_type: { type: "string", enum: ["cpf", "cnpj", "email", "phone", "evp"] },
          description: nullable("string"),
          status: { type: "string", enum: ["processing", "completed", "failed"] },
          failure_code: nullable("string", { description: "Motivo, quando `failed`." }),
          end_to_end_id: nullable("string", { description: "Identificador do Pix no Banco Central, quando `completed`." }),
          created_at: dateTime("Criação."),
          completed_at: nullable("string", { format: "date-time" }),
        },
      },
      StatementEntry: {
        type: "object",
        required: ["id", "kind", "bucket", "amount", "ref_type", "ref_id", "created_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          kind: {
            type: "string",
            enum: [
              "cash_in",
              "fee_in",
              "cash_out",
              "fee_out",
              "cash_out_reversal",
              "med_hold",
              "med_release",
              "med_debit",
              "adjustment",
            ],
            description:
              "cash_in/fee_in: cobrança paga e tarifa; cash_out/fee_out: saque e tarifa; cash_out_reversal: estorno de saque que falhou; med_hold/med_release/med_debit: bloqueio, liberação e débito de MED; adjustment: ajuste manual.",
          },
          bucket: { type: "string", enum: ["available", "blocked"], description: "Saldo afetado." },
          amount: cents("Centavos, com sinal (negativo = saída)."),
          ref_type: { type: "string", enum: ["charge", "payout", "med_case", "manual"] },
          ref_id: { type: "string", format: "uuid", description: "Id da cobrança, do saque ou do caso de MED." },
          created_at: dateTime("Data do lançamento."),
        },
      },
      MedCase: {
        type: "object",
        required: ["id", "charge_id", "amount", "reason", "status", "defense_deadline", "created_at", "closed_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          charge_id: { type: "string", format: "uuid" },
          amount: cents("Valor contestado, em centavos."),
          reason: { type: "string" },
          status: {
            type: "string",
            enum: ["open", "defended", "merchant_won", "payer_refunded"],
            description: "open: aguardando defesa; defended: defesa enviada; merchant_won / payer_refunded: encerrado.",
          },
          defense_deadline: dateTime("Prazo para enviar a defesa."),
          created_at: dateTime("Abertura."),
          closed_at: nullable("string", { format: "date-time" }),
        },
      },
    },
  },
};
