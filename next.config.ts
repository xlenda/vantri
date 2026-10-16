import type { NextConfig } from "next";

// React/Next em dev precisam de eval; produção fica sem.
const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

function csp(cdn = "") {
  return [
    "default-src 'self'",
    // ponytail: 'unsafe-inline' em script; CSP com nonce se houver XSS de terceiros
    `script-src 'self' 'unsafe-inline'${devEval} https://challenges.cloudflare.com${cdn}`,
    "frame-src https://challenges.cloudflare.com",
    "img-src 'self' data: blob:",
    `style-src 'self' 'unsafe-inline'${cdn}`,
    `connect-src 'self'${cdn}`,
    `font-src 'self'${cdn}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp() },
        ],
      },
      // Regra posterior sobrescreve a CSP acima só em /docs.
      {
        source: "/docs",
        headers: [{ key: "Content-Security-Policy", value: csp(" https://cdn.jsdelivr.net") }],
      },
    ];
  },
};

export default nextConfig;
