import { getSite, siteOrigin } from "@/utils/siteServer";

export async function GET(_req: Request, { params }: { params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const r = await getSite(shop);
  if (!r || !("site" in r)) return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  const origin = await siteOrigin(r.site);
  // Trang đặt hàng / tài khoản không cần lên Google
  const body = `User-agent: *\nAllow: /\nDisallow: /dat-hang\nDisallow: /tai-khoan\n\nSitemap: ${origin}/sitemap.xml\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
