import { brl } from "@/lib/br/money";

// Gráficos do admin: SVG puro renderizado no servidor (sem biblioteca), no jeito dos SVGs da vitrine e das barras do
// painel (role="img" + aria-label, cores pelos tokens). O desenho estica na largura (viewBox + preserveAspectRatio
// "none"), então encolhe até 390 px sem estourar; por isso os rótulos ficam em HTML, fora do SVG, e as linhas não
// engrossam ao esticar (non-scaling-stroke).

/** "2026-10-17" → "17/10". */
const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

type NumKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];
export type BarSeries<T> = { key: NumKey<T>; label: string; color: string };

const SLOT = 40; // largura de um dia no viewBox
const H = 120; // altura do desenho no viewBox
const MAX_LABELS = 7; // datas no eixo; o resto fica no tooltip e na lista do leitor de tela

/** Barras agrupadas por dia, uma por série, todas na mesma escala a partir do zero. */
export function BarChart<T extends { day: string }>({
  data,
  series,
  label,
}: {
  data: T[];
  series: BarSeries<T>[];
  label: string;
}) {
  if (data.length === 0) return null;
  const val = (d: T, s: BarSeries<T>) => Number(d[s.key]);
  const peak = Math.max(0, ...data.flatMap((d) => series.map((s) => val(d, s))));
  const group = SLOT * 0.6; // as barras do dia ocupam 60% do espaço; o resto é respiro entre os dias
  const bar = group / series.length;
  const every = Math.ceil(data.length / MAX_LABELS);
  const describe = (d: T) => `${ddmm(d.day)}: ${series.map((s) => `${s.label} ${brl(val(d, s))}`).join(", ")}`;
  const totals = series.map((s) => `${s.label} ${brl(data.reduce((a, d) => a + val(d, s), 0))}`).join(", ");
  return (
    <figure className="mt-4">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-muted">
        {series.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <p aria-hidden className="mt-3 h-4 text-[11px] text-muted">
        {peak > 0 ? `topo: ${brl(peak)} no dia` : "sem movimento no período"}
      </p>
      <svg
        viewBox={`0 0 ${data.length * SLOT} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}. Total no período: ${totals}.`}
        className="mt-1 h-40 w-full overflow-visible"
      >
        <line x1={0} x2={data.length * SLOT} y1={H} y2={H} stroke="var(--color-line)" vectorEffect="non-scaling-stroke" />
        {data.map((d, i) => (
          <g key={d.day}>
            <title>{describe(d)}</title>
            {/* Área de toque do dia inteiro (maior que a barra): o tooltip aparece em qualquer ponto da coluna. */}
            <rect x={i * SLOT} y={0} width={SLOT} height={H} fill="transparent" />
            {series.map((s, j) => {
              const h = peak > 0 ? Math.max((val(d, s) / peak) * H, 1.5) : 0;
              return val(d, s) > 0 ? (
                <rect
                  key={s.label}
                  x={i * SLOT + (SLOT - group) / 2 + j * bar}
                  y={H - h}
                  width={bar - 1}
                  height={h}
                  fill={s.color}
                />
              ) : null;
            })}
          </g>
        ))}
      </svg>
      {/* Datas em HTML para não esticarem com o desenho; flex centraliza mesmo quando o texto é mais largo que o dia. */}
      <div
        aria-hidden
        className="mt-2 grid text-[11px] text-muted"
        style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}
      >
        {data.map((d, i) => (
          <span key={d.day} className="flex justify-center whitespace-nowrap">
            {i % every === 0 ? ddmm(d.day) : ""}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        <ul>
          {data.map((d) => (
            <li key={d.day}>{describe(d)}</li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/** Linha de uma série só, sem eixos, para dentro de um cartão. Precisa de 2 pontos ou mais. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const W = 100;
  const SH = 30;
  const peak = Math.max(1, ...values);
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * W).toFixed(2)},${(SH - 1 - (v / peak) * (SH - 2)).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${SH}`} preserveAspectRatio="none" role="img" aria-label={label} className="mt-3 h-8 w-full">
      <polygon points={`0,${SH} ${points} ${W},${SH}`} fill="var(--color-brand)" fillOpacity={0.1} />
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
