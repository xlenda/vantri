import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBrCode, crc16 } from "@/lib/br/brcode";
import { getProvider } from "@/lib/provider";
import { simulator, WebhookAuthError } from "@/lib/provider/simulator";
import type { PixProvider } from "@/lib/provider/types";

// Chamadas da interface passam pelo tipo PixProvider, como no código de produção.
const provider: PixProvider = simulator;

// Lê o nível de cima de um payload EMV (ID 2 + tamanho 2 + valor). Map preserva a ordem dos IDs.
function tlv(s = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < s.length; ) {
    const len = Number(s.slice(i + 2, i + 4));
    out.set(s.slice(i, i + 2), s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

const base = {
  pixKey: "00000000-0000-4000-8000-000000000000",
  amountCents: 14990,
  merchantName: "VANTRI SIMULADOR",
  merchantCity: "SAO PAULO",
  txid: "abc123",
};

afterEach(() => vi.unstubAllEnvs());

describe("brcode", () => {
  it("crc16('123456789') === '29B1'", () => {
    expect(crc16("123456789")).toBe("29B1");
  });

  it("crc16 confere com o exemplo do manual do BCB", () => {
    const semCrc =
      "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304";
    expect(crc16(semCrc)).toBe("1D3D");
  });

  it("termina com 6304 + crc16 de tudo antes, incluindo '6304'", () => {
    const code = buildBrCode(base);
    expect(code.slice(-8, -4)).toBe("6304");
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)));
  });

  it("contém 5406149.90 para 14990 centavos", () => {
    expect(buildBrCode(base)).toContain("5406149.90");
    expect(tlv(buildBrCode({ ...base, amountCents: 5 })).get("54")).toBe("0.05");
  });

  it("monta os campos EMV na ordem e com os subcampos certos", () => {
    const f = tlv(buildBrCode(base));
    expect([...f.keys()]).toEqual(["00", "01", "26", "52", "53", "54", "58", "59", "60", "62", "63"]);
    expect(f.get("00")).toBe("01");
    expect(f.get("01")).toBe("12");
    expect(tlv(f.get("26"))).toEqual(new Map([["00", "br.gov.bcb.pix"], ["01", base.pixKey]]));
    expect(f.get("52")).toBe("0000");
    expect(f.get("53")).toBe("986");
    expect(f.get("58")).toBe("BR");
    expect(f.get("59")).toBe("VANTRI SIMULADOR");
    expect(f.get("60")).toBe("SAO PAULO");
    expect(tlv(f.get("62"))).toEqual(new Map([["05", "abc123"]]));
  });

  it("nome com acento sai sem acento; nome ≤25 e cidade ≤15", () => {
    const f = tlv(
      buildBrCode({
        ...base,
        merchantName: "Padaria São João da Esquina Ltda",
        merchantCity: "São José dos Campos",
      }),
    );
    expect(f.get("59")).toBe("Padaria Sao Joao da Esqui");
    expect(f.get("60")).toBe("Sao Jose dos Ca");
  });

  it("recusa valor que não é inteiro positivo em centavos", () => {
    expect(() => buildBrCode({ ...base, amountCents: 0 })).toThrow();
    expect(() => buildBrCode({ ...base, amountCents: 1.5 })).toThrow();
  });
});

describe("simulador", () => {
  it("gera ids com prefixo e BR Code com a chave EVP fixa", async () => {
    const { providerAccountId } = await provider.createAccount({
      merchantId: "m1",
      legalName: "Loja",
      document: "52998224725",
      documentType: "cpf",
      email: "a@b.com",
    });
    expect(providerAccountId).toMatch(/^sim_acc_/);
    const ch = await provider.createCharge({ providerAccountId, amountCents: 14990, txid: "tx1", expiresInSec: 3600 });
    expect(ch.providerChargeId).toMatch(/^sim_ch_/);
    expect(tlv(tlv(ch.brcode).get("26")).get("01")).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("simulator payout to falha@teste.com fails with pix_key_not_found", async () => {
    const p = await simulator.createPayout({
      providerAccountId: "sim_acc_x",
      amountCents: 1000,
      pixKey: "falha@teste.com",
      pixKeyType: "email",
      idempotencyKey: "k1",
    });
    expect(p.providerPayoutId).toMatch(/^sim_po_/);
    expect(p).toMatchObject({ status: "failed", failureCode: "pix_key_not_found" });
    expect(await simulator.getPayout(p.providerPayoutId)).toMatchObject({ status: "failed", failureCode: "pix_key_not_found" });
  });

  it("payout para outra chave conclui na hora com endToEndId", async () => {
    const p = await simulator.createPayout({
      providerAccountId: "sim_acc_x",
      amountCents: 1000,
      pixKey: "ok@teste.com",
      pixKeyType: "email",
      idempotencyKey: "k2",
    });
    expect(p.status).toBe("completed");
    expect(p.endToEndId).toMatch(/^E00000000[A-Za-z0-9]{23}$/);
    expect(await simulator.getPayout(p.providerPayoutId)).toEqual({ status: "completed", endToEndId: p.endToEndId });
    await expect(simulator.getPayout("sim_po_inexistente")).rejects.toThrow(/não encontrado/);
  });

  it("parseWebhook rejects wrong secret", async () => {
    vi.stubEnv("SIMULATOR_WEBHOOK_SECRET", "certo");
    const rawBody = JSON.stringify({ events: [simulator.simulatePaid("sim_ch_1")] });
    await expect(simulator.parseWebhook({ headers: new Headers({ "x-simulator-secret": "errado" }), rawBody })).rejects.toThrow("segredo do webhook do simulador inválido");
    await expect(simulator.parseWebhook({ headers: new Headers(), rawBody })).rejects.toThrow("segredo do webhook do simulador inválido");
  });

  it("parseWebhook rejects when SIMULATOR_WEBHOOK_SECRET is empty", async () => {
    vi.stubEnv("SIMULATOR_WEBHOOK_SECRET", "");
    const headers = new Headers({ "x-simulator-secret": "" });
    await expect(simulator.parseWebhook({ headers, rawBody: '{"events":[]}' })).rejects.toThrow("segredo do webhook do simulador inválido");
  });

  it("parseWebhook devolve os eventos do simulador com datas", async () => {
    vi.stubEnv("SIMULATOR_WEBHOOK_SECRET", "certo");
    const paid = simulator.simulatePaid("sim_ch_1");
    const med = simulator.simulateMed("sim_ch_1", 14990);
    const headers = new Headers({ "x-simulator-secret": "certo" });
    const events = await simulator.parseWebhook({ headers, rawBody: JSON.stringify({ events: [paid, med] }) });
    expect(events).toEqual([paid, med]);
    expect(paid).toMatchObject({ type: "charge.paid", providerChargeId: "sim_ch_1" });
    expect(med).toMatchObject({ type: "med.opened", providerChargeId: "sim_ch_1", amountCents: 14990 });
    expect(med.deadline.getTime()).toBeGreaterThan(Date.now());
  });

  it("parseWebhook rejects malformed body even with the right secret", async () => {
    vi.stubEnv("SIMULATOR_WEBHOOK_SECRET", "certo");
    const headers = new Headers({ "x-simulator-secret": "certo" });
    await expect(simulator.parseWebhook({ headers, rawBody: "não é json" })).rejects.toThrow("corpo do webhook do simulador inválido");
    await expect(
      simulator.parseWebhook({ headers, rawBody: JSON.stringify({ events: [{ type: "charge.paid", providerChargeId: "x" }] }) }),
    ).rejects.toThrow("corpo do webhook do simulador inválido");
  });

  it("parseWebhook rejects null, 0 and non-ISO dates", async () => {
    vi.stubEnv("SIMULATOR_WEBHOOK_SECRET", "certo");
    const headers = new Headers({ "x-simulator-secret": "certo" });
    const paid = simulator.simulatePaid("sim_ch_1");
    const med = simulator.simulateMed("sim_ch_1", 14990);
    const bodies = [
      { ...paid, paidAt: null },
      { ...paid, paidAt: 0 },
      { ...paid, paidAt: "2026-10-16" },
      { ...med, deadline: null },
      { ...med, deadline: 0 },
    ];
    for (const e of bodies) {
      await expect(simulator.parseWebhook({ headers, rawBody: JSON.stringify({ events: [e] }) })).rejects.toThrow(
        "corpo do webhook do simulador inválido",
      );
    }
  });

  it("only auth failures throw WebhookAuthError", async () => {
    vi.stubEnv("SIMULATOR_WEBHOOK_SECRET", "certo");
    const rawBody = '{"events":[]}';
    for (const headers of [new Headers({ "x-simulator-secret": "errado" }), new Headers(), new Headers({ "x-simulator-secret": "" })]) {
      await expect(simulator.parseWebhook({ headers, rawBody })).rejects.toBeInstanceOf(WebhookAuthError);
    }
    const bad = await simulator
      .parseWebhook({ headers: new Headers({ "x-simulator-secret": "certo" }), rawBody: "{" })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(bad).not.toBeInstanceOf(WebhookAuthError);
  });
});

describe("getProvider", () => {
  it("devolve o simulador com PIX_PROVIDER=simulator", () => {
    vi.stubEnv("PIX_PROVIDER", "simulator");
    expect(getProvider()).toBe(simulator);
  });

  it("outro valor → erro claro", () => {
    vi.stubEnv("PIX_PROVIDER", "banco-x");
    expect(() => getProvider()).toThrow("provedor banco-x não configurado");
  });
});
