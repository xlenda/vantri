// Símbolo: um "V" de duas faixas que se cruzam; o cruzamento fica em lima.
// Wordmark "vantri" desenhado em traço único (não depende de fonte instalada).
export const MARK = {
  left: "M4 6h10l20 36H24z",
  right: "M34 6h10L24 42H14z",
  cross: "M24 24l5 9-5 9-5-9z",
};
export const WORD =
  "M2.5 12.5l7 15 7-15M41 20a7.75 7.75 0 1 1-15.5 0a7.75 7.75 0 1 1 15.5 0M41 12.5v15M50 27.5v-15M50 19a6.5 6.5 0 0 1 13 0v8.5M76 4v18a5.5 5.5 0 0 0 5.5 5.5H84M71.5 12.5H83M93 27.5v-15M93 20a7.5 7.5 0 0 1 7.5-7.5H102M110 12.5v15";
export const WORD_DOT = { cx: 110, cy: 4.5, r: 3 };

const C = { brand: "#3b37f2", accent: "#c9f25b", ink: "#0e1120", bg: "#f6f6f1" };

export function Mark({ tone = "light" }: { tone?: "light" | "dark" }) {
  return (
    <>
      <path d={MARK.left} fill={C.brand} />
      <path d={MARK.right} fill={tone === "light" ? C.ink : C.bg} />
      <path d={MARK.cross} fill={C.accent} />
    </>
  );
}

export function Logo({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  const ink = tone === "light" ? C.ink : C.bg;
  return (
    <svg viewBox="0 0 194 48" className={className} role="img" aria-label="Vantri">
      <Mark tone={tone} />
      <g transform="translate(58 6) scale(1.2)">
        <path d={WORD} fill="none" stroke={ink} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <circle {...WORD_DOT} fill={ink} />
      </g>
    </svg>
  );
}
