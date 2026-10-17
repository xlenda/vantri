import { getMedFile } from "@/lib/services/med";
import { painelSession, rfc8187 } from "../../../lib";

/** Anexo da defesa de MED, só do próprio lojista; sempre como download (nunca renderizado no navegador). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { merchant } = await painelSession();
  const f = await getMedFile((await params).id, { role: "merchant", merchantId: merchant.id }); // de outro lojista → null
  if (!f) {
    return new Response("Arquivo não encontrado.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(new Blob([new Uint8Array(f.data)]), {
    headers: {
      "content-type": f.mime,
      "content-disposition": `attachment; filename*=UTF-8''${rfc8187(f.filename)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
