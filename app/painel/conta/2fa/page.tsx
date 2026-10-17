import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { TotpForm } from "@/app/components/totp-form";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { accessSession } from "@/app/conta/acesso";
import { pendingTotpSecret } from "@/lib/auth/session";
import { totpUri } from "@/lib/auth/totp";
import { painelSession } from "../../lib";
import { confirmTotpRotationAction } from "../actions";
import { TOTP_ROTATION_COOKIE } from "../rotation";

export const metadata: Metadata = { title: "Trocar app autenticador — Vantri" };

/** QR do segredo novo pendente (cookie desta sessão). Sem ele, ou vencido: volta para Minha conta. */
export default async function TrocarTotpPage() {
  const { user } = await painelSession();
  const { s } = await accessSession();
  const secret = pendingTotpSecret(user.id, s.session.id, (await cookies()).get(TOTP_ROTATION_COOKIE)?.value);
  if (!secret) redirect("/painel/conta?erro=2fa-expirado");
  const uri = totpUri(secret, user.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 440 });

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header>
        <p className="eyebrow">Conta</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Trocar app autenticador</h1>
        <p className="mt-2 text-sm text-muted">
          O app que você usa hoje continua valendo até você confirmar o novo aqui. Nada muda se você sair desta página.
        </p>
      </header>
      <Card>
        <ol className="space-y-4 text-sm leading-relaxed">
          <li>1. No app novo, adicione uma conta lendo este QR code:</li>
        </ol>
        <Image
          src={qr}
          alt="QR code para adicionar a Vantri no app autenticador novo"
          width={220}
          height={220}
          unoptimized
          className="mx-auto mt-4 rounded-2xl border border-line"
        />
        <a href={uri} className={buttonClass("ghost", "mt-4 w-full")}>
          Abrir no app autenticador
        </a>
        <p className="mt-4 text-sm text-muted">Não consegue ler o QR code? Digite esta chave no app:</p>
        <code className="mt-2 block break-words rounded-xl bg-bg px-3 py-2.5 text-center font-mono text-[15px] font-semibold tracking-wider text-ink">
          {secret.match(/.{1,4}/g)?.join(" ")}
        </code>
        <Alert tone="info" className="mt-4">
          Este QR code vale por 10 minutos. Depois de confirmar, apague do app antigo a entrada da Vantri: o código dele
          deixa de valer.
        </Alert>
        <p className="mt-6 text-sm">2. Digite o código de 6 dígitos que aparece no app novo.</p>
        <div className="mt-3">
          <TotpForm action={confirmTotpRotationAction} submitLabel="Confirmar app novo" />
        </div>
        <Link href="/painel/conta" className="mt-4 inline-block text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
          Cancelar e continuar com o app atual
        </Link>
      </Card>
    </div>
  );
}
