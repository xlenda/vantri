"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Button, buttonClass } from "@/app/components/ui/button";
import { CopyButton } from "@/app/components/ui/copy-button";
import { Input, Select } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { SEGMENT_LABELS, SEGMENTS } from "@/lib/br/documents";
import { createMerchantAction } from "./actions";

/** "Criar outro" remonta o formulário: o estado da ação (com a senha) some da tela e da memória. */
export function CreateMerchantForm() {
  const [round, setRound] = useState(0);
  return <CreateOnce key={round} onAgain={() => setRound((r) => r + 1)} />;
}

function CreateOnce({ onAgain }: { onAgain: () => void }) {
  const [state, action] = useActionState(createMerchantAction, undefined);
  const v = state && "values" in state ? state.values : undefined;
  const [docType, setDocType] = useState("cnpj");
  const cpf = docType === "cpf";

  if (state && "created" in state) {
    const { email, tempPassword, merchantId } = state.created;
    return (
      <div className="space-y-4">
        <Alert tone="ok">Cliente criado e já ativo. Envie ao cliente; ele troca no primeiro acesso.</Alert>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-semibold">E-mail</dt>
            <dd className="mt-1 break-all font-mono">{email}</dd>
          </div>
          <div>
            <dt className="font-semibold">Senha temporária</dt>
            <dd className="mt-1 break-all rounded-xl bg-bg px-3 py-2.5 font-mono text-[15px] font-semibold tracking-wider">
              {tempPassword}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted">A senha aparece só agora; o sistema guarda apenas o hash dela.</p>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            text={`E-mail: ${email}\nSenha temporária: ${tempPassword}`}
            label="Copiar e-mail e senha"
            variant="primary"
          />
          <Link href={`/admin/clientes/${merchantId}`} className={buttonClass("ghost")}>
            Ver cliente
          </Link>
          <Button variant="ghost" onClick={onAgain}>
            Criar outro
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form key={state?.attempt ?? 0} action={action} className="grid gap-4 sm:grid-cols-2">
      {state && <Alert className="sm:col-span-2">{state.error}</Alert>}
      <Select label="Tipo de documento" name="documentType" value={docType} onChange={(e) => setDocType(e.target.value)}>
        <option value="cnpj">Empresa (CNPJ)</option>
        <option value="cpf">Pessoa física (CPF)</option>
      </Select>
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
      <Input
        label={cpf ? "Nome completo" : "Razão social"}
        name="legalName"
        required
        minLength={2}
        maxLength={200}
        defaultValue={v?.legalName}
      />
      <Input label="Nome da marca" name="tradeName" required minLength={2} maxLength={200} defaultValue={v?.tradeName} />
      <Select label="Segmento" name="segment" required defaultValue={v?.segment ?? ""}>
        <option value="" disabled>
          Selecione
        </option>
        {SEGMENTS.map((s) => (
          <option key={s} value={s}>
            {SEGMENT_LABELS[s]}
          </option>
        ))}
      </Select>
      <Input
        label="E-mail de acesso"
        name="email"
        type="email"
        autoComplete="off"
        required
        maxLength={254}
        defaultValue={v?.email}
      />
      <p className="text-xs leading-relaxed text-muted sm:col-span-2">
        O CNPJ é consultado na Receita na hora, e CNAE de apostas é recusado. O cliente já nasce ativo, com as taxas
        padrão e uma senha temporária.
      </p>
      <div className="sm:col-span-2">
        <SubmitButton pendingText="Criando…">Criar cliente</SubmitButton>
      </div>
    </form>
  );
}
