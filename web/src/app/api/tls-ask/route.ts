/**
 * Caddy on-demand TLS hỏi trước khi xin chứng chỉ cho một tên miền (W5).
 * 200 chỉ khi tên miền đã xác minh (status = active). Thiếu bước này thì ai trỏ tên
 * miền gì vào server cũng làm Caddy xin chứng chỉ và bị Let's Encrypt giới hạn.
 * Subdomain của nền tảng dùng chứng chỉ wildcard, không đi qua đây.
 */
import { resolveDomain } from "@/utils/siteServer";

export async function GET(req: Request) {
  const domain = (new URL(req.url).searchParams.get("domain") || "").toLowerCase().trim();
  if (!domain || domain.length > 253) return new Response("bad request", { status: 400 });
  const shop = await resolveDomain(domain).catch(() => null);
  return new Response(shop ? "ok" : "unknown", { status: shop ? 200 : 404 });
}
