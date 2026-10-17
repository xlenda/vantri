import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import { ActionForm } from "@/app/components/ui/action-form";
import { buttonClass } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input, Select } from "@/app/components/ui/field";
import { Pager } from "@/app/components/ui/pager";
import { Badge } from "@/app/components/ui/status-badge";
import { SubmitButton } from "@/app/components/ui/submit-button";
import { Table } from "@/app/components/ui/table";
import { withQuery } from "@/app/painel/lib";
import { requireAdmin } from "@/lib/auth/guards";
import { type AdminRole, pode } from "@/lib/auth/perms";
import { dateTime } from "@/lib/br/money";
import { listAdmins } from "@/lib/services/admin/roles";
import { listUsers, type UserRow } from "@/lib/services/admin/users-admin";
import { ROLE_LABEL } from "../perms-ui";
import { setRoleAction } from "./actions";
import { CodeInput, UserOpsForm } from "./forms";

export const metadata: Metadata = { title: "Equipe e papéis — Admin Vantri" };

const PATH = "/admin/equipe";
const ROLES = Object.keys(ROLE_LABEL) as AdminRole[];
const ROLE_HINT =
  "Administrador: tudo, inclusive gerir a equipe e aprovar quatro olhos. Operador: opera clientes e dinheiro, mas só pede aprovação e não gere a equipe. Suporte: leitura e operações de acesso de lojistas (2FA, senha, sessões).";

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pick = <T extends z.ZodType>(s: T, v: unknown): z.output<T> | undefined => {
  const r = s.safeParse(v);
  return r.success ? r.data : undefined;
};
const roleName = (r: AdminRole | null) => (r ? ROLE_LABEL[r] : "Sem papel");
const when = (d: Date | null) => (d ? dateTime(d) : "—");

/** Filtros da aba Usuários. Lista branca; valor inválido é ignorado. */
function userFilters(sp: Params) {
  return {
    q: pick(z.string().trim().min(1).max(100), first(sp.busca)),
    kind: pick(z.enum(["admin", "merchant"]), first(sp.tipo)),
    page: pick(z.coerce.number().int().min(1).max(10_000), first(sp.pagina)) ?? 1,
  };
}

export default async function EquipePage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const aba = first(sp.aba) === "usuarios" ? "usuarios" : "administradores";
  // Mudar papel é de quem gere a equipe (só admin); operar usuários, de todo papel com usuarios:operar.
  const { user } = await requireAdmin({ perm: aba === "administradores" ? "equipe:gerir" : "usuarios:operar" });
  const gere = pode(user.adminRole, "equipe:gerir");
  const selected = pick(z.uuid(), first(sp.usuario));

  let body: ReactNode;
  if (aba === "administradores") {
    body = <Admins admins={await listAdmins()} selected={selected} me={user.id} />;
  } else {
    const f = userFilters(sp);
    const { rows, hasNext } = await listUsers(f);
    body = <Users f={f} rows={rows} hasNext={hasNext} selected={selected} gere={gere} now={Date.now()} />;
  }

  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Equipe e papéis</h1>
      <nav aria-label="Abas" className="mt-6 flex flex-wrap gap-2">
        {gere && (
          <Tab href={PATH} current={aba === "administradores"}>
            Administradores
          </Tab>
        )}
        <Tab href={`${PATH}?aba=usuarios`} current={aba === "usuarios"}>
          Usuários
        </Tab>
      </nav>
      {body}
    </>
  );
}

type Admin = Awaited<ReturnType<typeof listAdmins>>[number];

function Admins({ admins, selected, me }: { admins: Admin[]; selected?: string; me: string }) {
  const sel = admins.find((a) => a.id === selected);
  return (
    <>
      {sel && (
        <Panel title={sel.email} close={PATH}>
          <ActionForm key={sel.id} action={setRoleAction} className="space-y-4">
            <input type="hidden" name="userId" value={sel.id} />
            <Select label="Papel" name="role" defaultValue={sel.adminRole ?? ""} required hint={ROLE_HINT}>
              <option value="" disabled>
                Selecione
              </option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted">
              Se o papel mudar, a pessoa sai de todas as sessões e entra de novo já com o papel novo
              {sel.id === me ? " (vale para você também)." : "."}
            </p>
            <CodeInput id="codigo-papel" />
            <SubmitButton pendingText="Salvando…">Salvar papel</SubmitButton>
          </ActionForm>
        </Panel>
      )}
      <div className="mt-6">
        <Table caption="Administradores" columns={["E-mail", "Papel", "2FA", "Último login"]} empty="Nenhum administrador.">
          {admins.map((a) => (
            <tr key={a.id}>
              <td>
                <Link href={withQuery(PATH, { usuario: a.id })} className="font-semibold text-brand hover:underline">
                  {a.email}
                </Link>
                {a.id === me && <span className="ml-1.5 text-xs text-muted">(você)</span>}
              </td>
              <td>{roleName(a.adminRole)}</td>
              <td>
                <TwoFa on={a.totpEnabled} />
              </td>
              <td className="whitespace-nowrap text-muted">{when(a.lastLoginAt)}</td>
            </tr>
          ))}
        </Table>
      </div>
    </>
  );
}

function Users({
  f,
  rows,
  hasNext,
  selected,
  gere,
  now,
}: {
  f: ReturnType<typeof userFilters>;
  rows: UserRow[];
  hasNext: boolean;
  selected?: string;
  gere: boolean;
  now: number;
}) {
  const sel = rows.find((r) => r.id === selected);
  const href = (page: number, usuario?: string) =>
    withQuery(PATH, { aba: "usuarios", busca: f.q, tipo: f.kind, pagina: page > 1 ? String(page) : undefined, usuario });
  return (
    <>
      <form className="mt-6 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <input type="hidden" name="aba" value="usuarios" />
        <Input
          label="Buscar"
          name="busca"
          type="search"
          defaultValue={f.q}
          placeholder="E-mail ou nome do lojista"
          maxLength={100}
        />
        <Select label="Tipo" name="tipo" defaultValue={f.kind ?? ""}>
          <option value="">Todos</option>
          <option value="admin">Equipe</option>
          <option value="merchant">Lojistas</option>
        </Select>
        <button type="submit" className={buttonClass("ghost")}>
          Filtrar
        </button>
      </form>

      {sel && (
        <Panel title={sel.email} close={href(f.page)}>
          {sel.role === "admin" && !gere ? (
            <p className="text-sm text-muted">
              Conta da equipe: reset de 2FA, troca de senha e sessões de quem é da equipe só um administrador faz.
            </p>
          ) : (
            <UserOpsForm key={sel.id} userId={sel.id} email={sel.email} />
          )}
        </Panel>
      )}

      <div className="mt-6">
        <Table
          caption="Usuários"
          columns={["E-mail", "Papel", "Lojista", "2FA", "Último login", "Bloqueado até", "Troca de senha"]}
          empty="Nenhum usuário com este filtro."
        >
          {rows.map((u) => (
            <tr key={u.id}>
              <td>
                <Link href={href(f.page, u.id)} className="font-semibold text-brand hover:underline">
                  {u.email}
                </Link>
              </td>
              <td>{u.role === "admin" ? roleName(u.adminRole) : "Lojista"}</td>
              <td>
                {u.merchantId && u.tradeName ? (
                  <Link href={`/admin/clientes/${u.merchantId}`} className="hover:underline">
                    {u.tradeName}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <TwoFa on={u.totpEnabled} />
              </td>
              <td className="whitespace-nowrap text-muted">{when(u.lastLoginAt)}</td>
              <td className="whitespace-nowrap">
                {u.lockedUntil && u.lockedUntil.getTime() > now ? <Badge tone="bad">{dateTime(u.lockedUntil)}</Badge> : "—"}
              </td>
              <td>{u.mustChangePassword ? <Badge tone="warn">pendente</Badge> : "—"}</td>
            </tr>
          ))}
        </Table>
        <Pager page={f.page} hasNext={hasNext} href={(p) => href(p)} />
      </div>
    </>
  );
}

function Panel({ title, close, children }: { title: string; close: string; children: ReactNode }) {
  return (
    <Card className="mt-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 break-all text-lg">{title}</h2>
        <Link href={close} className="text-sm font-semibold text-muted hover:text-ink">
          Fechar
        </Link>
      </div>
      {children}
    </Card>
  );
}

function Tab({ href, current, children }: { href: string; current: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className="rounded-full border border-line bg-white px-3.5 py-1.5 text-sm font-semibold text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
    >
      {children}
    </Link>
  );
}

const TwoFa = ({ on }: { on: boolean }) => <Badge tone={on ? "ok" : "warn"}>{on ? "Ativo" : "Desligado"}</Badge>;
