import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { AuthShell } from "@/app/components/auth-shell";
import { TotpForm } from "@/app/components/totp-form";
import { logoutAction } from "@/app/entrar/actions";
import { beginTotpSetup } from "@/lib/auth/session";
import { accessSession, homeFor } from "../acesso";
import { confirmTotpAction } from "../actions";

export const metadata: Metadata = { title: "Ativar verificação em duas etapas — Vantri" };

export default async function Conta2faPage() {
  const { s } = await accessSession();
  if (s.user.totpEnabled) redirect(s.session.mfaPassed ? homeFor(s.user.role) : "/entrar/2fa");

  // Segredo novo a cada visita enquanto o 2FA não está ativo; só vale depois de confirmado com um código.
  const { secret, uri } = await beginTotpSetup(s.user.id);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 440 });

  return (
    <AuthShell
      title="Ative a verificação em duas etapas"
      subtitle="Obrigatória para usar o painel: além da senha, cada acesso pede um código do seu celular."
    >
      <ol className="space-y-6 text-sm leading-relaxed">
        <li>
          <p>
            <Step n={1} />
            Instale um app autenticador, como Google Authenticator, Microsoft Authenticator ou 1Password.
          </p>
        </li>
        <li>
          <p>
            <Step n={2} />
            No app, adicione uma conta lendo este QR code:
          </p>
          <Image
            src={qr}
            alt="QR code para adicionar a Vantri no app autenticador"
            width={220}
            height={220}
            unoptimized
            className="mx-auto mt-4 rounded-2xl border border-line"
          />
          <p className="mt-4 text-muted">Não consegue ler o QR code? Digite esta chave no app:</p>
          <code className="mt-2 block break-words rounded-xl bg-bg px-3 py-2.5 text-center font-mono text-[15px] font-semibold tracking-wider text-ink">
            {secret.match(/.{1,4}/g)?.join(" ")}
          </code>
        </li>
        <li>
          <p>
            <Step n={3} />
            Digite o código de 6 dígitos que aparece no app.
          </p>
        </li>
      </ol>
      <div className="mt-5">
        <TotpForm action={confirmTotpAction} submitLabel="Ativar e continuar" />
      </div>
      <form action={logoutAction} className="mt-5 text-center">
        <button type="submit" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
          Sair
        </button>
      </form>
    </AuthShell>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="mr-2 inline-grid size-6 place-items-center rounded-full bg-accent align-[1px] text-xs font-bold text-ink"
    >
      {n}
    </span>
  );
}
