import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import "../../site.css";
import { FloatingContact, SiteFooter, SiteHeader } from "@/components/site/Chrome";
import { getSite, siteBase, siteOrigin, PLATFORM_DOMAIN } from "@/utils/siteServer";
import { themeVars } from "@/utils/site";

// Website shop là root layout riêng: không đi qua đăng nhập / sidebar của app quản trị.
export async function generateMetadata({ params }: { params: Promise<{ shop: string }> }): Promise<Metadata> {
  const { shop } = await params;
  const r = await getSite(shop);
  if (!r || !("site" in r)) return {};
  const origin = await siteOrigin(r.site);
  return {
    metadataBase: new URL(origin.endsWith("/") ? origin : `${origin}/`),
    title: { default: r.site.name, template: `%s · ${r.site.name}` },
    description: r.site.tagline || `${r.site.name}${r.site.address ? ` — ${r.site.address}` : ""}`,
    icons: r.site.logo_url ? [{ url: r.site.logo_url }] : undefined,
  };
}

export async function generateViewport({ params }: { params: Promise<{ shop: string }> }): Promise<Viewport> {
  const { shop } = await params;
  const r = await getSite(shop);
  return { themeColor: r && "site" in r ? r.site.theme.primary : undefined };
}

export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const r = await getSite(shop);
  if (!r) notFound();
  if ("redirect" in r) {
    // Subdomain cũ (W4): chuyển hẳn sang địa chỉ mới, giữ đường dẫn
    const h = await headers();
    const onShopHost = h.get("x-site-base") === "";
    const path = h.get("x-site-path") || "/";
    permanentRedirect(onShopHost && PLATFORM_DOMAIN ? `https://${r.redirect}.${PLATFORM_DOMAIN}${path}` : `/site/${r.redirect}`);
  }
  const site = r.site;
  const base = await siteBase(shop);

  return (
    <html lang="vi">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href={site.theme.font === "serif"
            ? "https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&family=Be+Vietnam+Pro:wght@400;500;600&display=swap"
            : "https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap"}
        />
      </head>
      <body style={themeVars(site.theme) as React.CSSProperties} className="min-h-screen antialiased">
        <a href="#noi-dung" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:bg-white focus:p-2">
          Bỏ qua menu
        </a>
        <SiteHeader site={site} base={base} />
        <main id="noi-dung">{children}</main>
        <SiteFooter site={site} base={base} />
        <FloatingContact site={site} />
      </body>
    </html>
  );
}
