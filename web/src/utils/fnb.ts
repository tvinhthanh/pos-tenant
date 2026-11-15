/**
 * RPC / Edge Function của POS F&B mới (kế hoạch 1.1, 3.3, 3.4):
 *   - add_items_to_order  — gọi thêm món vào đơn nháp (bàn đang ngồi)
 *   - forecast_revenue    — dự báo doanh thu N ngày tới
 *   - export-report       — xuất báo cáo Excel 5 sheet
 * Lỗi ném ra cùng dạng với api.ts ({ response: { data: { detail } } }).
 */
import { activeContext, supabase, toApiError } from "@/utils/api";

const n = (v: unknown) => Number(v || 0);

// ---------------------------------------------------------------------------
// Gọi thêm món
// ---------------------------------------------------------------------------
export interface OrderLineInput {
  product_id: number;
  quantity: number;
  option_ids?: number[];
  comp?: boolean;
  comp_reason?: string;
}

export interface AddItemsResult {
  order_id: number;
  added_item_ids: number[];
  added_amount: number;
  total_amount: number;
  discount_amount: number;
  final_amount: number;
  status: "draft";
}

export async function addItemsToOrder(orderId: number, items: OrderLineInput[], sendToKitchen = false) {
  const { branchId } = await activeContext();
  const { data, error } = await supabase.rpc("add_items_to_order", {
    p_branch_id: branchId,
    p_order_id: orderId,
    p_items: items,
    p_send_to_kitchen: sendToKitchen,
  });
  if (error) toApiError(error);
  return {
    order_id: n(data?.order_id),
    added_item_ids: (data?.added_item_ids || []).map(n),
    added_amount: n(data?.added_amount),
    total_amount: n(data?.total_amount),
    discount_amount: n(data?.discount_amount),
    final_amount: n(data?.final_amount),
    status: "draft",
  } as AddItemsResult;
}

// ---------------------------------------------------------------------------
// Dự báo doanh thu
// ---------------------------------------------------------------------------
export interface ForecastPoint { day: string; revenue: number }
export interface RevenueForecast {
  days_used: number;
  enough_data: boolean;
  slope: number;
  history: ForecastPoint[];
  forecast: ForecastPoint[];
}

export async function getRevenueForecast(days = 7, historyDays = 56): Promise<RevenueForecast> {
  const { branchId } = await activeContext();
  const { data, error } = await supabase.rpc("forecast_revenue", {
    p_branch_id: branchId,
    p_days: days,
    p_history_days: historyDays,
  });
  if (error) toApiError(error);
  const points = (rows: any[]): ForecastPoint[] =>
    (rows || []).map((r) => ({ day: String(r.day), revenue: n(r.revenue) }));
  return {
    days_used: n(data?.days_used),
    enough_data: Boolean(data?.enough_data),
    slope: n(data?.slope),
    history: points(data?.history),
    forecast: points(data?.forecast),
  };
}

// ---------------------------------------------------------------------------
// Xuất Excel
// ---------------------------------------------------------------------------
/** Ngày địa phương YYYY-MM-DD → khoảng thời gian phủ trọn ngày (giống api.ts). */
const rangeStart = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const rangeEnd = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();

export async function exportReportExcel(startDate: string, endDate: string) {
  const { branchId } = await activeContext();
  const { data, error } = await supabase.functions.invoke("export-report", {
    body: { branch_id: branchId, from: rangeStart(startDate), to: rangeEnd(endDate) },
  });

  if (error) {
    // Edge Function trả lỗi dạng {detail}; supabase-js gói trong error.context
    let detail = error.message || "Xuất Excel thất bại.";
    const context = (error as any).context;
    if (context && typeof context.json === "function") {
      try {
        const parsed = await context.json();
        if (parsed?.detail) detail = parsed.detail;
      } catch {
        // giữ message gốc
      }
    }
    toApiError({ message: detail });
  }

  const blob = data instanceof Blob
    ? new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    : null;
  if (!blob || blob.size === 0) toApiError({ message: "Tệp Excel trả về rỗng." });

  const url = URL.createObjectURL(blob as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bao-cao_${startDate}_${endDate}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
