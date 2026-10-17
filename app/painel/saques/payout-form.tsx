"use client";

import { useActionState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Input, Select } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { createPayoutAction } from "./actions";

export function PayoutForm({
  idempotencyKey,
  keyTypes,
  fee,
}: {
  idempotencyKey: string;
  keyTypes: ReadonlyArray<readonly [string, string]>;
  fee: string;
}) {
  const [state, action] = useActionState(createPayoutAction, undefined);
  const v = state?.values;
  return (
    <form key={state?.attempt} action={action} className="space-y-4">
      {state && <Alert>{state.error}</Alert>}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Input
        label="Valor (R$)"
        name="amount"
        inputMode="decimal"
        placeholder="0,00"
        autoComplete="off"
        required
        maxLength={20}
        hint={`Tarifa: ${fee} por saque, descontada do saldo.`}
        defaultValue={v?.amount}
      />
      <Select label="Tipo da chave Pix" name="pixKeyType" required defaultValue={v?.pixKeyType ?? ""}>
        <option value="" disabled>
          Selecione
        </option>
        {keyTypes.map(([t, label]) => (
          <option key={t} value={t}>
            {label}
          </option>
        ))}
      </Select>
      <Input
        label="Chave Pix de destino"
        name="pixKey"
        required
        maxLength={100}
        autoComplete="off"
        hint="Celular com DDD, ex.: (11) 98765-4321."
        defaultValue={v?.pixKey}
      />
      <Input label="Descrição (opcional)" name="description" maxLength={140} defaultValue={v?.description} />
      <Input
        label="Código do app autenticador"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        hint="Obrigatório em todo saque: os 6 dígitos que aparecem agora no app."
        className="font-semibold tracking-[0.3em]"
      />
      <SubmitButton className="w-full" pendingText="Enviando…">
        Sacar
      </SubmitButton>
    </form>
  );
}
