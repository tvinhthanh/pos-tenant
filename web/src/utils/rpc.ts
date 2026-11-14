/**
 * Gọi thẳng RPC Supabase, có kiểu dữ liệu.
 *
 * Code mới dùng file này thay vì thêm nhánh `if (path === "/api/v1/...")` vào
 * api.ts (lớp giả REST còn lại từ bản FastAPI cũ). Lỗi ném ra cùng dạng với
 * api.ts ({ response: { data: { detail } } }) nên các màn hình xử lý giống nhau.
 */
import { activeContext, supabase, toApiError } from "@/utils/api";
import { normalizeVietnameseText } from "@/utils/text";

const n = (v: unknown) => Number(v || 0);
const s = (v: unknown) => (v == null ? "" : normalizeVietnameseText(v));

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) toApiError(error);
  return data as T;
}

// ---------------------------------------------------------------------------
// Đổi giá gốc món
// ---------------------------------------------------------------------------
export interface PriceChangeResult {
  request_id: number;
  status: "approved" | "pending";
  applied: boolean;
}

export async function changeProductPrice(productId: number, newPrice: number, reason?: string) {
  const { branchId } = await activeContext();
  return call<PriceChangeResult>("change_product_price", {
    p_branch_id: branchId,
    p_product_id: productId,
    p_new_price: Math.round(newPrice),
    p_reason: reason || null,
  });
}

export interface PriceRequest {
  id: number;
  product_id: number;
  product_name: string;
  old_price: number;
  new_price: number;
  reason: string;
  requested_by: string;
  created_at: string;
}

export async function listPriceRequests(): Promise<PriceRequest[]> {
  const { branchId } = await activeContext();
  const rows = await call<any[]>("list_price_change_requests", { p_branch_id: branchId });
  return (rows || []).map((r) => ({
    id: n(r.id),
    product_id: n(r.product_id),
    product_name: s(r.product_name),
    old_price: n(r.old_price),
    new_price: n(r.new_price),
    reason: s(r.reason),
    requested_by: s(r.requested_by),
    created_at: String(r.created_at),
  }));
}

export async function resolvePriceRequest(requestId: number, approved: boolean) {
  return call<unknown>("approve_price_change", {
    p_request_id: requestId,
    p_approved: approved,
    p_note: approved ? "Duyệt từ trang Thực đơn" : "Từ chối từ trang Thực đơn",
  });
}

// ---------------------------------------------------------------------------
// Thông tin quán in trên hóa đơn
// ---------------------------------------------------------------------------
export interface BranchProfile {
  receipt_name: string;
  receipt_tagline: string;
  address: string;
  receipt_landmark: string;
  phone: string;
  receipt_footer: string;
  receipt_slogan: string;
  logo_url: string;
  bank_bin: string;
  bank_account_no: string;
  bank_account_name: string;
}

export const EMPTY_BRANCH_PROFILE: BranchProfile = {
  receipt_name: "",
  receipt_tagline: "",
  address: "",
  receipt_landmark: "",
  phone: "",
  receipt_footer: "",
  receipt_slogan: "",
  logo_url: "",
  bank_bin: "",
  bank_account_no: "",
  bank_account_name: "",
};

export async function getBranchProfile(): Promise<BranchProfile & { organization_name: string }> {
  const { branchId, organizationId } = await activeContext();
  const [{ data: branch, error }, { data: org }] = await Promise.all([
    supabase
      .from("branches")
      .select("receipt_name, receipt_tagline, address, receipt_landmark, phone, receipt_footer, receipt_slogan, logo_url, bank_bin, bank_account_no, bank_account_name")
      .eq("id", branchId)
      .single(),
    supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
  ]);
  if (error) toApiError(error);
  const profile = { ...EMPTY_BRANCH_PROFILE };
  (Object.keys(profile) as (keyof BranchProfile)[]).forEach((k) => {
    profile[k] = s((branch as any)?.[k]);
  });
  return { ...profile, organization_name: s(org?.name) };
}

export async function updateBranchProfile(payload: Partial<BranchProfile>) {
  const { branchId } = await activeContext();
  return call<unknown>("update_branch_profile", { p_branch_id: branchId, p_payload: payload });
}

// ---------------------------------------------------------------------------
// Thống kê bán hàng (dùng cho trang Tổng quan)
// ---------------------------------------------------------------------------
export interface SalesDay {
  day: string;
  orders: number;
  revenue: number;
  quantity: number;
  top_product: string | null;
  top_quantity: number;
}
export interface SalesProduct {
  product_name: string;
  category: string;
  quantity: number;
  revenue: number;
}

export async function getSalesSummary(fromIso: string, toIso: string): Promise<{ days: SalesDay[]; products: SalesProduct[] }> {
  const { branchId } = await activeContext();
  const data = await call<any>("get_sales_breakdown", { p_branch_id: branchId, p_from: fromIso, p_to: toIso });
  return {
    days: (data?.days || []).map((d: any): SalesDay => ({
      day: String(d.day),
      orders: n(d.orders),
      revenue: n(d.revenue),
      quantity: n(d.quantity),
      top_product: d.top_product ? s(d.top_product) : null,
      top_quantity: n(d.top_quantity),
    })),
    products: (data?.products || []).map((p: any): SalesProduct => ({
      product_name: s(p.product_name),
      category: s(p.category),
      quantity: n(p.quantity),
      revenue: n(p.revenue),
    })),
  };
}

// ---------------------------------------------------------------------------
// VietQR: ảnh QR chuyển khoản thật (chuẩn NAPAS) — app ngân hàng nào cũng quét được
// ---------------------------------------------------------------------------
/** Ngân hàng phổ biến (mã BIN NAPAS). Chủ quán chọn ở trang Thông tin quán. */
export const BANKS: { bin: string; name: string }[] = [
  { bin: "970436", name: "Vietcombank" },
  { bin: "970415", name: "VietinBank" },
  { bin: "970418", name: "BIDV" },
  { bin: "970405", name: "Agribank" },
  { bin: "970407", name: "Techcombank" },
  { bin: "970422", name: "MB Bank" },
  { bin: "970416", name: "ACB" },
  { bin: "970432", name: "VPBank" },
  { bin: "970423", name: "TPBank" },
  { bin: "970403", name: "Sacombank" },
  { bin: "970441", name: "VIB" },
  { bin: "970437", name: "HDBank" },
  { bin: "970443", name: "SHB" },
  { bin: "970426", name: "MSB" },
  { bin: "970448", name: "OCB" },
  { bin: "970440", name: "SeABank" },
  { bin: "970431", name: "Eximbank" },
  { bin: "970449", name: "LPBank" },
  { bin: "970428", name: "Nam A Bank" },
  { bin: "970409", name: "Bac A Bank" },
  { bin: "546034", name: "CAKE by VPBank" },
  { bin: "963388", name: "Timo" },
];

/** Bỏ dấu tiếng Việt: nội dung chuyển khoản nhiều ngân hàng không nhận dấu. */
export const stripAccents = (v: string) =>
  v.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D");

/** null khi quán chưa cài tài khoản nhận tiền. */
export function vietQrUrl(profile: Pick<BranchProfile, "bank_bin" | "bank_account_no" | "bank_account_name">, amount: number, note: string) {
  if (!profile.bank_bin || !profile.bank_account_no) return null;
  const params = new URLSearchParams({
    amount: String(Math.max(0, Math.round(amount))),
    addInfo: stripAccents(note).slice(0, 25),
    accountName: stripAccents(profile.bank_account_name || ""),
  });
  return `https://img.vietqr.io/image/${profile.bank_bin}-${encodeURIComponent(profile.bank_account_no)}-compact2.png?${params}`;
}
