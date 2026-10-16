import type { Metadata } from "next";
import { ApiReference } from "./ApiReference";

export const metadata: Metadata = {
  title: "Documentação da API | Vantri",
  description:
    "Referência da API REST da Vantri: cobranças Pix, saques, saldo, extrato, MED e webhooks assinados. Contrato OpenAPI 3.1.",
  alternates: { canonical: "/docs" },
};

export default function Docs() {
  return (
    <>
      <h1 className="sr-only">Documentação da API</h1>
      <ApiReference />
      <noscript>
        <p className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          A documentação interativa precisa de JavaScript. O contrato completo está em{" "}
          <a href="/api/v1/openapi.json" className="underline">
            /api/v1/openapi.json
          </a>{" "}
          (OpenAPI 3.1).
        </p>
      </noscript>
    </>
  );
}
