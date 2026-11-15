/**
 * Đọc website công khai ở phía server (SSR). Chỉ gọi RPC công khai bằng anon key —
 * anon không đọc thẳng bảng nào (docs/website-design.md, W1).
 */
import { headers } from "next/headers";
import type { CatalogItem, PublicPage, PublicPost, PublicPostSummary, PublicSite } from "@/utils/site";

// Trong Docker, Next gọi Supabase qua mạng nội bộ (SUPABASE_INTERNAL_URL); ở máy dev dùng URL công khai.
const SUPABASE_URL = process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
export const PLATFORM_DOMAIN = (process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || "").toLowerCase();

async function rpc<T>(fn: string, args: Record<string, unknown>, revalidate = 30): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    // Xuất bản xong tối đa `revalidate` giây sau khách thấy bản mới
    next: { revalidate },
  });
  if (!res.ok) {
    if (res.status >= 500) throw new Error(`Supabase ${fn}: ${res.status}`);
    return null;
  }
  return (await res.json()) as T;
}

export type SiteLookup = { site: PublicSite } | { redirect: string } | null;

export async function getSite(shop: string): Promise<SiteLookup> {
  const data = await rpc<PublicSite & { redirect?: string }>("get_public_site", { p_shop: shop });
  if (!data) return null;
  if (data.redirect) return { redirect: data.redirect };
  return { site: data };
}

export const getPage = (shop: string, path: string) => rpc<PublicPage>("get_public_page", { p_shop: shop, p_path: path });
export const getCatalog = async (shop: string) => (await rpc<CatalogItem[]>("get_public_catalog", { p_shop: shop }, 60)) ?? [];
export const getSitemap = async (shop: string) =>
  (await rpc<{ path: string; updated_at: string }[]>("get_public_sitemap", { p_shop: shop }, 300)) ?? [];
export const getPosts = async (shop: string, limit = 12, offset = 0) =>
  (await rpc<{ total: number; items: PublicPostSummary[] }>("get_public_posts", { p_shop: shop, p_limit: limit, p_offset: offset }, 60))
  ?? { total: 0, items: [] };
export const getPost = (shop: string, slug: string) => rpc<PublicPost>("get_public_post", { p_shop: shop, p_slug: slug }, 60);
export const resolveDomain =(host: string) => rpc<string>("site_resolve_domain", { p_host: host }, 60);

/**
 * Tiền tố đường dẫn trong website: proxy đặt x-site-base = "" khi khách vào bằng
 * tên miền của shop; xem qua app (/site/<shop>/…) thì giữ tiền tố.
 */
export async function siteBase(shop: string): Promise<string> {
  const h = await headers();
  return h.get("x-site-base") === "" ? "" : `/site/${shop}`;
}

/** Địa chỉ gốc để ghi canonical / sitemap */
export async function siteOrigin(site: PublicSite): Promise<string> {
  if (site.custom_domain) return `https://${site.custom_domain}`;
  if (PLATFORM_DOMAIN) return `https://${site.shop}.${PLATFORM_DOMAIN}`;
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  return `${proto}://${host}/site/${site.shop}`;
}
