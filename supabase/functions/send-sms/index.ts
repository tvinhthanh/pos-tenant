// Send SMS Hook của Supabase Auth → nhà cung cấp SMS Việt Nam (docs/website-design.md, C3).
//
// Supabase gọi hook này mỗi lần cần gửi OTP cho khách đăng nhập bằng số điện thoại.
// Ở local / staging dùng hook Postgres app.send_sms_hook (lưu mã vào app.sms_outbox), không cần hàm này.
//
// Cấu hình production (Dashboard → Authentication → Hooks → Send SMS → HTTPS):
//   URL    https://<project>.functions.supabase.co/send-sms
//   Secret lấy chuỗi "v1,whsec_…" đặt vào SEND_SMS_HOOK_SECRET
//
// Env:
//   SEND_SMS_HOOK_SECRET   — bắt buộc; chữ ký Standard Webhooks của Supabase
//   SMS_PROVIDER           — esms | speedsms
//   ESMS_API_KEY, ESMS_SECRET_KEY, ESMS_BRANDNAME     (eSMS.vn, SmsType 2 = brandname CSKH)
//   SPEEDSMS_ACCESS_TOKEN, SPEEDSMS_SENDER             (SpeedSMS.vn)
//   SMS_TEMPLATE           — mặc định "Ma xac thuc cua ban la {code}. Khong chia se ma nay cho ai."
//                            (brandname phải đăng ký mẫu tin trùng khớp với nhà mạng)

import { Webhook } from 'npm:standardwebhooks@1.0.0'

const secret = (Deno.env.get('SEND_SMS_HOOK_SECRET') ?? '').replace('v1,whsec_', '')
const provider = Deno.env.get('SMS_PROVIDER') ?? ''
const template = Deno.env.get('SMS_TEMPLATE') ?? 'Ma xac thuc cua ban la {code}. Khong chia se ma nay cho ai.'

type HookPayload = { user: { phone: string }; sms: { otp: string } }

const fail = (message: string, status = 500) =>
  Response.json({ error: { http_code: status, message } }, { status })

/** 84901234567 / +84… → 0901234567 (định dạng các nhà cung cấp trong nước nhận) */
const localPhone = (p: string) => {
  const d = p.replace(/\D/g, '')
  return d.startsWith('84') ? `0${d.slice(2)}` : d
}

async function sendEsms(phone: string, content: string) {
  const res = await fetch('https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ApiKey: Deno.env.get('ESMS_API_KEY'),
      SecretKey: Deno.env.get('ESMS_SECRET_KEY'),
      Brandname: Deno.env.get('ESMS_BRANDNAME'),
      SmsType: '2',
      Phone: phone,
      Content: content,
    }),
  })
  const data = await res.json().catch(() => ({}))
  // eSMS: CodeResult "100" = đã nhận yêu cầu gửi
  if (!res.ok || String(data.CodeResult) !== '100') throw new Error(`eSMS lỗi ${data.CodeResult ?? res.status}: ${data.ErrorMessage ?? ''}`)
}

async function sendSpeedSms(phone: string, content: string) {
  const token = Deno.env.get('SPEEDSMS_ACCESS_TOKEN') ?? ''
  const res = await fetch('https://api.speedsms.vn/index.php/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`${token}:x`)}` },
    body: JSON.stringify({ to: [phone], content, sms_type: 3, sender: Deno.env.get('SPEEDSMS_SENDER') }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.status !== 'success') throw new Error(`SpeedSMS lỗi: ${data.message ?? res.status}`)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed', 405)
  if (!secret) return fail('Chưa cấu hình SEND_SMS_HOOK_SECRET')

  const raw = await req.text()
  let payload: HookPayload
  try {
    // Chỉ Supabase Auth (có secret) gọi được — chặn người ngoài dùng hàm này gửi tin rác
    payload = new Webhook(secret).verify(raw, Object.fromEntries(req.headers)) as HookPayload
  } catch {
    return fail('Chữ ký webhook không hợp lệ', 401)
  }

  const phone = localPhone(payload.user?.phone ?? '')
  const otp = payload.sms?.otp ?? ''
  if (!/^0\d{9,10}$/.test(phone) || !/^\d{4,10}$/.test(otp)) return fail('Thiếu số điện thoại hoặc mã', 400)
  const content = template.replace('{code}', otp)

  try {
    if (provider === 'esms') await sendEsms(phone, content)
    else if (provider === 'speedsms') await sendSpeedSms(phone, content)
    else return fail(`SMS_PROVIDER "${provider}" chưa được hỗ trợ`)
  } catch (e) {
    console.error('send-sms', (e as Error).message)
    return fail('Không gửi được tin nhắn, vui lòng thử lại sau.')
  }
  return Response.json({})
})
