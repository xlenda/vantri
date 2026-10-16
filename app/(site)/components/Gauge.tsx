"use client";

import { useCountUp, usePlay } from "./Reveal";

const N = 44;
const TICKS = Array.from({ length: N }, (_, i) => {
  const a = Math.PI + (Math.PI * i) / (N - 1); // de 180° a 360° (semicírculo de cima)
  const p = (r: number) => [+(100 + r * Math.cos(a)).toFixed(2), +(100 + r * Math.sin(a)).toFixed(2)];
  const [x1, y1] = p(72);
  const [x2, y2] = p(92);
  return { x1, y1, x2, y2 };
});

const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Semicírculo de 44 tracinhos SVG; o tracinho i acende quando i/43 <= valor/100.
export function Gauge({ value, label }: { value: number; label: string }) {
  const [ref, phase] = usePlay<HTMLDivElement>(0.3);
  const v = useCountUp(phase, 0, value);
  return (
    <div ref={ref} className="mx-auto w-full max-w-[240px]">
      <svg viewBox="0 0 200 112" className="w-full" role="img" aria-label={`${fmt(value)}% ${label}`}>
        {TICKS.map((t, i) => (
          <line
            key={i}
            {...t}
            strokeWidth={2.6}
            strokeLinecap="round"
            stroke={i / (N - 1) <= v / 100 ? "var(--color-brand)" : "var(--color-line)"}
            style={{ transition: "stroke 220ms" }}
          />
        ))}
        <text x="100" y="92" textAnchor="middle" className="fill-ink text-[26px] font-bold tabular-nums">
          {fmt(v)}%
        </text>
        <text x="100" y="110" textAnchor="middle" className="fill-muted text-[11px] font-medium">
          {label}
        </text>
      </svg>
    </div>
  );
}
