export const onlyDigits = (s: string): string => s.replace(/\D/g, "");

/** Forma canônica de CPF/CNPJ: maiúsculas, sem pontuação. CNPJ numérico continua igual ao de antes. */
export const normalizeDocument = (s: string): string => s.toUpperCase().replace(/[.\-/\s]/g, "");

/** Recebe só dígitos (11). Recusa sequências repetidas, que passam no cálculo. */
export function isValidCpf(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    return ((s * 10) % 11) % 10;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/**
 * Recebe a forma normalizada (14): 12 caracteres [0-9A-Z] + 2 DVs numéricos (CNPJ alfanumérico, Receita, jul/2026).
 * Cada caractere vale código ASCII − 48 (dígito = ele mesmo). Pesos 2..9 da direita para a esquerda, reiniciando.
 */
export function isValidCnpj(d: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(d) || /^(.)\1{13}$/.test(d)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += (d.charCodeAt(i) - 48) * (((n - 1 - i) % 8) + 2);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

/** CPF `***.456.789-**`, CNPJ `12.345.678/****-**`. */
export function maskDocument(d: string): string {
  const x = normalizeDocument(d);
  if (x.length === 11) return `***.${x.slice(3, 6)}.${x.slice(6, 9)}-**`;
  if (x.length === 14) return `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/****-**`;
  return "***";
}

// Apostas não existem aqui de propósito (MP 1.394/2026).
export const SEGMENTS = [
  "cursos",
  "mentorias",
  "ebooks",
  "comunidades",
  "saas",
  "eventos_online",
  "servicos_digitais",
] as const;

export type Segment = (typeof SEGMENTS)[number];

export const SEGMENT_LABELS: Record<Segment, string> = {
  cursos: "Cursos online",
  mentorias: "Mentorias",
  ebooks: "E-books",
  comunidades: "Comunidades",
  saas: "SaaS e software",
  eventos_online: "Eventos online",
  servicos_digitais: "Serviços digitais",
};
