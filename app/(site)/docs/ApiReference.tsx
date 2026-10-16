"use client";

import { type CSSProperties, useEffect, useRef } from "react";

const SRC = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.75.0";
// SRI: /docs tem a mesma origem do painel, então um arquivo adulterado no CDN não pode rodar aqui.
// Trocou a versão? Recalcule: curl -sL <SRC> | openssl dgst -sha384 -binary | openssl base64 -A
const SRI = "sha384-xgelKlDcc+BYp0O+ZYzFesLnWCgGpEbXVVZWNQT6WyZYygN01tbEMygnjPXb5OPI";

type ScalarGlobal = { createApiReference: (el: Element, config: object) => { destroy: () => void } };

// Interface do Scalar em português, sem os atalhos de produto deles (IA, SDK/MCP, ferramentas) e sem telemetria.
const CONFIG = {
  url: "/api/v1/openapi.json",
  withDefaultFonts: false, // a CSP do /docs não libera fonts.scalar.com
  localization: { locale: "pt" },
  showDeveloperTools: "never",
  agent: { disabled: true },
  mcp: { disabled: true },
  telemetry: false,
};

/** Scalar monta depois da hidratação, num div que o React nunca preenche (sem conflito de DOM). */
export function ApiReference() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let app: { destroy: () => void } | undefined;
    const mount = () => {
      const scalar = (window as { Scalar?: ScalarGlobal }).Scalar;
      if (alive && scalar && ref.current) {
        app = scalar.createApiReference(ref.current, CONFIG);
      }
    };
    if ((window as { Scalar?: ScalarGlobal }).Scalar) mount();
    else {
      const script = Object.assign(document.createElement("script"), {
        src: SRC,
        integrity: SRI,
        crossOrigin: "anonymous",
        onload: mount,
      });
      document.body.appendChild(script);
    }
    return () => {
      alive = false;
      app?.destroy();
    };
  }, []);
  // Header do site é sticky com 64px + 1px de borda: o Scalar desconta isso nos elementos fixos dele.
  return <div ref={ref} className="min-h-screen" style={{ "--scalar-custom-header-height": "65px" } as CSSProperties} />;
}
