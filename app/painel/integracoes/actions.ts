"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { ApiKeyError, createApiKey, revokeApiKey } from "@/lib/api/keys";
import { logError } from "@/lib/log";
import { createEndpoint, resendDelivery, WebhookError } from "@/lib/services/events";
import { firstIssue, formInput, idInput, keyInput, webhookInput } from "../input";
import { painelSession } from "../lib";

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
const PAGE = "/painel/integracoes";

export async function createKeyAction(prev: KeyFormState, fd: FormData): Promise<KeyFormState> {
  const { merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const values = { name: formText(fd, "name"), scopes: texts(fd, "scopes"), ips: formText(fd, "ips") };
  const fail = (error: string) => ({ attempt, error, values });
  const input = formInput(keyInput, fd);
  if (!input.success) return fail(firstIssue(input.error));

  try {
    const { name, scopes, ips } = input.data;
    const { key } = await createApiKey(merchant.id, { name, scopes, ipAllowlist: ips });
    revalidatePath(PAGE);
    return { attempt, key, name };
  } catch (e) {
    if (e instanceof ApiKeyError) return fail(e.message);
    logError("painel: criar chave de API falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
}

/** Resultado na URL (?ok= / ?erro=): a página mostra o aviso em português. */
export async function revokeKeyAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  const input = formInput(idInput, fd);
  let ok = input.success;
  if (input.success) {
    try {
      await revokeApiKey(merchant.id, input.data.id); // de outro lojista → not_found
    } catch (e) {
      if (!(e instanceof ApiKeyError)) logError("painel: revogar chave de API falhou", e, { merchant: merchant.id });
      ok = false;
    }
  }
  revalidatePath(PAGE);
  redirect(ok ? `${PAGE}?ok=revogada` : `${PAGE}?erro=revogar`);
}

export async function createWebhookAction(prev: WebhookFormState, fd: FormData): Promise<WebhookFormState> {
  const { merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const values = { url: formText(fd, "url").trim(), events: texts(fd, "events") };
  const fail = (error: string) => ({ attempt, error, values });
  const input = formInput(webhookInput, fd);
  if (!input.success) return fail(firstIssue(input.error));

  try {
    const { secret } = await createEndpoint(merchant.id, input.data);
    revalidatePath(PAGE);
    return { attempt, secret, url: input.data.url };
  } catch (e) {
    if (e instanceof WebhookError) return fail(e.message);
    logError("painel: criar webhook falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
}

export async function resendDeliveryAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  const input = formInput(idInput, fd);
  let ok = input.success;
  if (input.success) {
    try {
      await resendDelivery(merchant.id, input.data.id); // de outro lojista → not_found
    } catch (e) {
      if (!(e instanceof WebhookError)) logError("painel: reenviar webhook falhou", e, { merchant: merchant.id });
      ok = false;
    }
  }
  revalidatePath(PAGE);
  redirect(ok ? `${PAGE}?ok=reenviada` : `${PAGE}?erro=reenviar`);
}
