import { requireAdmin } from "@/lib/auth/guards";
import { getMedFile } from "@/lib/services/med";

// RFC 5987: encodeURIComponent deixa ' ( ) * passarem, e o ' separa as partes do filename*.
const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Anexo de defesa de MED, sempre como download (nunca abre no navegador com a origem do admin). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin({ perm: "med:ler" });
  const f = await getMedFile((await params).id, { role: "admin" });
  if (!f) {
    return new Response("Arquivo não encontrado.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // Cópia em Uint8Array<ArrayBuffer>: postgres-js devolve Buffer, PGlite Uint8Array.
  return new Response(new Uint8Array(f.data), {
    headers: {
      "Content-Type": f.mime,
      "Content-Disposition": `attachment; filename*=UTF-8''${rfc5987(f.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
