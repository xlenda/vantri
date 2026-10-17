"use server";

import { revalidatePath } from "next/cache";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { ApiKeyError, createApiKey, revokeApiKey, type Scope } from "@/lib/api/keys";
import { logError } from "@/lib/log";
import { createEndpoint, resendDelivery, WebhookError, type WebhookEventType } from "@/lib/services/events";
import { hasControlChars, painelSession } from "../lib";

// Segredo (chave de API, segredo do webhook) só volta aqui, no estado da ação: aparece uma vez e some ao recarregar.
export type KeyFormState =
  | { attempt: number; error: string; values: { name: string; scopes: string[]; ips: string } }
  | { attempt: number; key: string; name: string }
  | undefined;
export type WebhookFormState =
  | { attempt: number; error: string; values: { url: string; events: string[] } }
  | { attempt: number; secret: string; url: string }
  | undefined;

const texts = (fd: FormData, key: string) => fd.getAll(key).filter((v): v is string => typeof v === "string");

export async function createKeyAction(prev: KeyFormState, fd: FormData): Promise<KeyFormState> {
  const { merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const values = { name: formText(fd, "name"), scopes: texts(fd, "scopes"), ips: formText(fd, "ips") };
  const fail = (error: string) => ({ attempt, error, values });
  if (hasControlChars(values.name)) return fail("O nome tem caracteres inválidos.");

  try {
    const { key } = await createApiKey(merchant.id, {
      name: values.name,
      scopes: values.scopes as Scope[], // o serviço confere cada um contra SCOPES
      ipAllowlist: values.ips.split(/[\s,;]+/).filter(Boolean),
    });
    revalidatePath("/painel/integracoes");
    return { attempt, key, name: values.name.trim() };
  } catch (e) {
    if (e instanceof ApiKeyError) return fail(e.message);
    logError("painel: criar chave de API falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
}

export async function revokeKeyAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  try {
    await revokeApiKey(merchant.id, formText(fd, "id")); // de outro lojista → not_found
  } catch (e) {
    if (!(e instanceof ApiKeyError)) logError("painel: revogar chave de API falhou", e, { merchant: merchant.id });
  }
  revalidatePath("/painel/integracoes");
}

export async function createWebhookAction(prev: WebhookFormState, fd: FormData): Promise<WebhookFormState> {
  const { merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const values = { url: formText(fd, "url").trim(), events: texts(fd, "events") };
  const fail = (error: string) => ({ attempt, error, values });
  if (hasControlChars(values.url)) return fail("URL inválida.");

  try {
    const { secret } = await createEndpoint(merchant.id, {
      url: values.url,
      events: values.events as WebhookEventType[], // o serviço confere cada um contra WEBHOOK_EVENT_TYPES
    });
    revalidatePath("/painel/integracoes");
    return { attempt, secret, url: values.url };
  } catch (e) {
    if (e instanceof WebhookError) return fail(e.message);
    logError("painel: criar webhook falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
}

export async function resendDeliveryAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  try {
    await resendDelivery(merchant.id, formText(fd, "id")); // de outro lojista → not_found
  } catch (e) {
    if (!(e instanceof WebhookError)) logError("painel: reenviar webhook falhou", e, { merchant: merchant.id });
  }
  revalidatePath("/painel/integracoes");
}
