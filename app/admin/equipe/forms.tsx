"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { CopyButton } from "@/app/components/ui/copy-button";
import { Input } from "@/app/components/ui/field";
import { OpButton } from "../clientes/op-button";
import { userOpAction } from "./actions";

/** Código 2FA de quem opera: toda ação desta tela pede um novo. */
export function CodeInput({ id }: { id: string }) {
  return (
    <Input
      label="Seu código do app autenticador"
      name="code"
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      hint="Os 6 dígitos que aparecem agora no seu app. Cada operação pede um código novo."
      className="font-semibold tracking-[0.3em]"
    />
  );
}

/** "Fechar" remonta o formulário: o estado da ação (com a senha temporária) some da tela e da memória. */
export function UserOpsForm({ userId, email, merchant }: { userId: string; email: string; merchant: boolean }) {
  const [round, setRound] = useState(0);
  return <OpsOnce key={round} userId={userId} email={email} merchant={merchant} onClose={() => setRound((r) => r + 1)} />;
}

function OpsOnce({ userId, email, merchant, onClose }: { userId: string; email: string; merchant: boolean; onClose: () => void }) {
  const [state, action] = useActionState(userOpAction, undefined);

  if (state && "tempPassword" in state && state.tempPassword) {
    const { tempPassword } = state;
    return (
      <div className="space-y-4">
        <Alert tone="ok">{state.ok}</Alert>
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
        <p className="text-xs text-muted">
          A senha aparece só agora; o sistema guarda apenas o hash dela. Envie por um canal seguro.
        </p>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            text={`E-mail: ${email}\nSenha temporária: ${tempPassword}`}
            label="Copiar e-mail e senha"
            variant="primary"
          />
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {state && <Alert tone={"error" in state ? "error" : "ok"}>{"error" in state ? state.error : state.ok}</Alert>}
      <input type="hidden" name="userId" value={userId} />
      <Alert tone="info">
        Reset de 2FA e troca de senha: confirme a identidade fora do sistema antes, por um contato que vocês já tinham
        (nunca pelo mesmo canal em que o pedido chegou). Toda operação fica na auditoria com o seu nome.
      </Alert>
      <CodeInput id={`codigo-${userId}`} />
      <div className="flex flex-wrap gap-2">
        <OpButton op="reset2fa" variant="ghost">
          Resetar 2FA
        </OpButton>
        <OpButton op="senha" variant="ghost">
          Forçar troca de senha
        </OpButton>
        <OpButton op="sessoes" variant="ghost">
          Derrubar sessões
        </OpButton>
        <OpButton op="desbloquear" variant="ghost">
          Desbloquear
        </OpButton>
      </div>
      {merchant && (
        <div className="space-y-3 border-t border-line pt-4">
          <p className="text-xs text-muted">
            Perdeu a senha e o app ao mesmo tempo? Senha nova e 2FA zerado juntos entregariam a conta a quem opera: vira
            pedido de quatro olhos, e a senha temporária aparece só para quem aprovar.
          </p>
          <Input
            label="Motivo (para pedir recuperação)"
            name="reason"
            id={`motivo-${userId}`}
            maxLength={500}
            hint="Fica na auditoria: não escreva dados pessoais."
          />
          <OpButton op="recuperar" variant="ghost">
            Pedir recuperação de acesso
          </OpButton>
        </div>
      )}
    </form>
  );
}
