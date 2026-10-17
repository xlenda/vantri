import { describe, expect, it } from "vitest";
import { type AdminRole, PERMS, type Perm, pode } from "@/lib/auth/perms";

// Matriz = fonte única de verdade do controle de acesso do backoffice. A tela só espelha.
// Prova por mutação: se alguém afrouxar a matriz (dar a `suporte` uma permissão de
// dinheiro/taxa/aprovação, ou deixar `operador` aprovar quatro-olhos), um destes casos quebra.

const ALL: Perm[] = [
  "clientes:ler",
  "clientes:cadastro",
  "taxas:editar",
  "transacoes:ler",
  "transacoes:exportar",
  "saques:operar",
  "dinheiro:mover",
  "quatro_olhos:aprovar",
  "med:ler",
  "med:operar",
  "webhooks:operar",
  "auditoria:ler",
  "auditoria:exportar",
  "acessos:ler",
  "acessos:exportar",
  "equipe:gerir",
  "usuarios:operar",
  "tarifas:gerir",
  "saude:ler",
];

// Permissões que um `suporte` PODE ter (leitura + reset de 2FA). Tudo o resto é negado.
const SUPORTE_PODE: Perm[] = [
  "clientes:ler",
  "transacoes:ler",
  "med:ler",
  "acessos:ler",
  "auditoria:ler",
  "saude:ler",
  "usuarios:operar",
];
// Operador faz tudo, menos gerir equipe e aprovar quatro-olhos (ele PEDE, não aprova).
const OPERADOR_NAO: Perm[] = ["equipe:gerir", "quatro_olhos:aprovar"];

describe("matriz de permissões (pode)", () => {
  it("admin pode tudo", () => {
    for (const p of ALL) expect(pode("admin", p)).toBe(true);
  });

  it("operador: tudo menos gerir equipe e aprovar quatro-olhos", () => {
    for (const p of ALL) expect(pode("operador", p)).toBe(!OPERADOR_NAO.includes(p));
  });

  it("suporte: só leitura e reset de 2FA; nada de editar/operar/mover/exportar/cadastro", () => {
    for (const p of ALL) expect(pode("suporte", p)).toBe(SUPORTE_PODE.includes(p));
  });

  it("papel nulo (lojista ou admin antigo sem papel) não pode nada", () => {
    for (const p of ALL) expect(pode(null, p)).toBe(false);
  });

  // Casos que o brief cita nominalmente (as fronteiras que mais importam).
  it("as fronteiras de dinheiro/taxa/aprovação", () => {
    expect(pode("suporte", "dinheiro:mover")).toBe(false);
    expect(pode("suporte", "taxas:editar")).toBe(false);
    expect(pode("suporte", "clientes:cadastro")).toBe(false); // não aprova cliente
    expect(pode("suporte", "usuarios:operar")).toBe(true); // mas reseta 2FA
    expect(pode("operador", "quatro_olhos:aprovar")).toBe(false);
    expect(pode("operador", "taxas:editar")).toBe(true);
    expect(pode("operador", "dinheiro:mover")).toBe(true); // move, mas vira pedido de quatro-olhos
  });

  it("a lista de perms do teste cobre a matriz inteira, campo a campo", () => {
    // Guarda contra uma perm nova entrar em perms.ts e passar despercebida aqui.
    const union = new Set<Perm>();
    for (const role of ["admin", "operador", "suporte"] as AdminRole[]) for (const p of PERMS[role]) union.add(p);
    // admin tem todas, então a união é o conjunto completo de Perm.
    expect([...union].sort()).toEqual([...ALL].sort());
  });
});
