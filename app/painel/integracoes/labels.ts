import type { Scope } from "@/lib/api/keys";
import type { WebhookEventType } from "@/lib/services/events";
import { EVENT_LABEL } from "../lib";

// Rótulos das telas de integrações. Só o servidor importa (os formulários recebem as opções prontas por props).

/** Escopos agrupados como na tela (a ordem dos grupos é a da tela). Todo escopo está em exatamente um grupo. */
export const SCOPE_GROUPS: ReadonlyArray<readonly [string, readonly Scope[]]> = [
  ["Cobranças", ["charges:read", "charges:write"]],
  ["Saques", ["payouts:read", "payouts:write"]],
  ["Saldo e extrato", ["balance:read", "statement:read"]],
  ["MED", ["med:read"]],
];

/** Evento de uma entrega: rótulo em PT. `webhook.test` (o "Testar envio") não está no catálogo assinável. */
export const eventLabel = (type: string) =>
  type === "webhook.test" ? "Teste" : (EVENT_LABEL[type as WebhookEventType] ?? type);

/** Nome do endpoint no painel: o que o lojista deu, senão o host da URL. */
export const endpointName = (e: { url: string; description: string | null }) => e.description || new URL(e.url).host;
