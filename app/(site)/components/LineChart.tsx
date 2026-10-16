"use client";

import { motion } from "motion/react";
import { usePlay } from "./Reveal";

// Saldo de exemplo ao longo da semana (ilustração, não é dado real).
const DAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const Y = [96, 84, 88, 62, 70, 44, 30];
const X = Y.map((_, i) => 20 + i * 60);
const LINE = Y.map((y, i) => `${i ? "L" : "M"}${X[i]},${y}`).join(" ");
const AREA = `${LINE} L${X[6]},120 L${X[0]},120 Z`;

export function LineChart() {
  const [ref, phase] = usePlay<HTMLDivElement>(0.3);
  const hide = phase === "waiting";
  const play = phase === "play";
  const t = (delay: number, duration: number) => (play ? { delay, duration, ease: "easeOut" as const } : { duration: 0 });
  return (
    <div ref={ref} className="relative w-full">
      <span className="absolute left-0 top-0 rounded-full bg-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
        exemplo
      </span>
      <svg viewBox="0 0 400 140" className="w-full" role="img" aria-label="Gráfico de exemplo do saldo subindo ao longo da semana">
        <defs>
          <linearGradient id="vt-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--color-brand)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--color-brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[40, 80, 120].map((y) => (
          <line key={y} x1="20" x2="380" y1={y} y2={y} stroke="var(--color-line)" strokeDasharray="3 3" />
        ))}
        <motion.path d={AREA} fill="url(#vt-area)" initial={false} animate={{ opacity: hide ? 0 : 1 }} transition={t(1.3, 0.8)} />
        <motion.path
          d={LINE}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{ pathLength: hide ? 0 : 1 }}
          transition={play ? { duration: 1.8, ease: [0.65, 0, 0.35, 1] } : { duration: 0 }}
        />
        <motion.circle
          cx={X[6]}
          cy={Y[6]}
          r={6}
          fill="var(--color-accent)"
          stroke="var(--color-ink)"
          strokeWidth={2}
          initial={false}
          animate={{ scale: hide ? 0 : 1 }}
          transition={play ? { delay: 1.75, type: "spring", stiffness: 320, damping: 18 } : { duration: 0 }}
        />
        {DAYS.map((d, i) => (
          <text key={d} x={X[i]} y="138" textAnchor="middle" className="fill-muted text-[11px]">
            {d}
          </text>
        ))}
      </svg>
    </div>
  );
}
