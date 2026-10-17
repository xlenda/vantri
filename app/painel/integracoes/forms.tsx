"use client";

import { useActionState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Field, Input, inputClass } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { CopyField } from "../copy-field";
import { createKeyAction, createWebhookAction } from "./actions";

type Options = ReadonlyArray<readonly [string, string]>;

export function KeyForm({ scopes }: { scopes: Options }) {
  const [state, action] = useActionState(createKeyAction, undefined);
  const v = state && "error" in state ? state.values : undefined;
  return (
    <div className="space-y-4">
      {state && "key" in state && (
        <Secret title={`Chave “${state.name}” criada`} label="Chave de API" id="nova-chave" value={state.key} />
      )}
      <form key={state?.attempt} action={action} className="space-y-4">
        {state && "error" in state && <Alert>{state.error}</Alert>}
        <Input label="Nome" name="name" required maxLength={60} placeholder="Ex.: Loja principal" defaultValue={v?.name} />
        <Checks legend="Escopos" name="scopes" options={scopes} checked={v?.scopes} />
        <Field label="IPs permitidos (opcional)" htmlFor="ips" hint="Um por linha, até 20. Vazio: qualquer IP.">
          <textarea
            id="ips"
            name="ips"
            rows={2}
            aria-describedby="ips-dica"
            defaultValue={v?.ips}
            className={`${inputClass} h-auto py-2.5 font-mono`}
          />
        </Field>
        <SubmitButton pendingText="Criando…">Criar chave</SubmitButton>
      </form>
    </div>
  );
}

export function WebhookForm({ events }: { events: Options }) {
  const [state, action] = useActionState(createWebhookAction, undefined);
  const v = state && "error" in state ? state.values : undefined;
  return (
    <div className="space-y-4">
      {state && "secret" in state && (
        <Secret title="Webhook criado" label="Segredo de assinatura" id="novo-segredo" value={state.secret} />
      )}
      <form key={state?.attempt} action={action} className="space-y-4">
        {state && "error" in state && <Alert>{state.error}</Alert>}
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
        <SubmitButton pendingText="Criando…">Criar webhook</SubmitButton>
      </form>
    </div>
  );
}

function Secret({ title, label, id, value }: { title: string; label: string; id: string; value: string }) {
  return (
    <Alert tone="ok">
      <p className="font-semibold">{title}</p>
      <p className="mb-3">Copie e guarde agora: ela não aparece de novo. Se perder, crie outra.</p>
      <CopyField id={id} label={label} value={value} />
    </Alert>
  );
}

function Checks({ legend, name, options, checked }: { legend: string; name: string; options: Options; checked?: string[] }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-semibold text-ink">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-white px-3 py-2.5 text-sm has-checked:border-brand has-checked:bg-brand/5">
            <input type="checkbox" name={name} value={value} defaultChecked={checked?.includes(value)} className="size-4 accent-brand" />
            <span>
              {label} <code className="block text-xs text-muted">{value}</code>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
