"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { createWebhookAction, rotateSecretAction, updateWebhookAction } from "../actions";
import { Checks, type Options, Secret } from "../forms";

type Endpoint = { id: string; url: string; description: string | null; events: string[] };

/** Criar (sem `endpoint`) ou editar. O segredo só volta na criação, uma vez; editar não mexe nele. */
export function WebhookForm({ events, endpoint }: { events: Options; endpoint?: Endpoint }) {
  const [state, action] = useActionState(endpoint ? updateWebhookAction : createWebhookAction, undefined);
  const v =
    state && "error" in state
      ? state.values
      : endpoint && { url: endpoint.url, events: endpoint.events, description: endpoint.description ?? "" };
  return (
    <div className="space-y-4">
      {state && "secret" in state && (
        <Secret title="Webhook criado" label="Segredo de assinatura" id="novo-segredo" value={state.secret} />
      )}
      <form key={state?.attempt} action={action} className="space-y-4">
        {state && "error" in state && <Alert>{state.error}</Alert>}
        {endpoint && <input type="hidden" name="id" value={endpoint.id} />}
        <Input
          label="Nome (opcional)"
          name="description"
          maxLength={60}
          placeholder="Ex.: Loja principal"
          hint="Só para você reconhecer o webhook no painel."
          defaultValue={v?.description}
        />
        <Input
          label="URL"
          name="url"
          type="url"
          inputMode="url"
          required
          maxLength={2048}
          placeholder="https://sualoja.com.br/webhooks/vantri"
          defaultValue={v?.url}
        />
        <Checks legend="Eventos" name="events" options={events} checked={v?.events} />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pendingText={endpoint ? "Salvando…" : "Criando…"}>{endpoint ? "Salvar alterações" : "Criar webhook"}</SubmitButton>
          {endpoint && (
            <Link href="/painel/integracoes?aba=webhooks" className={buttonClass("ghost")}>
              Cancelar
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}

/** "Novo segredo" com confirmação; o novo aparece uma vez, aqui, e some ao sair da tela. */
export function RotateSecretForm({ id }: { id: string }) {
  const [state, action] = useActionState(rotateSecretAction, undefined);
  if (state && "secret" in state) {
    return <Secret title="Novo segredo gerado" label="Segredo de assinatura" id="segredo-novo" value={state.secret} />;
  }
  return (
    <details>
      <summary className={buttonClass("ghost", "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>Gerar novo segredo</summary>
      <form action={action} className="mt-3 space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        {state && <Alert>{state.error}</Alert>}
        <p>
          O segredo atual deixa de valer na hora: as próximas entregas já saem assinadas com o novo. Copie o novo na tela
          seguinte e atualize o seu sistema.
        </p>
        <input type="hidden" name="id" value={id} />
        <SubmitButton pendingText="Gerando…">Gerar e mostrar o novo segredo</SubmitButton>
      </form>
    </details>
  );
}
