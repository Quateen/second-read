import type { MetadataRoute } from "next";
export default function sitemap(): MetadataRoute.Sitemap {
  const site = process.env.NEXT_PUBLIC_SITE_URL || "https://secondread.health";
  const now = new Date();
  return [
    { url: `${site}/`, lastModified: now, priority: 1 },
    { url: `${site}/methodology`, lastModified: now, priority: 0.7 },
  ];
}
