import { randomBytes } from "node:crypto";
import { generate } from "otplib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { checkTotp, newTotpSecret, totpUri } from "@/lib/auth/totp";
import { decrypt, encrypt, randomBase62, randomToken, sha256Hex } from "@/lib/crypto";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("crypto", () => {
  it("encrypt/decrypt roundtrip", () => {
    const enc = encrypt("segredo do lojista ç");
    expect(enc).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(decrypt(enc)).toBe("segredo do lojista ç");
  });

  it("decrypt rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = encrypt("valor importante").split(":");
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(() => decrypt([v, iv, tag, flipped].join(":"))).toThrow();
  });

  it("two encryptions of same text differ", () => {
    expect(encrypt("mesmo texto")).not.toBe(encrypt("mesmo texto"));
  });

  it("throws clear error when key is missing or wrong length", () => {
    const original = process.env.APP_ENCRYPTION_KEY;
    try {
      delete process.env.APP_ENCRYPTION_KEY;
      expect(() => encrypt("x")).toThrow(/APP_ENCRYPTION_KEY/);
      process.env.APP_ENCRYPTION_KEY = randomBytes(16).toString("base64");
      expect(() => encrypt("x")).toThrow(/32 bytes/);
    } finally {
      process.env.APP_ENCRYPTION_KEY = original;
    }
  });

  it("sha256Hex, randomToken and randomBase62", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomBase62(40)).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(randomBase62(40)).not.toBe(randomBase62(40));
  });
});

describe("password", () => {
  it("verifyPassword true for right, false for wrong", async () => {
    const h = await hashPassword("senha-forte-123");
    expect(await verifyPassword(h, "senha-forte-123")).toBe(true);
    expect(await verifyPassword(h, "senha-forte-124")).toBe(false);
  });

  it("hash is not the password", async () => {
    const h = await hashPassword("senha-forte-123");
    expect(h).not.toContain("senha-forte-123");
    expect(h.startsWith("$argon2id$")).toBe(true);
  });
});

describe("totp", () => {
  // Segredo e relógio fixos (meio de um passo de 30 s): testes determinísticos.
  const NOW = 1_800_000_015;
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const codeAt = (stepsAgo: number) => generate({ secret, epoch: NOW - stepsAgo * 30 });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checkTotp accepts current code", async () => {
    expect(await checkTotp(secret, await codeAt(0))).toBe(true);
  });

  it("accepts code from 1 step ago, rejects 2 steps ago", async () => {
    expect(await checkTotp(secret, await codeAt(1))).toBe(true);
    const twoAgo = await codeAt(2);
    expect(await Promise.all([-1, 0, 1].map(codeAt))).not.toContain(twoAgo); // pré-condição
    expect(await checkTotp(secret, twoAgo)).toBe(false);
  });

  it("rejects '000000' when not current", async () => {
    expect(await Promise.all([-1, 0, 1].map(codeAt))).not.toContain("000000"); // pré-condição
    expect(await checkTotp(secret, "000000")).toBe(false);
  });

  it("rejects code from 3 steps ago", async () => {
    const old = await codeAt(3);
    expect(await Promise.all([-1, 0, 1].map(codeAt))).not.toContain(old); // pré-condição
    expect(await checkTotp(secret, old)).toBe(false);
  });

  it("rejects non-6-digit input without throwing", async () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345", "１２３４５６"]) {
      expect(await checkTotp(secret, bad)).toBe(false);
    }
  });

  it("totpUri carries issuer Vantri, email and secret", () => {
    expect(totpUri(secret, "a@b.com")).toBe(
      `otpauth://totp/Vantri:a%40b.com?secret=${secret}&issuer=Vantri`,
    );
  });

  it("newTotpSecret is base32 and differs each call", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(newTotpSecret()).not.toBe(s);
  });
});
