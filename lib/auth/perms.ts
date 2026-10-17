// Matriz de permissões do backoffice: FONTE ÚNICA. Todo guarda do servidor (requireAdmin) e
// toda tela (perms-ui) consultam `pode`. Afrouxar algo aqui quebra tests/perms.test.ts.
//
// Papéis (sub-papel do admin; lojista e admins antigos ficam sem papel => null):
//  - admin:    tudo, incluindo aprovar quatro-olhos.
//  - operador: opera dinheiro/cadastro, mas PEDE (não aprova quatro-olhos) e não gere equipe.
//  - suporte:  só leitura + reset de 2FA (usuarios:operar). Nada de editar/operar/mover/exportar/cadastro.

export type AdminRole = "admin" | "operador" | "suporte";

export type Perm =
  | "clientes:ler"
  | "clientes:cadastro" // aprovar/recusar/suspender/reativar/criar
  | "taxas:editar"
  | "transacoes:ler"
  | "transacoes:exportar"
  | "saques:operar" // repoll, reenviar
  | "dinheiro:mover" // ajuste manual, estorno manual, marcar-falho+estornar (SEMPRE via quatro olhos)
  | "quatro_olhos:aprovar"
  | "med:ler"
  | "med:operar" // abrir/encerrar no simulador, anotações
  | "webhooks:operar" // reenviar, desativar endpoint
  | "auditoria:ler"
  | "auditoria:exportar"
  | "acessos:ler"
  | "acessos:exportar"
  | "equipe:gerir" // papéis de admin
  | "usuarios:operar" // reset 2FA, forçar troca de senha, derrubar sessões, desbloquear
  | "tarifas:gerir"
  | "saude:ler";

// `admin` tem todas; por isso `ALL` também serve de conjunto completo de Perm (coberto por teste).
const ALL = [
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
] as const satisfies readonly Perm[];

const SUPORTE = ["clientes:ler", "transacoes:ler", "med:ler", "acessos:ler", "auditoria:ler", "saude:ler", "usuarios:operar"] as const satisfies readonly Perm[];
const OPERADOR_NAO = new Set<Perm>(["equipe:gerir", "quatro_olhos:aprovar"]);

export const PERMS: Record<AdminRole, ReadonlySet<Perm>> = {
  admin: new Set(ALL),
  operador: new Set(ALL.filter((p) => !OPERADOR_NAO.has(p))),
  suporte: new Set(SUPORTE),
};

/** Papel nulo (lojista / admin sem sub-papel) nunca pode nada. */
export const pode = (role: AdminRole | null, perm: Perm): boolean => (role ? PERMS[role].has(perm) : false);
