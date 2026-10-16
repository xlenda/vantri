"use client";

import { useCountUp, usePlay } from "./Reveal";

export function Counter({
  to,
  from = 0,
  prefix = "",
  suffix = "",
  label,
}: {
  to: number;
  from?: number;
  prefix?: string;
  suffix?: string;
  label: string;
}) {
  // ref no bloco inteiro (largo), não num <span> estreito.
  const [ref, phase] = usePlay<HTMLDivElement>(0.3);
  const v = useCountUp(phase, from, to);
  return (
    <div ref={ref}>
      <p className="text-4xl font-bold tracking-tight tabular-nums sm:text-5xl" data-final={`${prefix}${to}${suffix}`}>
        {prefix}
        {Math.round(v)}
        {suffix}
      </p>
      <p className="mt-2 max-w-[22ch] text-sm leading-snug text-muted">{label}</p>
    </div>
  );
}
