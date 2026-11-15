// Chủ shop tự đăng ký (docs/multi-shop-design.md §1).
//
// Tạo: auth user → organization (gói trial) → shop đầu tiên → owner TOÀN tổ chức.
// Mọi quyền được ghi bằng service role qua RPC provision_tenant; client không
// gửi được vai trò / tổ chức nào (xem migration 20261115000100).
//
// Chống lạm dụng:
//   * Cloudflare Turnstile nếu đặt TURNSTILE_SECRET_KEY (bắt buộc ở production).
//   * Giới hạn gửi email / đăng ký của Supabase Auth ([auth.rate_limit]).
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY  (Supabase tự cấp)
//   TURNSTILE_SECRET_KEY            — bỏ trống = không kiểm captcha (chỉ dùng local)
//   SIGNUP_REQUIRE_EMAIL_CONFIRM    — 'false' = kích hoạt ngay (local); mặc định bắt xác thực email
//   SIGNUP_REDIRECT_URL             — trang mở sau khi bấm link xác thực email

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
const turnstileSecret = Deno.env.get('TURNSTILE_SECRET_KEY') ?? ''
const requireEmailConfirm = (Deno.env.get('SIGNUP_REQUIRE_EMAIL_CONFIRM') ?? 'true') !== 'false'
const redirectTo = Deno.env.get('SIGNUP_REDIRECT_URL') ?? undefined

if (!supabaseUrl || !serviceRoleKey || !anonKey) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY')
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
const publicClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })

const MIN_PASSWORD_LENGTH = 10
const BUSINESS_TYPES = new Set(['fnb', 'retail', 'rental'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type SignupPayload = {
  email: string
  password: string
  full_name?: string
  organization_name?: string
  shop_name: string
  business_type: string
  subdomain?: string | null
  captcha_token?: string
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function fail(detail: string, status = 400): Response {
  return json({ detail }, status)
}

async function verifyTurnstile(token: string | undefined, ip: string | null): Promise<boolean> {
  if (!turnstileSecret) {
    console.warn('TURNSTILE_SECRET_KEY chưa đặt — bỏ qua captcha (chỉ chấp nhận ở môi trường local).')
    return true
  }
  if (!token) return false
  const form = new FormData()
  form.append('secret', turnstileSecret)
  form.append('response', token)
  if (ip) form.append('remoteip', ip)
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  if (!res.ok) return false
  const data = await res.json() as { success?: boolean }
  return data.success === true
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return fail('Method Not Allowed', 405)

  let payload: SignupPayload
  try {
    payload = await request.json()
  } catch {
    return fail('Body không phải JSON hợp lệ.')
  }

  const email = (payload.email ?? '').trim().toLowerCase()
  const password = payload.password ?? ''
  const shopName = (payload.shop_name ?? '').trim()
  const businessType = (payload.business_type ?? '').trim()
  const subdomain = (payload.subdomain ?? '').trim().toLowerCase() || null

  if (!EMAIL_RE.test(email) || email.length > 254) return fail('Email không hợp lệ.')
  if (password.length < MIN_PASSWORD_LENGTH) return fail(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`)
  if (!shopName || shopName.length > 120) return fail('Tên shop là bắt buộc (tối đa 120 ký tự).')
  if (!BUSINESS_TYPES.has(businessType)) return fail('Loại nghiệp vụ không hợp lệ.')

  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  if (!(await verifyTurnstile(payload.captcha_token, ip))) {
    return fail('Xác minh chống bot thất bại. Vui lòng thử lại.', 403)
  }

  // Kiểm subdomain trước khi tạo user để khỏi phải dọn dẹp ở lỗi thường gặp nhất.
  if (subdomain) {
    const { data: taken } = await admin.from('branches').select('id').eq('subdomain', subdomain).maybeSingle()
    if (taken) return fail(`Subdomain "${subdomain}" đã có shop khác dùng.`, 409)
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: !requireEmailConfirm,
    // Chỉ nhãn hiển thị. Quyền do provision_tenant ghi, không nằm trong metadata.
    user_metadata: { full_name: payload.full_name ?? null },
  })

  if (createError || !created?.user) {
    // Không tiết lộ email đã tồn tại hay chưa quá chi tiết; vẫn báo được lỗi chung.
    const exists = /already|registered|exists/i.test(createError?.message ?? '')
    return fail(exists ? 'Email này đã được đăng ký.' : 'Không tạo được tài khoản.', exists ? 409 : 400)
  }

  const userId = created.user.id

  const { data: tenant, error: provisionError } = await admin.rpc('provision_tenant', {
    p_user_id: userId,
    p_org_name: payload.organization_name ?? shopName,
    p_shop_name: shopName,
    p_business_type: businessType,
    p_subdomain: subdomain,
    p_full_name: payload.full_name ?? null,
  })

  if (provisionError) {
    await admin.auth.admin.deleteUser(userId)
    return fail(provisionError.message, provisionError.code === '23505' ? 409 : 400)
  }

  if (requireEmailConfirm) {
    const { error: resendError } = await publicClient.auth.resend({
      type: 'signup',
      email,
      options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
    })
    if (resendError) console.error('Gửi email xác thực thất bại', resendError.message)
  }

  return json({
    user_id: userId,
    organization_id: tenant?.organization_id,
    branch_id: tenant?.branch_id,
    email_confirmation_required: requireEmailConfirm,
  }, 201)
})
