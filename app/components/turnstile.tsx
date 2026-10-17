"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type TurnstileApi = {
  render(el: HTMLElement, opts: { sitekey: string; language?: string; size?: "flexible" | "compact" }): string;
  reset(id: string): void;
  remove(id: string): void;
};

/**
 * Cloudflare Turnstile. Dentro de um <form>, o widget põe o campo `cf-turnstile-response`.
 * Sem NEXT_PUBLIC_TURNSTILE_SITE_KEY não renderiza nada (o servidor também libera sem a chave secreta).
 * O token vale uma vez: cada `resetKey` novo (nova resposta do servidor) pede outro desafio.
 */
export function Turnstile({ resetKey }: { resetKey?: unknown }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const api = (window as { turnstile?: TurnstileApi }).turnstile;
    if (!loaded || !SITE_KEY || !api || !box.current) return;
    // flexible ocupa a largura toda, mas tem mínimo de 300 px; abaixo disso, o compacto (150 px) cabe.
    const size = box.current.clientWidth < 300 ? "compact" : "flexible";
    const id = api.render(box.current, { sitekey: SITE_KEY, language: "pt-br", size });
    widget.current = id;
    return () => {
      api.remove(id);
      widget.current = undefined;
    };
  }, [loaded]);

  useEffect(() => {
    if (widget.current) (window as { turnstile?: TurnstileApi }).turnstile?.reset(widget.current);
  }, [resetKey]);

  if (!SITE_KEY) return null;
  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        onReady={() => setLoaded(true)}
      />
      <div ref={box} className="min-h-[65px]" />
    </>
  );
}
