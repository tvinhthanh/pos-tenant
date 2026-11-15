// Xuất báo cáo Excel 5 sheet (kế hoạch 3.3, thay GET /reports/excel của bản cũ).
//
//   1. Tổng quan  — kết quả kinh doanh (get_financial_report) + chi phí theo nhóm
//   2. Bán hàng   — doanh số theo ngày + theo món (get_sales_breakdown)
//   3. Kết ca     — đối chiếu từng ca mở trong kỳ (get_shift_reconciliation)
//   4. Chi phí    — danh sách phiếu chi trong kỳ (bảng expenses, RLS)
//   5. Tồn kho    — tồn hiện tại + giá trị tồn (bảng ingredients, RLS)
//
// Bảo mật: mọi truy vấn chạy bằng JWT của NGƯỜI GỌI (không dùng service role).
// get_financial_report gọi app.assert_branch_access + assert_role(owner/manager)
// nên chạy nó trước: người không có quyền ở chi nhánh bị chặn ngay (403).
//
// Body (POST JSON): { branch_id: number, from?: ISO string, to?: ISO string }
// Trả về: tệp .xlsx (application/octet-stream để supabase-js nhận dạng Blob).
//
// Thư viện: SheetJS bản npm 0.18.5 — chỉ dùng để GHI tệp. Các CVE của bản này
// (CVE-2023-30533, CVE-2024-22363) nằm ở đường ĐỌC tệp, không áp dụng ở đây.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import * as XLSX from 'npm:xlsx@0.18.5'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-disposition',
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders })

const TZ = 'Asia/Ho_Chi_Minh'
const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tiền mặt',
  bank_transfer: 'Chuyển khoản',
  momo: 'MoMo',
  zalopay: 'ZaloPay',
  vnpay: 'VNPay',
  card: 'Thẻ',
  debt: 'Công nợ',
}

type Row = (string | number | null)[]
type PgError = { code?: string; message?: string } | null

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const num = (v: unknown) => Number(v ?? 0) || 0
const str = (v: unknown) => (v == null ? '' : String(v))
const fmtDateTime = (iso: unknown) =>
  iso ? new Date(String(iso)).toLocaleString('vi-VN', { timeZone: TZ, hour12: false }) : ''
const fmtDate = (iso: unknown) =>
  iso ? new Date(String(iso)).toLocaleDateString('vi-VN', { timeZone: TZ }) : ''

function fail(error: PgError, fallback: string): never {
  if (error?.code === '42501') throw new HttpError(403, error.message || 'Bạn không có quyền xem báo cáo này.')
  throw new HttpError(400, error?.message || fallback)
}

function sheet(rows: Row[], widths: number[]) {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = widths.map((wch) => ({ wch }))
  return ws
}

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) fail(error, `Không lấy được dữ liệu ${fn}.`)
  return data as T
}

// ---------------------------------------------------------------------------
// Từng sheet
// ---------------------------------------------------------------------------
function overviewSheet(fin: any, periodLabel: string, branchName: string) {
  const rows: Row[] = [
    ['BÁO CÁO KẾT QUẢ KINH DOANH'],
    ['Cửa hàng', branchName],
    ['Kỳ báo cáo', periodLabel],
    [],
    ['Chỉ tiêu', 'Số tiền (đ)'],
    ['Doanh thu gộp', num(fin.gross_revenue)],
    ['Hoàn tiền', num(fin.refunds)],
    ['1. Doanh thu thuần', num(fin.revenue)],
    ['2. Giá vốn (COGS)', num(fin.cogs)],
    ['3. Lãi gộp (1 - 2)', num(fin.gross_profit)],
    ['4. Chi phí vận hành', num(fin.total_expenses)],
    ['5. Lãi ròng (3 - 4)', num(fin.net_profit)],
    ['6. Thuế khoán HKD (ước tính)', num(fin.estimated_tax)],
    ['Số đơn', num(fin.orders_count)],
    ['Giá trị đơn trung bình', num(fin.average_order_value)],
    [],
    ['CHI PHÍ THEO NHÓM'],
    ['Nhóm chi phí', 'Số tiền (đ)'],
    ...((fin.expenses_by_category || []) as any[]).map((c): Row => [str(c.category), num(c.amount)]),
  ]
  return sheet(rows, [34, 22])
}

function salesSheet(sales: any | null) {
  if (!sales) return sheet([['Không có dữ liệu bán hàng cho loại cửa hàng này.']], [60])
  const rows: Row[] = [
    ['DOANH SỐ THEO NGÀY'],
    ['Ngày', 'Số đơn', 'Doanh thu (đ)', 'Giảm giá (đ)', 'Số món', 'Món bán chạy', 'SL món bán chạy'],
    ...((sales.days || []) as any[]).map((d): Row => [
      str(d.day), num(d.orders), num(d.revenue), num(d.discount), num(d.quantity),
      str(d.top_product), num(d.top_quantity),
    ]),
    [],
    ['DOANH SỐ THEO MÓN'],
    ['Món', 'Danh mục', 'Số lượng', 'Doanh thu (đ)', 'Giá vốn (đ)', 'Lãi gộp (đ)', 'Số đơn'],
    ...((sales.products || []) as any[]).map((p): Row => [
      str(p.product_name), str(p.category), num(p.quantity), num(p.revenue), num(p.cost),
      num(p.revenue) - num(p.cost), num(p.orders),
    ]),
  ]
  return sheet(rows, [30, 16, 14, 16, 14, 26, 16])
}

function shiftsSheet(recs: any[]) {
  const rows: Row[] = [
    ['ĐỐI CHIẾU KẾT CA'],
    ['Ca', 'Mở lúc', 'Đóng lúc', 'Trạng thái', 'Phương thức', 'Hệ thống (đ)', 'Thực tế (đ)', 'Chênh lệch (đ)', 'Doanh số ca (đ)', 'Số đơn'],
  ]
  for (const { shift, rec } of recs) {
    for (const d of (rec.details || []) as any[]) {
      rows.push([
        num(shift.id), fmtDateTime(shift.opened_at), fmtDateTime(shift.closed_at),
        shift.status === 'open' ? 'Đang mở' : 'Đã đóng',
        PAYMENT_LABELS[d.method] ?? str(d.method),
        num(d.expected_amount), num(d.actual_amount), num(d.discrepancy),
        num(rec.total_sales), num(rec.total_orders),
      ])
    }
  }
  if (recs.length === 0) rows.push(['Không có ca nào mở trong kỳ.'])
  return sheet(rows, [8, 20, 20, 12, 16, 16, 16, 16, 18, 10])
}

function expensesSheet(expenses: any[]) {
  const rows: Row[] = [
    ['DANH SÁCH CHI PHÍ'],
    ['Ngày', 'Nhóm', 'Khoản chi', 'Số tiền (đ)', 'Phương thức', 'Ghi chú'],
    ...expenses.map((e): Row => [
      fmtDate(e.date), str(e.category_name), str(e.sub_category), num(e.amount),
      PAYMENT_LABELS[e.payment_method] ?? str(e.payment_method), str(e.description),
    ]),
    [],
    ['Tổng cộng', '', '', expenses.reduce((s, e) => s + num(e.amount), 0)],
  ]
  return sheet(rows, [14, 20, 26, 16, 16, 40])
}

function inventorySheet(items: any[]) {
  const rows: Row[] = [
    ['TỒN KHO HIỆN TẠI'],
    ['Nguyên liệu / hàng hóa', 'Đơn vị', 'Tồn kho', 'Tồn tối thiểu', 'Giá vốn (đ)', 'Giá trị tồn (đ)', 'Cảnh báo'],
    ...items.map((i): Row => [
      str(i.name), str(i.unit), num(i.stock), num(i.min_stock), num(i.cost_price),
      Math.round(num(i.stock) * num(i.cost_price)),
      num(i.stock) <= num(i.min_stock) ? 'Sắp hết' : '',
    ]),
    [],
    ['Tổng giá trị tồn', '', '', '', '', items.reduce((s, i) => s + Math.round(num(i.stock) * num(i.cost_price)), 0)],
  ]
  return sheet(rows, [30, 10, 12, 14, 14, 16, 12])
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ detail: 'Phương thức không được hỗ trợ.' }, 405)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return json({ detail: 'Chưa đăng nhập.' }, 401)

  // Client mang JWT người gọi: RPC/RLS kiểm quyền như khi gọi từ trình duyệt
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth } },
  })

  const { data: userData, error: userError } = await client.auth.getUser(auth.slice('Bearer '.length))
  if (userError || !userData?.user) return json({ detail: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' }, 401)

  let body: { branch_id?: number; from?: string | null; to?: string | null }
  try {
    body = await req.json()
  } catch {
    return json({ detail: 'Dữ liệu không hợp lệ.' }, 400)
  }

  const branchId = Number(body.branch_id)
  if (!Number.isSafeInteger(branchId) || branchId <= 0) return json({ detail: 'Thiếu chi nhánh.' }, 400)
  const from = body.from ? new Date(body.from) : null
  const to = body.to ? new Date(body.to) : null
  if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime())) || (from && to && from > to)) {
    return json({ detail: 'Khoảng ngày không hợp lệ.' }, 400)
  }
  if (from && to && to.getTime() - from.getTime() > 400 * 86_400_000) {
    return json({ detail: 'Chỉ xuất tối đa 400 ngày mỗi lần.' }, 400)
  }
  const fromIso = from?.toISOString() ?? null
  const toIso = to?.toISOString() ?? null

  try {
    // 1. Kiểm quyền chi nhánh + vai trò (owner/manager) ngay ở RPC đầu tiên
    const fin = await rpc<any>(client, 'get_financial_report', { p_branch_id: branchId, p_from: fromIso, p_to: toIso })

    // 2. Doanh số: shop cho thuê không có POS F&B/bán lẻ → bỏ trống sheet
    let sales: any | null = null
    {
      const { data, error } = await client.rpc('get_sales_breakdown', { p_branch_id: branchId, p_from: fromIso, p_to: toIso })
      if (error && error.code !== '22023') fail(error, 'Không lấy được doanh số.')
      sales = error ? null : data
    }

    // 3. Ca mở trong kỳ (RLS lọc theo chi nhánh người gọi được xem)
    let shiftQuery = client.from('shifts')
      .select('id, opened_at, closed_at, status')
      .eq('branch_id', branchId)
      .order('opened_at', { ascending: true })
      .limit(500)
    if (fromIso) shiftQuery = shiftQuery.gte('opened_at', fromIso)
    if (toIso) shiftQuery = shiftQuery.lte('opened_at', toIso)
    const { data: shifts, error: shiftError } = await shiftQuery
    if (shiftError) fail(shiftError, 'Không lấy được danh sách ca.')
    const recs: { shift: any; rec: any }[] = []
    for (const shift of shifts ?? []) {
      recs.push({ shift, rec: await rpc<any>(client, 'get_shift_reconciliation', { p_shift_id: shift.id }) })
    }

    // 4. Chi phí trong kỳ
    let expenseQuery = client.from('expenses')
      .select('date, category_name, sub_category, amount, payment_method, description')
      .eq('branch_id', branchId)
      .order('date', { ascending: true })
      .limit(5000)
    if (fromIso) expenseQuery = expenseQuery.gte('date', fromIso)
    if (toIso) expenseQuery = expenseQuery.lte('date', toIso)
    const { data: expenses, error: expenseError } = await expenseQuery
    if (expenseError) fail(expenseError, 'Không lấy được danh sách chi phí.')

    // 5. Tồn kho hiện tại
    const { data: ingredients, error: ingError } = await client.from('ingredients')
      .select('name, unit, stock, min_stock, cost_price')
      .eq('branch_id', branchId)
      .eq('is_active', true)
      .order('name', { ascending: true })
    if (ingError) fail(ingError, 'Không lấy được tồn kho.')

    const { data: branch } = await client.from('branches').select('name').eq('id', branchId).maybeSingle()
    const periodLabel = `${from ? fmtDate(fromIso) : 'Từ đầu'} - ${to ? fmtDate(toIso) : 'Nay'}`

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, overviewSheet(fin, periodLabel, str(branch?.name)), 'Tổng quan')
    XLSX.utils.book_append_sheet(wb, salesSheet(sales), 'Bán hàng')
    XLSX.utils.book_append_sheet(wb, shiftsSheet(recs), 'Kết ca')
    XLSX.utils.book_append_sheet(wb, expensesSheet(expenses ?? []), 'Chi phí')
    XLSX.utils.book_append_sheet(wb, inventorySheet(ingredients ?? []), 'Tồn kho')

    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'all')
    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="bao-cao_${day(fromIso)}_${day(toIso)}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    if (e instanceof HttpError) return json({ detail: e.message }, e.status)
    console.error('export-report', e)
    return json({ detail: 'Xuất Excel thất bại. Vui lòng thử lại.' }, 500)
  }
})
