import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/app/components/ui/alert";
import { Card } from "@/app/components/ui/card";
import { StatusBadge } from "@/app/components/ui/status-badge";
import { Table } from "@/app/components/ui/table";
import { brl, dateTime as dataHora } from "@/lib/br/money";
import { getMedCase, listMedCases, listMedFiles, type MedCaseRow } from "@/lib/services/med";
import { painelSession, uuidOrUndefined, withQuery } from "../lib";
import { Pager } from "../pager";
import { DefenseForm } from "./defense-form";

export const metadata: Metadata = { title: "MED — Vantri" };

const DAY_MS = 86_400_000;

export default async function MedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { merchant } = await painelSession();
  const sp = await searchParams;
  const cursor = uuidOrUndefined(sp.cursor);
  const id = typeof sp.id === "string" ? sp.id : undefined;
  const [list, selected] = await Promise.all([
    listMedCases(merchant.id, { cursor, limit: 20 }),
    id ? getMedCase(merchant.id, id) : null, // de outro lojista → null
  ]);

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Disputas</p>
        <h1 className="mt-1 text-2xl sm:text-3xl">MED</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          O Mecanismo Especial de Devolução é aberto pelo banco do pagador quando ele contesta um Pix. O valor fica
          bloqueado no seu saldo até o caso ser encerrado. Envie sua defesa dentro do prazo.
        </p>
      </header>

      {id && !selected && <Alert>Caso de MED não encontrado.</Alert>}
      {selected && <CaseView c={selected} merchantId={merchant.id} sent={sp.enviada === "1"} />}

      <section aria-labelledby="casos" className="space-y-3">
        <h2 id="casos" className="text-lg">
          Casos
        </h2>
        <Table columns={["Aberto em", "Valor", "Motivo", "Prazo da defesa", "Status", ""]} empty="Nenhum caso de MED. Ótimo sinal." caption="Casos de MED">
          {list.data.map((c) => (
            <tr key={c.id} className={c.id === selected?.id ? "bg-brand/5" : undefined}>
              <td className="whitespace-nowrap text-muted">{dataHora(c.createdAt)}</td>
              <td className="whitespace-nowrap font-semibold tabular-nums">
                <span className="valor-sensivel">{brl(c.amountCents)}</span>
              </td>
              <td className="max-w-[16rem] truncate">{c.reason}</td>
              <td className="whitespace-nowrap">
                <Deadline c={c} />
              </td>
              <td>
                <StatusBadge kind="med" status={c.status} />
              </td>
              <td className="text-right">
                <Link href={withQuery("/painel/med", { cursor, id: c.id })} className="font-semibold text-brand hover:underline">
                  {c.status === "open" ? "Defender" : "Ver"}
                </Link>
              </td>
            </tr>
          ))}
        </Table>
        <Pager
          first={cursor ? "/painel/med" : undefined}
          next={list.nextCursor ? withQuery("/painel/med", { cursor: list.nextCursor }) : undefined}
        />
      </section>
    </div>
  );
}

function Deadline({ c }: { c: MedCaseRow }) {
  if (c.status !== "open") return <span className="text-muted">{dataHora(c.defenseDeadline)}</span>;
  const left = c.defenseDeadline.getTime() - Date.now();
  if (left <= 0) return <span className="font-semibold text-red-700">Encerrado em {dataHora(c.defenseDeadline)}</span>;
  const days = Math.ceil(left / DAY_MS);
  return (
    <span className={days <= 2 ? "font-semibold text-red-700" : undefined}>
      {dataHora(c.defenseDeadline)}
      <span className="block text-xs text-muted">{left < DAY_MS ? "falta menos de 1 dia" : `faltam ${days} dias`}</span>
    </span>
  );
}

async function CaseView({ c, merchantId, sent }: { c: MedCaseRow; merchantId: string; sent: boolean }) {
  const files = await listMedFiles(c.id, { role: "merchant", merchantId });
  const canDefend = c.status === "open" && c.defenseDeadline.getTime() > Date.now();
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Caso de MED</p>
          <h2 className="text-2xl tabular-nums">
            <span className="valor-sensivel">{brl(c.amountCents)}</span>
          </h2>
        </div>
        <StatusBadge kind="med" status={c.status} />
      </div>
      {sent && (
        <Alert tone="ok" className="mt-4">
          Defesa enviada. Agora o caso segue para análise; o resultado aparece aqui.
        </Alert>
      )}
      <dl className="mt-6 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted">Motivo</dt>
          <dd className="break-words font-medium">{c.reason}</dd>
        </div>
        <div>
          <dt className="text-muted">Prazo da defesa</dt>
          <dd className="font-medium">
            <Deadline c={c} />
          </dd>
        </div>
        <div>
          <dt className="text-muted">Cobrança</dt>
          <dd>
            <Link href={`/painel/cobrancas?id=${c.chargeId}`} className="font-medium text-brand hover:underline">
              Ver cobrança
            </Link>
          </dd>
        </div>
        {c.closedAt && (
          <div>
            <dt className="text-muted">Encerrado em</dt>
            <dd className="font-medium">{dataHora(c.closedAt)}</dd>
          </div>
        )}
      </dl>

      {c.defenseText && (
        <div className="mt-6">
          <h3 className="text-base">Defesa enviada</h3>
          <p className="mt-2 whitespace-pre-wrap break-words rounded-2xl bg-bg p-4 text-sm leading-relaxed">{c.defenseText}</p>
        </div>
      )}
      {files.length > 0 && (
        <div className="mt-4">
          <h3 className="text-base">Anexos</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {files.map((f) => (
              <li key={f.id}>
                <a href={`/painel/med/arquivo/${f.id}`} className="break-all font-medium text-brand hover:underline">
                  {f.filename}
                </a>{" "}
                <span className="text-muted">({Math.max(1, Math.round(f.sizeBytes / 1024))} KB)</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canDefend && (
        <div className="mt-8 border-t border-line pt-6">
          <h3 className="mb-4 text-base">Enviar defesa</h3>
          <DefenseForm caseId={c.id} />
        </div>
      )}
    </Card>
  );
}
