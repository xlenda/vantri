"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Field, inputClass } from "@/app/components/ui/field";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { submitDefenseAction } from "./actions";

// Server Action aceita até 1 MB por envio (padrão do Next): o texto e os anexos vão juntos.
const MAX_TOTAL_BYTES = 900 * 1024;

export function DefenseForm({ caseId }: { caseId: string }) {
  const [state, action] = useActionState(submitDefenseAction, undefined);
  const [tooBig, setTooBig] = useState(false);
  const error = tooBig ? "Os anexos passam de 900 KB somados. Reduza ou comprima os arquivos." : state?.error;
  return (
    <form
      key={state?.attempt}
      action={action}
      onSubmit={(e) => {
        const files = (e.currentTarget.elements.namedItem("files") as HTMLInputElement).files;
        const big = Array.from(files ?? []).reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES;
        setTooBig(big);
        if (big) e.preventDefault(); // não envia: o Next recusaria o corpo inteiro com erro genérico
      }}
      className="space-y-4"
    >
      {error && <Alert>{error}</Alert>}
      <input type="hidden" name="caseId" value={caseId} />
      <Field label="Sua defesa" htmlFor="text" hint="Entre 20 e 5000 caracteres. Explique a venda e o que foi entregue.">
        <textarea
          id="text"
          name="text"
          required
          minLength={20}
          maxLength={5000}
          rows={6}
          aria-describedby="text-dica"
          defaultValue={state?.text}
          className={`${inputClass} h-auto py-2.5`}
        />
      </Field>
      <Field label="Anexos (opcional)" htmlFor="files" hint="PDF, PNG ou JPEG. Até 5 arquivos e 900 KB somados.">
        <input
          id="files"
          name="files"
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          aria-describedby="files-dica"
          className="block w-full text-sm text-muted file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
        />
      </Field>
      <SubmitButton pendingText="Enviando…">Enviar defesa</SubmitButton>
    </form>
  );
}
