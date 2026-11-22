// Key Supabase cho Edge Functions — chạy được với cả key mới lẫn key cũ.
//
// Project mới chỉ có key mới (sb_publishable_… / sb_secret_…), không còn anon /
// service_role dạng JWT. Đặt key mới làm secret của Functions:
//   supabase secrets set SB_PUBLISHABLE_KEY=sb_publishable_… SB_SECRET_KEY=sb_secret_…
// (Supabase giữ chỗ mọi tên bắt đầu bằng SUPABASE_, nên phải dùng tiền tố SB_.)
// Không đặt thì dùng key cũ Supabase tự cấp (SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY)
// — local `supabase start` vẫn chạy như trước.

const env = (...names: string[]) => names.map((n) => Deno.env.get(n)).find((v) => !!v) ?? ''

export const supabaseUrl = env('SUPABASE_URL')

/** Key công khai: gọi API bằng quyền người dùng (kèm JWT của họ) hoặc khách. */
export const publishableKey = env('SB_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY')

/** Key bí mật (quyền service role): Admin API, ghi vượt RLS. Chỉ dùng phía server. */
export const secretKey = env('SB_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')

export function requireKeys(opts: { publishable?: boolean; secret?: boolean }) {
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    opts.publishable && !publishableKey && 'SB_PUBLISHABLE_KEY (hoặc SUPABASE_ANON_KEY)',
    opts.secret && !secretKey && 'SB_SECRET_KEY (hoặc SUPABASE_SERVICE_ROLE_KEY)',
  ].filter(Boolean)
  if (missing.length) throw new Error(`Thiếu biến môi trường: ${missing.join(', ')}`)
}
