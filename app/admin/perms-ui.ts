import type { AdminRole, Perm } from "@/lib/auth/perms";

// Rótulos em PT-BR para a tela. A DECISÃO de acesso continua no servidor (requireAdmin + pode);
// a UI só usa `pode` para mostrar/esconder botão — nunca como controle de acesso de verdade.
export { pode } from "@/lib/auth/perms";

export const ROLE_LABEL: Record<AdminRole, string> = {
  admin: "Administrador",
  operador: "Operador",
  suporte: "Suporte",
};

export const PERM_LABEL: Record<Perm, string> = {
  "clientes:ler": "Ver clientes",
  "clientes:cadastro": "Cadastro de clientes (aprovar, suspender, criar)",
  "taxas:editar": "Editar taxas",
  "transacoes:ler": "Ver transações",
  "transacoes:exportar": "Exportar transações",
  "saques:operar": "Operar saques (repoll, reenviar)",
  "dinheiro:mover": "Mover dinheiro (ajuste, estorno manual)",
  "quatro_olhos:aprovar": "Aprovar pedidos de quatro olhos",
  "med:ler": "Ver MED",
  "med:operar": "Operar MED",
  "webhooks:operar": "Operar webhooks",
  "auditoria:ler": "Ver auditoria",
  "auditoria:exportar": "Exportar auditoria",
  "acessos:ler": "Ver registros de acesso",
  "acessos:exportar": "Exportar registros de acesso",
  "equipe:gerir": "Gerir equipe (papéis de admin)",
  "usuarios:operar": "Operar usuários (reset de 2FA, derrubar sessões)",
  "tarifas:gerir": "Gerir tarifas",
  "saude:ler": "Ver saúde do sistema",
};
