/**
 * Định tuyến theo tên miền (docs/website-design.md):
 *   <PLATFORM_DOMAIN>, app.<PLATFORM_DOMAIN>, 127.0.0.1 → app quản trị
 *   <shop>.<PLATFORM_DOMAIN>                            → /site/<shop>/<đường dẫn>
 *   tên miền riêng đã xác minh                          → /site/<shop>/<đường dẫn>
 *   tên miền lạ                                          → 404
 * Kết quả tra tên miền riêng cache trong bộ nhớ 60 giây.
 */
import { NextResponse, type NextRequest } from "next/server";
import { publicRestHeaders } from "@/utils/supabaseKeys";

const PLATFORM = (process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || "").toLowerCase();
const SUPABASE_URL = process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
// Subdomain dành cho hệ thống, không bao giờ là shop (khớp app.is_valid_subdomain)
const SYSTEM_SUBS = new Set(["app", "www", "api", "admin"]);

const cache = new Map<string, { shop: string | null; at: number }>();

async function shopForDomain(host: string): Promise<string | null> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.shop;
  let shop: string | null = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/site_resolve_domain`, {
      method: "POST",
      headers: publicRestHeaders(),
      body: JSON.stringify({ p_host: host }),
    });
    if (res.ok) shop = (await res.json()) || null;
  } catch {
    // Supabase tạm lỗi: không cache kết quả rỗng
    return null;
  }
  cache.set(host, { shop, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  return shop;
}

function rewriteToShop(req: NextRequest, shop: string) {
  const url = req.nextUrl.clone();
  const path = url.pathname;
  url.pathname = `/site/${shop}${path === "/" ? "" : path}`;
  const headers = new Headers(req.headers);
  // Trang trong website dựng link không có tiền tố /site/<shop>
  headers.set("x-site-base", "");
  headers.set("x-site-path", path);
  return NextResponse.rewrite(url, { request: { headers } });
}

export async function proxy(req: NextRequest) {
  const host = (req.headers.get("host") || "").toLowerCase().replace(/:\d+$/, "");

  // Máy dev / IP: luôn là app quản trị (xem website qua /site/<shop>)
  if (!host || host === "127.0.0.1" || host === "::1" || (host === "localhost" && PLATFORM !== "localhost")) {
    return NextResponse.next();
  }

  if (PLATFORM) {
    if (host === PLATFORM || host === `app.${PLATFORM}`) return NextResponse.next();
    if (host.endsWith(`.${PLATFORM}`)) {
      const sub = host.slice(0, -PLATFORM.length - 1);
      if (sub.includes(".") || SYSTEM_SUBS.has(sub)) return new NextResponse("Not found", { status: 404 });
      return rewriteToShop(req, sub);
    }
  }

  // Tên miền riêng
  const shop = await shopForDomain(host);
  if (shop) return rewriteToShop(req, shop);
  if (!PLATFORM) return NextResponse.next(); // chưa cấu hình nền tảng: giữ hành vi cũ
  return new NextResponse("Website không tồn tại.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export const config = {
  // Bỏ qua file tĩnh và API nội bộ
  matcher: ["/((?!_next/static|_next/image|api/|favicon.ico).*)"],
};
