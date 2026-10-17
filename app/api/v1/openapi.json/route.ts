import { openapiDoc } from "@/lib/api/openapi";

// Público: é o contrato que o /docs renderiza.
export function GET(): Response {
  return Response.json(openapiDoc());
}
