"use client";

import { animate, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// static  = valor/estado final (SSR, sem JS, movimento reduzido, ou já estava na tela ao hidratar)
// waiting = escondido/zerado depois da hidratação, esperando entrar na tela
// play    = entrou na tela: anima até o final
export type Phase = "static" | "waiting" | "play";

export function usePlay<T extends Element = HTMLDivElement>(amount = 0.3) {
  const ref = useRef<T>(null);
  // Sem `margin`: margem negativa encolhe a viewport nas laterais e trava o contador no celular.
  const inView = useInView(ref, { once: true, amount });
  const reduce = useReducedMotion();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) return; // já visível: não some
    setArmed(true);
  }, [reduce]);
  const phase: Phase = !armed || reduce ? "static" : inView ? "play" : "waiting";
  return [ref, phase] as const;
}

export function useCountUp(phase: Phase, from: number, to: number, duration = 1.8) {
  const [v, setV] = useState(to);
  useEffect(() => {
    if (phase === "static") return setV(to);
    if (phase === "waiting") return setV(from);
    const c = animate(from, to, { duration, ease: [0.22, 1, 0.36, 1], onUpdate: setV });
    return () => c.stop();
  }, [phase, from, to, duration]);
  return v;
}

export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const [ref, phase] = usePlay<HTMLDivElement>(0.15);
  return (
    <div
      ref={ref}
      data-phase={phase}
      className={`reveal ${className}`}
      style={delay ? ({ "--d": `${delay}ms` } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}
