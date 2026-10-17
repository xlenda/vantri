import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { RC16 } from "@/app/(site)/site";
import { ActionForm } from "@/app/components/ui/action-form";
import { Alert } from "@/app/components/ui/alert";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/field";
import { Badge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { accessSession } from "@/app/conta/acesso";
import { maskDocument, SEGMENT_LABELS, type Segment } from "@/lib/br/documents";
import { dateTime } from "@/lib/br/money";
import { decrypt } from "@/lib/crypto";
import { logError } from "@/lib/log";
import { listSessions } from "@/lib/services/sessions";
import { painelSession } from "../lib";
import { reconfigureTotpAction, revokeOthersAction, revokeSessionAction } from "./actions";

export const metadata: Metadata = { title: "Minha conta — Vantri" };

const NOTICE: Record<string, ["ok" | "error", string]> = {
  encerrada: ["ok", "Sessão encerrada. Aquele acesso vai precisar entrar de novo."],
  outras: ["ok", "Outras sessões encerradas. Só esta continua aberta."],
  encerrar: ["error", "Não foi possível encerrar a sessão. Recarregue a página e tente de novo."],
};

const SMALL_BUTTON = "!h-9 !px-3.5 text-xs";

export default async function ContaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, merchant: m } = await painelSession();
  const { token } = await accessSession();
  const sp = await searchParams;
  const key = String(sp.erro ?? sp.ok ?? "");
  const notice = Object.hasOwn(NOTICE, key) ? NOTICE[key] : undefined; // ?ok=toString não vira aviso
  const sessoes = await listSessions(user.id, token); // só o id opaco (sha256): o token nunca sai daqui
  const temOutras = sessoes.some((s) => !s.current);

  let documento: string;
  try {
    documento = maskDocument(decrypt(m.documentEnc));
  } catch (e) {
    logError("painel: documento do lojista ilegível", e, { merchant: m.id });
    documento = "não foi possível ler";
  }

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">Conta</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">Minha conta</h1>
        <p className="mt-2 text-sm text-muted">Dados da empresa, quem opera o seu Pix, segurança do acesso e sessões abertas.</p>
      </header>

      {notice && <Alert tone={notice[0]}>{notice[1]}</Alert>}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-lg">Dados da conta</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Row label={m.documentType === "cpf" ? "Nome completo" : "Razão social"}>{m.legalName}</Row>
            <Row label="Nome da marca">{m.tradeName}</Row>
            <Row label={m.documentType.toUpperCase()}>
              <span className="font-mono">{documento}</span>
            </Row>
            <Row label="Segmento">{SEGMENT_LABELS[m.segment as Segment] ?? m.segment}</Row>
            <Row label="E-mail de acesso">{user.email}</Row>
          </dl>
        </Card>

        <Card>
          <h2 className="text-lg">Parceiro de liquidação</h2>
          <p className="mt-4 text-sm leading-relaxed">{RC16}</p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Row label="Agência e conta">
              <Badge tone="warn">requer parceiro de Pix</Badge>
            </Row>
          </dl>
        </Card>
      </div>

      <section aria-labelledby="seguranca" className="space-y-4">
        <h2 id="seguranca" className="text-lg">
          Segurança
        </h2>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="text-base">Senha</h3>
            <p className="mt-2 text-sm text-muted">Ao trocar, as outras sessões abertas da sua conta são encerradas.</p>
            <Link href="/conta/senha" className={buttonClass("ghost", "mt-4")}>
              Trocar senha
            </Link>
          </Card>

          <Card>
            <h3 className="text-base">Verificação em duas etapas</h3>
            <p className="mt-2 text-sm text-muted">
              Trocou de celular ou de app autenticador? Confirme a senha e o código de agora para ler um QR code novo. As
              outras sessões abertas são encerradas.
            </p>
            <ActionForm action={reconfigureTotpAction} className="mt-4 space-y-4">
              <Input label="Senha atual" name="password" id="conta-senha" type="password" autoComplete="current-password" required maxLength={256} />
              <Input
                label="Código do app autenticador"
                name="code"
                id="conta-codigo"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                hint="Os 6 dígitos que aparecem agora no app que você usa hoje."
                className="font-semibold tracking-[0.3em]"
              />
              <SubmitButton variant="ghost" pendingText="Conferindo…">
                Reconfigurar 2FA
              </SubmitButton>
            </ActionForm>
            <p className="mt-4 text-xs text-muted">
              Perdeu o acesso ao app autenticador? Fale com o suporte para reiniciar a verificação em duas etapas.
            </p>
          </Card>
        </div>
      </section>

      <section aria-labelledby="sessoes" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="sessoes" className="text-lg">
            Sessões abertas
          </h2>
          {temOutras && (
            <form action={revokeOthersAction}>
              <SubmitButton variant="ghost" className={SMALL_BUTTON} pendingText="Encerrando…">
                Encerrar as outras
              </SubmitButton>
            </form>
          )}
        </div>
        <Table columns={["Aberta em", "Expira em", "Situação", ""]} caption="Sessões abertas">
          {sessoes.map((s) => (
            <tr key={s.id}>
              <td className="whitespace-nowrap">{dateTime(s.createdAt)}</td>
              <td className="whitespace-nowrap text-muted">{dateTime(s.expiresAt)}</td>
              <td>
                {s.current ? (
                  <Badge tone="ok">Esta sessão</Badge>
                ) : s.mfaPassed ? (
                  <Badge>Aberta</Badge>
                ) : (
                  <Badge tone="warn">Não passou do 2FA</Badge>
                )}
              </td>
              <td className="text-right">
                {!s.current && (
                  <form action={revokeSessionAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <SubmitButton variant="ghost" className={SMALL_BUTTON} pendingText="Encerrando…">
                      Encerrar
                    </SubmitButton>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {sessoes.some((s) => !s.mfaPassed) && (
          <p className="text-xs text-muted">
            “Não passou do 2FA”: alguém entrou com a sua senha e parou no código do app. Se não foi você, encerre essa
            sessão e troque a senha.
          </p>
        )}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
