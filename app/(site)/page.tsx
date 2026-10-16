import type { Metadata } from "next";
import { create } from "qrcode";
import { CtaFinal } from "./components/CtaFinal";
import { Dev } from "./components/Dev";
import { FAQS, Faq } from "./components/Faq";
import { Fatos } from "./components/Fatos";
import { Hero, type Qr } from "./components/Hero";
import { Precos } from "./components/Precos";
import { Recursos } from "./components/Recursos";
import { Segmentos } from "./components/Segmentos";
import { CNPJ, FEE_IN, LEGAL_NAME, SITE_URL } from "./site";

const title = "Vantri | Pix para vendas digitais";
const OG_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: "Vantri: Pix para vendas digitais" };
const description = `Cobrança Pix com QR Code, webhooks assinados e saque com 2FA para quem vende cursos, mentorias, e-books e SaaS. ${FEE_IN} por Pix recebido, sem mensalidade.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/" },
  // `openGraph` da página substitui o da raiz inteiro, então a imagem gerada vai explícita.
  openGraph: { type: "website", locale: "pt_BR", siteName: "Vantri", url: "/", title, description, images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE] },
};

// QR do mock aponta para o próprio site (não é um Pix de verdade).
function qrPath(text: string): Qr {
  const { size, data } = create(text, { errorCorrectionLevel: "M" }).modules;
  let d = "";
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (data[r * size + c]) d += `M${c} ${r}h1v1h-1z`;
  return { size, d };
}

// JSON-LD só com Organization e FAQPage (sem aggregateRating nem números).
const jsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Vantri",
    url: SITE_URL,
    logo: `${SITE_URL}/vantri-logo.svg`,
    description,
    areaServed: "BR",
    ...(LEGAL_NAME && { legalName: LEGAL_NAME }),
    ...(CNPJ && { taxID: CNPJ }),
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  },
];

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <Hero qr={qrPath(SITE_URL)} />
      <Segmentos />
      <Fatos />
      <Recursos />
      <Dev />
      <Precos />
      <Faq />
      <CtaFinal />
    </>
  );
}
