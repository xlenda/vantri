import { Marquee } from "./Marquee";

// Segmentos atendidos (sem logos de cliente). Apostas não existem como segmento.
const SEGMENTOS: [string, string][] = [
  ["Cursos", "M4 6h16v11H4zM10 9.5v4.5l4-2.25zM8 20h8"],
  ["Mentorias", "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 19a5.5 5.5 0 0 1 11 0M15 5h6v5h-3l-3 2z"],
  ["E-books", "M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"],
  ["Comunidades", "M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5.5 12a2.5 2.5 0 1 0 0-5M18.5 12a2.5 2.5 0 1 0 0-5M6 20a6 6 0 0 1 12 0M2 18a4 4 0 0 1 3-3.8M22 18a4 4 0 0 0-3-3.8"],
  ["SaaS", "M3 5h18v14H3zM3 9h18M9.5 13l-2 2 2 2M14.5 13l2 2-2 2"],
  ["Eventos online", "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M10 13l4 2.5-4 2.5z"],
];

export function Segmentos() {
  return (
    <section aria-labelledby="segmentos-titulo" className="pb-16 pt-4 sm:pb-20">
      <h2 id="segmentos-titulo" className="mb-6 text-center text-xs font-bold uppercase tracking-[0.14em] text-muted">
        Feito para quem vende produto digital
      </h2>
      <Marquee
        label="Segmentos atendidos"
        items={SEGMENTOS.map(([nome, d]) => (
          <span key={nome} className="inline-flex items-center gap-2.5 rounded-full border border-line bg-white px-5 py-2.5 text-sm font-semibold text-ink shadow-[0_8px_24px_-16px_rgb(59_55_242/0.35)]">
            <svg viewBox="0 0 24 24" aria-hidden className="size-5 text-brand" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d={d} />
            </svg>
            {nome}
          </span>
        ))}
      />
    </section>
  );
}
