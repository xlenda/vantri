import type { MetadataRoute } from "next";
import { SITE_URL } from "./(site)/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/termos", "/privacidade", "/docs"].map((p) => ({ url: `${SITE_URL}${p}`, lastModified: new Date("2026-10-16") }));
}
