import { BlockList, isIP } from "node:net";

// Duas listas: o BlockList casa IPv4 contra regra IPv6 (8.8.8.8 cairia em ::ffff:0:0/96).
const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "esta rede"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (metadados de nuvem)
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmark
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado, inclui 255.255.255.255
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["::", 96], // IPv4-compatível, inclui :: e ::1
  ["::ffff:0:0", 96], // IPv4-mapeado (qualquer um)
  ["::ffff:0:0:0", 96], // IPv4-traduzido (SIIT)
  ["64:ff9b::", 96], // NAT64
  ["2002::", 16], // 6to4
  ["fc00::", 7], // únicas-locais
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (obsoleto)
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

/** IP privado/reservado → true. Texto que não é IP também → true (falha fechada). */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip); // IPv6 com zona (fe80::1%eth0) também casa
  if (v === 4) return blockedV4.check(ip, "ipv4");
  if (v === 6) return blockedV6.check(ip, "ipv6");
  return true;
}

/** Host como o resolvedor espera: sem colchetes de IPv6 e sem ponto final. */
export function webhookHost(url: URL): string {
  return url.hostname.replace(/\.+$/, "").replace(/^\[(.*)\]$/, "$1");
}

// ponytail: aqui só o texto da URL. Nome público que resolve para IP interno é barrado no envio
// (dispatch.ts resolve o nome e checa cada IP com isBlockedAddress).
/** Motivo em PT se a URL não pode ser endpoint de webhook; null se pode. Usado no cadastro e no envio. */
export function webhookUrlProblem(raw: string): string | null {
  if (raw.length > 2048) return "URL longa demais (máximo de 2048 caracteres).";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "URL inválida.";
  }
  if (url.protocol !== "https:") return "A URL precisa começar com https://.";
  if (url.username || url.password) return "A URL não pode conter usuário ou senha.";
  // O parser já normaliza: minúsculas, IPv4 em decimal/hexa vira pontuado.
  const host = webhookHost(url);
  const internal = isIP(host)
    ? isBlockedAddress(host)
    : !host.includes(".") || /\.(localhost|local|localdomain|internal)$/.test(host);
  return internal ? "Endereço interno não é permitido para webhook." : null;
}
