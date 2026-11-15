import { getSite, getSitemap, siteOrigin } from "@/utils/siteServer";

// sitemap.xml theo từng shop (proxy đổi /sitemap.xml của tên miền shop về đây)
export async function GET(_req: Request, { params }: { params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const r = await getSite(shop);
  if (!r || !("site" in r)) return new Response("Not found", { status: 404 });
  const origin = await siteOrigin(r.site);
  const pages = await getSitemap(shop);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${esc(origin + (p.path === "/" ? "/" : p.path))}</loc><lastmod>${new Date(p.updated_at).toISOString()}</lastmod></url>`).join("\n")}
</urlset>`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
