import type { Db } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";

export async function newMerchant(d: Db, n: number): Promise<string> {
  const [m] = await d
    .insert(merchants)
    .values({
      legalName: `Loja ${n} LTDA`,
      tradeName: `Loja ${n}`,
      documentType: "cnpj",
      documentEnc: "v1:x:y:z",
      documentHash: `hash-${n}`,
      segment: "cursos",
    })
    .returning({ id: merchants.id });
  return m.id;
}
