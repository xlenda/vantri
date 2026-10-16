"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Turnstile } from "@/app/components/turnstile";
import { Alert } from "@/app/components/ui/alert";
import { Input, Select } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { SEGMENT_LABELS, SEGMENTS } from "@/lib/br/documents";
import { signupAction } from "./actions";

const DOC_TYPES = [
  ["cnpj", "Empresa (CNPJ)"],
  ["cpf", "Pessoa física (CPF)"],
] as const;

export function SignupForm() {
  const [state, action] = useActionState(signupAction, undefined);
  const v = state?.values;
  const [docType, setDocType] = useState(v?.documentType === "cpf" ? "cpf" : "cnpj");
  const cpf = docType === "cpf";

  return (
    <form key={state?.attempt} action={action} className="space-y-4">
      {state && <Alert>{state.error}</Alert>}

      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold text-ink">Você vende como</legend>
        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-bg p-1">
          {DOC_TYPES.map(([value, label]) => (
            <label
              key={value}
              className="cursor-pointer rounded-xl px-3 py-2.5 text-center text-sm font-semibold text-muted transition-colors has-checked:bg-white has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-brand"
            >
              <input
                type="radio"
                name="documentType"
                value={value}
                checked={docType === value}
                onChange={() => setDocType(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <Input
        label={cpf ? "Nome completo" : "Razão social"}
        name="legalName"
        autoComplete={cpf ? "name" : "organization"}
        required
        minLength={2}
        maxLength={200}
        defaultValue={v?.legalName}
      />
      <Input
        label="Nome da marca"
        name="tradeName"
        hint="Como seus clientes conhecem você ou o seu produto."
        required
        minLength={2}
        maxLength={200}
        defaultValue={v?.tradeName}
      />
      <Input
        key={docType}
        label={cpf ? "CPF" : "CNPJ"}
        name="document"
        inputMode={cpf ? "numeric" : "text"}
        placeholder={cpf ? "000.000.000-00" : "00.000.000/0000-00"}
        autoCapitalize="characters"
        required
        maxLength={cpf ? 14 : 18}
        defaultValue={v?.documentType === docType ? v.document : undefined}
      />
      <Select label="Segmento" name="segment" required defaultValue={v?.segment ?? ""}>
        <option value="" disabled>
          Selecione o que você vende
        </option>
        {SEGMENTS.map((s) => (
          <option key={s} value={s}>
            {SEGMENT_LABELS[s]}
          </option>
        ))}
      </Select>
      <Input
        label="E-mail"
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        hint="Vai ser o seu login."
        defaultValue={v?.email}
      />
      <Input
        label="Senha"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        maxLength={256}
        hint="Mínimo de 12 caracteres."
      />
      <Input
        label="Confirme a senha"
        name="passwordConfirm"
        type="password"
        autoComplete="new-password"
        required
        maxLength={256}
      />

      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-bg/60 p-4 text-sm leading-relaxed">
        <input
          type="checkbox"
          name="noBetting"
          value="sim"
          required
          defaultChecked={v?.noBetting}
          className="mt-0.5 size-5 shrink-0 accent-brand"
        />
        <span className="font-semibold">Declaro que não opero apostas nem jogos de azar</span>
      </label>

      <p className="text-xs leading-relaxed text-muted">
        Ao criar a conta, você concorda com os{" "}
        <Link href="/termos" target="_blank" className="font-semibold text-brand underline-offset-2 hover:underline">
          Termos de uso
        </Link>{" "}
        e a{" "}
        <Link href="/privacidade" target="_blank" className="font-semibold text-brand underline-offset-2 hover:underline">
          Política de privacidade
        </Link>
        .
      </p>

      <Turnstile resetKey={state} />
      <SubmitButton className="w-full" pendingText="Enviando…">
        Criar conta
      </SubmitButton>
    </form>
  );
}
