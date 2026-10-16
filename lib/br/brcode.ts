// BR Code (Pix copia-e-cola) no layout EMV MPM do "Manual de Padrões para Iniciação do Pix" (BCB).

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), 4 hex maiúsculos. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// Campo EMV: ID(2) + tamanho(2, com zero à esquerda) + valor.
function f(id: string, value: string): string {
  if (value.length > 99) throw new Error(`campo ${id} do BR Code passa de 99 caracteres`);
  return id + String(value.length).padStart(2, "0") + value;
}

// Tira acento (NFD) e qualquer caractere fora do ASCII imprimível, que quebraria a contagem de tamanho.
function ascii(s: string, max: number): string {
  return s.normalize("NFD").replace(/[^\x20-\x7E]/g, "").trim().slice(0, max);
}

export function buildBrCode(p: {
  pixKey: string;
  amountCents: number;
  merchantName: string;
  merchantCity: string;
  txid: string;
}): string {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) {
    throw new Error("valor do BR Code precisa ser inteiro positivo em centavos");
  }
  const amount = `${Math.floor(p.amountCents / 100)}.${String(p.amountCents % 100).padStart(2, "0")}`;
  const body =
    f("00", "01") +
    f("01", "12") +
    f("26", f("00", "br.gov.bcb.pix") + f("01", p.pixKey)) +
    f("52", "0000") +
    f("53", "986") +
    f("54", amount) +
    f("58", "BR") +
    f("59", ascii(p.merchantName, 25)) +
    f("60", ascii(p.merchantCity, 15)) +
    f("62", f("05", p.txid)) +
    "6304";
  return body + crc16(body);
}
