import { createHmac, timingSafeEqual } from "node:crypto";

const hmac = (secret: string, rawBody: string, t: number) =>
  createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");

/** Header `X-Vantri-Signature`: `t=<unix s>,v1=<hex hmac-sha256(secret, "<t>.<corpo>")>`. */
export function signPayload(secret: string, rawBody: string, t: number): string {
  return `t=${t},v1=${hmac(secret, rawBody, t)}`;
}

/** Como o lojista confere: mesmo HMAC sobre o corpo cru e `t` a no máximo `toleranceSec` de `now` (unix s). */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string,
  now: number,
  toleranceSec = 300,
): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t) > toleranceSec) return false;
  return timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(hmac(secret, rawBody, t), "hex"));
}
