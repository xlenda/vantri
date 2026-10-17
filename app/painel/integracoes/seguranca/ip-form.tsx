"use client";

import { useActionState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Field, Input, inputClass } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { testIpAction, updateAllowlistAction } from "../actions";

/** Lista de IPs/faixas de uma chave. No erro, o texto digitado volta; no acerto, a lista salva (já normalizada). */
export function AllowlistForm({ id, entries }: { id: string; entries: string[] }) {
  const [state, action] = useActionState(updateAllowlistAction, undefined);
  const field = `ips-${id}`;
  return (
    <form key={state?.attempt} action={action} className="space-y-3">
      {state && <Alert tone={"error" in state ? "error" : "ok"}>{"error" in state ? state.error : state.ok}</Alert>}
      <input type="hidden" name="id" value={id} />
      <Field
        label="IPs e faixas permitidos"
        htmlFor={field}
        hint="Um por linha, até 20: IP (203.0.113.10) ou faixa CIDR (203.0.113.0/24). IPv4 a partir de /24, IPv6 a partir de /64. Vazio: qualquer IP."
      >
        <textarea
          id={field}
          name="ips"
          rows={4}
          aria-describedby={`${field}-dica`}
          defaultValue={state && "error" in state ? state.values.ips : entries.join("\n")}
          spellCheck={false}
          className={`${inputClass} h-auto py-2.5 font-mono`}
        />
      </Field>
      <SubmitButton pendingText="Salvando…">Salvar lista</SubmitButton>
    </form>
  );
}

/** "Testar IP" contra a lista salva da chave (sem efeito). */
export function IpTestForm({ id }: { id: string }) {
  const [state, action] = useActionState(testIpAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <Input
        label="Testar um IP"
        name="ip"
        id={`ip-${id}`}
        required
        maxLength={45}
        placeholder="203.0.113.10"
        autoComplete="off"
        spellCheck={false}
        hint="Confere se esse IP passaria pela lista salva desta chave. Não muda nada."
        className="font-mono"
      />
      {state && <Alert tone={state.tone}>{state.message}</Alert>}
      <SubmitButton variant="ghost" pendingText="Testando…">
        Testar IP
      </SubmitButton>
    </form>
  );
}
