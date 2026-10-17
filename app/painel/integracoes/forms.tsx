"use client";

import { useActionState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Field, Input, inputClass } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { CopyField } from "../copy-field";
import { createKeyAction } from "./actions";

export type Options = ReadonlyArray<readonly [string, string]>;

export function KeyForm({ scopeGroups }: { scopeGroups: ReadonlyArray<readonly [string, Options]> }) {
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
        <fieldset>
          <legend className="mb-1.5 text-sm font-semibold text-ink">Escopos</legend>
          <div className="space-y-3">
            {scopeGroups.map(([group, options]) => (
              <Checks key={group} legend={group} name="scopes" options={options} checked={v?.scopes} sub />
            ))}
          </div>
        </fieldset>
        <Field
          label="IPs permitidos (opcional)"
          htmlFor="ips"
          hint="Um por linha, até 20. Aceita faixa CIDR (IPv4 a partir de /24, IPv6 a partir de /64). Vazio: qualquer IP."
        >
          <textarea
            id="ips"
            name="ips"
            rows={2}
            aria-describedby="ips-dica"
            defaultValue={v?.ips}
            spellCheck={false}
            className={`${inputClass} h-auto py-2.5 font-mono`}
          />
        </Field>
        <Input
          label="Código do app autenticador"
          name="code"
          id="chave-codigo"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          hint="Obrigatório para criar chave: os 6 dígitos que aparecem agora no app."
          className="font-semibold tracking-[0.3em]"
        />
        <SubmitButton pendingText="Criando…">Criar chave</SubmitButton>
      </form>
    </div>
  );
}

/** Segredo recém-gerado: só existe no estado da ação, some ao recarregar. */
export function Secret({ title, label, id, value }: { title: string; label: string; id: string; value: string }) {
  return (
    <Alert tone="ok">
      <p className="font-semibold">{title}</p>
      <p className="mb-3">Copie e guarde agora: este valor não aparece de novo. Guarde no servidor, nunca no navegador.</p>
      <CopyField id={id} label={label} value={value} />
    </Alert>
  );
}

export function Checks({
  legend,
  name,
  options,
  checked,
  sub,
}: {
  legend: string;
  name: string;
  options: Options;
  checked?: string[];
  sub?: boolean;
}) {
  return (
    <fieldset>
      <legend className={sub ? "mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted" : "mb-1.5 text-sm font-semibold text-ink"}>
        {legend}
      </legend>
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
