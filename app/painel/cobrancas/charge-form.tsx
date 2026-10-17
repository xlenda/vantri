"use client";

import { useActionState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Input, Select } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { createChargeAction } from "./actions";

export function ChargeForm({ expiry, fee }: { expiry: ReadonlyArray<readonly [number, string]>; fee: string }) {
  const [state, action] = useActionState(createChargeAction, undefined);
  const v = state?.values;
  return (
    <form key={state?.attempt} action={action} className="space-y-4">
      {state && <Alert>{state.error}</Alert>}
      <Input
        label="Valor (R$)"
        name="amount"
        inputMode="decimal"
        placeholder="0,00"
        autoComplete="off"
        required
        maxLength={20}
        hint={`Mínimo de R$ 1,00. Tarifa: ${fee} por Pix recebido.`}
        defaultValue={v?.amount}
      />
      <Input label="Descrição (opcional)" name="description" maxLength={140} placeholder="Ex.: Curso de fotografia" defaultValue={v?.description} />
      <Select label="Validade" name="expiresIn" defaultValue={v?.expiresIn ?? "3600"}>
        {expiry.map(([s, label]) => (
          <option key={s} value={s}>
            {label}
          </option>
        ))}
      </Select>
      <SubmitButton className="w-full" pendingText="Gerando…">
        Gerar cobrança Pix
      </SubmitButton>
    </form>
  );
}
