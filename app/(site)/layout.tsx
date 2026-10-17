import { DEMO_PUBLIC_TEXT, DemoBanner } from "@/app/components/demo-banner";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";

export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <DemoBanner text={DEMO_PUBLIC_TEXT} />
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
        Pular para o conteúdo
      </a>
      <Header />
      <main id="conteudo">{children}</main>
      <Footer />
    </>
  );
}
