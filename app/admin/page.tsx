import Link from "next/link";
import { requireUser } from "@/lib/auth/guards";
import { brl } from "@/lib/br/money";
import { todayDate } from "./format";
import { adminOverview } from "./queries";

export default async function AdminHome() {
  await requireUser({ role: "admin" });
  const now = Date.now();
  const o = await adminOverview(now);
  const today = todayDate(now);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const cards = [
    {
      href: "/admin/clientes?status=pending",
      label: "Cadastros pendentes",
      value: String(o.pendingMerchants),
      note: "aguardando aprovação",
    },
    {
      href: `/admin/transacoes?tipo=cobrancas&status=paid&de=${today}&ate=${today}`,
      label: "Recebido hoje",
      value: brl(o.paidToday.cents),
      note: plural(o.paidToday.count, "cobrança paga", "cobranças pagas"),
    },
    {
      href: "/admin/transacoes?tipo=saques&status=processing",
      label: "Saques em processamento",
      value: String(o.processingPayouts.count),
      note: `${brl(o.processingPayouts.cents)} no total`,
    },
    {
      href: "/admin/med",
      label: "MEDs em aberto",
      value: String(o.openMeds),
      note: "abertos ou com defesa enviada",
    },
  ];
  return (
    <>
      <h1 className="text-2xl sm:text-3xl">Início</h1>
      <p className="mt-1 text-sm text-muted">Hoje = desde 00:00 no horário de Brasília.</p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <li key={c.label}>
            <Link
              href={c.href}
              className="block h-full rounded-3xl border border-line bg-white p-5 transition-colors hover:border-ink"
            >
              <span className="text-sm font-semibold text-muted">{c.label}</span>
              <span className="mt-2 block text-3xl font-bold tracking-tight tabular-nums">{c.value}</span>
              <span className="mt-1 block text-sm text-muted">{c.note}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
