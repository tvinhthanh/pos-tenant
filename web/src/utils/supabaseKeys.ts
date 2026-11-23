/**
 * Key công khai của Supabase cho client/SSR.
 * Supabase đã bỏ anon key (JWT "eyJ…") cho project mới, thay bằng Publishable key
 * (sb_publishable_…). Đặt NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; biến cũ
 * NEXT_PUBLIC_SUPABASE_ANON_KEY chỉ còn là fallback cho môi trường chưa đổi.
 * (Phải viết process.env.NEXT_PUBLIC_… nguyên văn để Next inline vào bundle client.)
 */
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

/**
 * Header cho gọi REST/RPC trực tiếp bằng key công khai. Publishable key không phải JWT
 * nên chỉ gửi qua `apikey`; anon key cũ (JWT) mới gửi kèm Authorization.
 */
export function publicRestHeaders(): Record<string, string> {
  const key = SUPABASE_PUBLISHABLE_KEY;
  return {
    apikey: key,
    ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
    "Content-Type": "application/json",
  };
}
