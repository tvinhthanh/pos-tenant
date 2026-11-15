// Kiểm DNS tên miền riêng của shop (docs/website-design.md, W5).
//
// Điều kiện để chuyển active:
//   1. TXT  _pos-verify.<domain>  chứa verify_token  → chứng minh chủ shop sở hữu tên miền
//   2. <domain> trỏ về nền tảng: CNAME = PLATFORM_DOMAIN, hoặc bản ghi A trùng A của PLATFORM_DOMAIN
// Chỉ khi active thì /api/tls-ask mới cho Caddy xin chứng chỉ và proxy mới phục vụ website.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (Supabase tự cấp)
//      PLATFORM_DOMAIN — tên miền nền tảng, VD example.vn
//      PLATFORM_IPS    — (tùy chọn) IP máy chủ, phẩy ngăn cách, khi PLATFORM_DOMAIN không phân giải được A

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const platform = (Deno.env.get('PLATFORM_DOMAIN') ?? '').toLowerCase()
const platformIps = (Deno.env.get('PLATFORM_IPS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders })

async function resolve(name: string, type: 'TXT' | 'CNAME' | 'A'): Promise<string[]> {
  try {
    const r = await Deno.resolveDns(name, type)
    return (r as unknown[]).map((x) => (Array.isArray(x) ? x.join('') : String(x)).toLowerCase().replace(/\.$/, ''))
  } catch {
    return []
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ detail: 'Method not allowed' }, 405)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return json({ detail: 'Chưa đăng nhập.' }, 401)
  // Đọc bằng quyền của người gọi: RLS chỉ cho thấy tên miền của shop mình
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  })

  let body: { domain_id?: number }
  try { body = await req.json() } catch { return json({ detail: 'Dữ liệu không hợp lệ.' }, 400) }
  const { data: row, error } = await userClient
    .from('shop_domains').select('id, domain, verify_token, status, last_checked_at').eq('id', body.domain_id ?? 0).maybeSingle()
  if (error || !row) return json({ detail: 'Không tìm thấy tên miền.' }, 404)

  if (row.last_checked_at && Date.now() - new Date(row.last_checked_at).getTime() < 10_000) {
    return json({ detail: 'Vừa kiểm xong, đợi 10 giây rồi thử lại.' }, 429)
  }

  const domain = String(row.domain)
  let problem: string | null = null
  if (!platform) {
    problem = 'Máy chủ chưa cấu hình PLATFORM_DOMAIN.'
  } else if (domain === platform || domain.endsWith(`.${platform}`)) {
    problem = 'Không dùng tên miền của nền tảng làm tên miền riêng.'
  } else {
    const txt = await resolve(`_pos-verify.${domain}`, 'TXT')
    if (!txt.includes(String(row.verify_token).toLowerCase())) {
      problem = `Chưa thấy bản ghi TXT _pos-verify.${domain} với mã xác minh.`
    } else {
      const cname = await resolve(domain, 'CNAME')
      let pointed = cname.includes(platform)
      if (!pointed) {
        const [mine, ours] = await Promise.all([resolve(domain, 'A'), platformIps.length ? Promise.resolve(platformIps) : resolve(platform, 'A')])
        pointed = mine.length > 0 && mine.every((ip) => ours.includes(ip))
      }
      if (!pointed) problem = `${domain} chưa trỏ về ${platform} (CNAME hoặc bản ghi A).`
    }
  }

  const { error: recErr } = await admin.rpc('record_domain_check', { p_domain_id: row.id, p_ok: problem === null, p_error: problem })
  if (recErr) return json({ detail: recErr.message }, 500)
  return json({ ok: problem === null, error: problem ?? undefined })
})
