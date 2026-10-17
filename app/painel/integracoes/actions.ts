"use server";

import { isIP } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { formText, GENERIC_ERROR } from "@/app/conta/acesso";
import { ApiKeyError, createApiKey, ipEntryProblem, revokeApiKey, testIpAgainstAllowlist } from "@/lib/api/keys";
import { db } from "@/lib/db/client";
import { apiKeys } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { rateLimit } from "@/lib/ratelimit";
import {
  createEndpoint,
  deleteEndpoint,
  resendDelivery,
  rotateEndpointSecret,
  setEndpointActive,
  updateEndpoint,
  WebhookError,
} from "@/lib/services/webhooks-admin";
import { sendTestDelivery } from "@/lib/webhooks/attempts";
import { dispatchDue } from "@/lib/webhooks/dispatch";
import { firstIssue, formInput, idInput, keyInput, webhookInput } from "../input";
import { freshTotpProblem, hasControlChars, painelSession, withQuery } from "../lib";

// Segredo (chave de API, segredo do webhook) só volta aqui, no estado da ação: aparece uma vez e some ao recarregar.
export type KeyFormState =
  | { attempt: number; error: string; values: { name: string; scopes: string[]; ips: string } }
  | { attempt: number; key: string; name: string }
  | undefined;
export type WebhookFormState =
  | { attempt: number; error: string; values: { url: string; events: string[]; description: string } }
  | { attempt: number; secret: string; url: string }
  | undefined;
export type SecretState = { error: string } | { secret: string } | undefined;
export type AllowlistState =
  | { attempt: number; error: string; values: { ips: string } }
  | { attempt: number; ok: string }
  | undefined;
export type IpTestState = { tone: "ok" | "info" | "error"; message: string } | undefined;

const texts = (fd: FormData, key: string) => fd.getAll(key).filter((v): v is string => typeof v === "string");
const PAGE = "/painel/integracoes";
const WEBHOOKS = `${PAGE}?aba=webhooks`;
const ENTREGAS = `${PAGE}/entregas`;

const endpointInput = webhookInput.extend({
  description: z
    .string()
    .trim()
    .max(60, "O nome pode ter até 60 caracteres.")
    .refine((s) => !hasControlChars(s), "O nome tem caracteres inválidos."),
});
const endpointEditInput = endpointInput.extend({ id: z.uuid("Webhook não encontrado.") });
const toggleInput = idInput.extend({ active: z.enum(["0", "1"], "Item não encontrado.") });

const shown = (entry: string) => (entry.length > 45 ? `${entry.slice(0, 45)}…` : entry); // nada de linha sem fim no celular
const allowlistInput = z.strictObject({
  id: z.uuid("Chave não encontrada."),
  ips: z
    .string()
    .max(2000, "Lista longa demais: use até 20 IPs ou faixas.")
    .transform((s) => [...new Set(s.split(/[\s,;]+/).filter(Boolean).map((e) => e.toLowerCase()))])
    .superRefine((ips, ctx) => {
      const bad = ips.find((e) => ipEntryProblem(e));
      if (bad) ctx.addIssue({ code: "custom", message: `${shown(bad)}: ${ipEntryProblem(bad)}` });
      else if (ips.length > 20) ctx.addIssue({ code: "custom", message: "Use até 20 IPs ou faixas por chave." });
    }),
});
const ipTestInput = z.strictObject({
  id: z.uuid("Chave não encontrada."),
  ip: z
    .string()
    .trim()
    .min(1, "Informe um IP para testar.")
    .max(45, "IP inválido. Use IPv4 (ex.: 203.0.113.10) ou IPv6.")
    .refine((s) => !s.includes("/"), "Informe um IP (sem prefixo CIDR) para testar.")
    .refine((s) => isIP(s) !== 0, "IP inválido. Use IPv4 (ex.: 203.0.113.10) ou IPv6."),
});

/**
 * Nova chave de API. Ordem igual à do saque: formato dos campos (erro aqui não gasta o código) → código 2FA novo
 * (errado: para aqui, nada é criado) → createApiKey. Sem o código, quem só tem a sessão criaria uma chave
 * payouts:write e sacaria pela API sem 2FA.
 */
export async function createKeyAction(prev: KeyFormState, fd: FormData): Promise<KeyFormState> {
  const { user, merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const values = { name: formText(fd, "name"), scopes: texts(fd, "scopes"), ips: formText(fd, "ips") };
  const fail = (error: string) => ({ attempt, error, values });
  const input = formInput(keyInput, fd);
  if (!input.success) return fail(firstIssue(input.error));
  const totpProblem = await freshTotpProblem(user.id, fd);
  if (totpProblem) return fail(totpProblem);

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

/**
 * Troca a lista de IPs/faixas de uma chave ativa do lojista. lib/api/keys.ts não tem `updateKeyAllowlist`: o update
 * fica aqui, filtrado pelo lojista da sessão (chave de outro lojista ou revogada → "não encontrada", nada muda).
 * Sem 2FA: a lista só restringe quem já tem a chave, que nunca é exibida de novo.
 */
export async function updateAllowlistAction(prev: AllowlistState, fd: FormData): Promise<AllowlistState> {
  const { merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const fail = (error: string) => ({ attempt, error, values: { ips: formText(fd, "ips") } });
  const input = formInput(allowlistInput, fd);
  if (!input.success) return fail(firstIssue(input.error));
  const { id, ips } = input.data;
  try {
    const rows = await db()
      .update(apiKeys)
      .set({ ipAllowlist: ips })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.merchantId, merchant.id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (!rows.length) return fail("Chave não encontrada.");
  } catch (e) {
    logError("painel: salvar IPs da chave falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
  revalidatePath(PAGE);
  return {
    attempt,
    ok: ips.length
      ? "Lista salva. A API passa a aceitar esta chave só desses IPs e faixas."
      : "Lista salva vazia: a chave volta a aceitar chamadas de qualquer IP.",
  };
}

/** "Testar IP": confere o IP contra a lista SALVA da chave, sem mudar nada. Chave de outro lojista → não encontrada. */
export async function testIpAction(_prev: IpTestState, fd: FormData): Promise<IpTestState> {
  const { merchant } = await painelSession();
  const input = formInput(ipTestInput, fd);
  if (!input.success) return { tone: "error", message: firstIssue(input.error) };
  const { id, ip } = input.data;
  const [key] = await db()
    .select({ ips: apiKeys.ipAllowlist })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.merchantId, merchant.id), isNull(apiKeys.revokedAt)));
  if (!key) return { tone: "error", message: "Chave não encontrada." };
  if (!key.ips.length) return { tone: "info", message: `${ip} seria aceito: esta chave ainda não tem restrição de IP.` };
  const match = key.ips.find((entry) => testIpAgainstAllowlist([entry], ip));
  return match
    ? { tone: "ok", message: `${ip} seria aceito (casa com ${match}).` }
    : { tone: "error", message: `${ip} seria bloqueado: não casa com nenhum IP ou faixa desta chave.` };
}

export async function createWebhookAction(prev: WebhookFormState, fd: FormData): Promise<WebhookFormState> {
  const { merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const values = { url: formText(fd, "url").trim(), events: texts(fd, "events"), description: formText(fd, "description") };
  const fail = (error: string) => ({ attempt, error, values });
  const input = formInput(endpointInput, fd);
  if (!input.success) return fail(firstIssue(input.error));

  try {
    const { url, events, description } = input.data;
    const { id, secret } = await createEndpoint(merchant.id, { url, events });
    // O nome é à parte: se não gravar, o webhook já existe e o segredo (que só aparece agora) ainda tem de aparecer.
    if (description) {
      await updateEndpoint(merchant.id, id, { description }).catch((e) =>
        logError("painel: nome do webhook não gravado", e, { merchant: merchant.id }),
      );
    }
    revalidatePath(PAGE);
    return { attempt, secret, url };
  } catch (e) {
    if (e instanceof WebhookError) return fail(e.message);
    logError("painel: criar webhook falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
}

/** Edita nome/URL/eventos. O serviço re-valida a URL (SSRF) e só acha webhook do próprio lojista; o segredo não muda. */
export async function updateWebhookAction(prev: WebhookFormState, fd: FormData): Promise<WebhookFormState> {
  const { merchant } = await painelSession();
  const attempt = (prev?.attempt ?? 0) + 1;
  const values = { url: formText(fd, "url").trim(), events: texts(fd, "events"), description: formText(fd, "description") };
  const fail = (error: string) => ({ attempt, error, values });
  const input = formInput(endpointEditInput, fd);
  if (!input.success) return fail(firstIssue(input.error));

  try {
    const { id, url, events, description } = input.data;
    await updateEndpoint(merchant.id, id, { url, events, description: description || null });
  } catch (e) {
    if (e instanceof WebhookError) return fail(e.message);
    logError("painel: editar webhook falhou", e, { merchant: merchant.id });
    return fail(GENERIC_ERROR);
  }
  revalidatePath(PAGE);
  redirect(`${WEBHOOKS}&ok=atualizado`);
}

export async function toggleWebhookAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  const input = formInput(toggleInput, fd);
  const on = input.success && input.data.active === "1";
  let ok = input.success;
  if (input.success) {
    try {
      await setEndpointActive(merchant.id, input.data.id, on); // de outro lojista → not_found
    } catch (e) {
      if (!(e instanceof WebhookError)) logError("painel: ativar/desativar webhook falhou", e, { merchant: merchant.id });
      ok = false;
    }
  }
  revalidatePath(PAGE);
  redirect(`${WEBHOOKS}&${ok ? `ok=${on ? "ativado" : "desativado"}` : "erro=situacao"}`);
}

/**
 * "Testar": UM evento `webhook.test` para este webhook pelo mesmo `sendOne` do dispatcher (barra IP interno antes de
 * qualquer fetch). O resultado aparece no inspetor, filtrado por este webhook.
 */
export async function testWebhookAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  const input = formInput(idInput, fd);
  if (!input.success) redirect(`${WEBHOOKS}&erro=testar`);
  // Cada teste é um POST nosso para fora: teto por lojista para o botão não virar disparador.
  if (!(await rateLimit(`webhook-test:${merchant.id}`, 10, 60)).ok) redirect(`${WEBHOOKS}&erro=teste-limite`);
  let delivered: boolean | null = null;
  try {
    // Atenção à ordem: sendTestDelivery recebe o endpoint PRIMEIRO. De outro lojista → not_found, nada é enviado.
    ({ delivered } = await sendTestDelivery(input.data.id, merchant.id));
  } catch (e) {
    if (!(e instanceof WebhookError)) logError("painel: testar webhook falhou", e, { merchant: merchant.id });
  }
  if (delivered === null) redirect(`${WEBHOOKS}&erro=testar`);
  revalidatePath(PAGE);
  redirect(withQuery(ENTREGAS, { endpoint: input.data.id, teste: delivered ? "entregue" : "falhou" }));
}

/** Novo segredo: o antigo deixa de valer na hora; o novo volta só aqui, uma vez. De outro lojista → não encontrado. */
export async function rotateSecretAction(_prev: SecretState, fd: FormData): Promise<SecretState> {
  const { merchant } = await painelSession();
  const input = formInput(idInput, fd);
  if (!input.success) return { error: firstIssue(input.error) };
  try {
    return { secret: (await rotateEndpointSecret(merchant.id, input.data.id)).secret };
  } catch (e) {
    if (e instanceof WebhookError) return { error: e.message };
    logError("painel: novo segredo de webhook falhou", e, { merchant: merchant.id });
    return { error: GENERIC_ERROR };
  }
}

/** Remove o webhook e as entregas dele. De outro lojista → not_found (aviso de erro). */
export async function deleteWebhookAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  const input = formInput(idInput, fd);
  let ok = input.success;
  if (input.success) {
    try {
      await deleteEndpoint(merchant.id, input.data.id);
    } catch (e) {
      if (!(e instanceof WebhookError)) logError("painel: remover webhook falhou", e, { merchant: merchant.id });
      ok = false;
    }
  }
  revalidatePath(PAGE);
  redirect(`${WEBHOOKS}&${ok ? "ok=removido" : "erro=remover"}`);
}

/** Volta a entrega para a fila e manda já (after); o lojista volta para o inspetor dela. */
export async function resendDeliveryAction(fd: FormData): Promise<void> {
  const { merchant } = await painelSession();
  const input = formInput(idInput, fd);
  if (!input.success) redirect(`${ENTREGAS}?erro=reenviar`);
  let ok = true;
  try {
    await resendDelivery(merchant.id, input.data.id); // de outro lojista → not_found
  } catch (e) {
    if (!(e instanceof WebhookError)) logError("painel: reenviar webhook falhou", e, { merchant: merchant.id });
    ok = false;
  }
  if (!ok) redirect(`${ENTREGAS}?erro=reenviar`);
  after(() => dispatchDue()); // a entrega sai agora, não no próximo tick do cron
  revalidatePath(PAGE);
  redirect(`${ENTREGAS}/${input.data.id}?ok=reenviada`);
}
