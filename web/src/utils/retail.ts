/**
 * Nghiệp vụ bán lẻ (docs/retail-design.md). Hàng hóa = sản phẩm gắn 1:1 với một
 * dòng tồn kho, nên bán hàng / nhập hàng dùng lại RPC lõi (create_sales_order,
 * create_inventory_import) — DB giữ khóa chống bán âm và sổ cái kho.
 */
import { activeContext, supabase, toApiError } from "@/utils/api";
import { newLocalId } from "@/utils/offlineStore";

export type PayMethod = "cash" | "bank_transfer" | "momo" | "zalopay" | "vnpay" | "card";
export type ReturnCondition = "resell" | "damaged";

export const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  cash: "Tiền mặt", bank_transfer: "Chuyển khoản", card: "Thẻ", momo: "MoMo", zalopay: "ZaloPay", vnpay: "VNPay",
};
export const CONDITION_LABELS: Record<ReturnCondition, string> = {
  resell: "Còn bán được — nhập lại kho",
  damaged: "Hư / lỗi — không nhập kho",
};

export const vnd = (n: number | null | undefined) => `${Math.round(Number(n || 0)).toLocaleString("vi-VN")}đ`;
export const qty = (n: number | string | null | undefined) =>
  Number(n || 0).toLocaleString("vi-VN", { maximumFractionDigits: 3 });
export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "—";

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) toApiError(error);
  return data as T;
}

// ---------------------------------------------------------------------------
// Danh mục
// ---------------------------------------------------------------------------
export interface Goods {
  id: number;
  name: string;
  price: number;
  category: string;
  image_url: string | null;
  sku: string | null;
  barcode: string | null;
  is_active: boolean;
  stock_item_id: number;
  unit: string;
  stock: number;
  min_stock: number;
  /** null với thu ngân */
  cost_price: number | null;
  low_stock: boolean;
}

export async function getCatalog(includeInactive = false): Promise<Goods[]> {
  const { branchId } = await activeContext();
  const rows = await call<Goods[]>("retail_catalog", { p_branch_id: branchId, p_include_inactive: includeInactive });
  return (rows || []).map((g) => ({ ...g, stock: Number(g.stock), min_stock: Number(g.min_stock) }));
}

/** Mã quét được: khớp đúng mã vạch, rồi SKU (không phân biệt hoa thường). */
export function findByCode(catalog: Goods[], code: string): Goods | undefined {
  const c = code.trim();
  if (!c) return undefined;
  return catalog.find((g) => g.barcode === c) ?? catalog.find((g) => g.sku?.toLowerCase() === c.toLowerCase());
}

export interface GoodsInput {
  id?: number;
  name: string;
  category?: string;
  unit?: string;
  sku?: string | null;
  barcode?: string | null;
  min_stock?: number;
  image_url?: string | null;
  is_active?: boolean;
  price?: number;
  opening_stock?: number;
  opening_cost?: number;
}

export async function saveGoods(input: GoodsInput) {
  const { branchId } = await activeContext();
  return call<Goods>("save_goods_product", { p_branch_id: branchId, p_payload: input });
}

// ---------------------------------------------------------------------------
// Bán hàng
// ---------------------------------------------------------------------------
export type DiscountType = "amount" | "percentage";

export interface CartLine {
  product_id: number;
  quantity: number;
  /** Giảm tay theo dòng: amount = số tiền trên MỖI đơn vị, percentage = % đơn giá */
  discount_type?: DiscountType;
  discount_value?: number;
}

/** Xem trước giống app.plan_manual_discount (DB tính lại, không tin số này). */
export function unitDiscount(price: number, type: DiscountType | undefined, value: number | undefined) {
  const v = Number(value || 0);
  if (!type || v <= 0) return 0;
  return type === "percentage" ? Math.floor((price * Math.min(v, 100)) / 100) : Math.min(Math.floor(v), price);
}
export function orderDiscountAmount(subtotal: number, type: DiscountType | undefined, value: number | undefined) {
  const v = Number(value || 0);
  if (!type || v <= 0) return 0;
  return type === "percentage" ? Math.floor((subtotal * Math.min(v, 100)) / 100) : Math.min(Math.floor(v), subtotal);
}

export type CheckoutResult =
  | {
      status?: "completed";
      order_id: number;
      total_amount?: number;
      discount_amount?: number;
      final_amount?: number;
      manual_discount?: number;
      decision?: string;
      idempotent?: boolean;
    }
  | { status: "pending_approval"; request_id: number; required_level: "manager" | "owner"; amount: number };

/** Bán hàng bán lẻ: giảm giá tay đi qua rule duyệt, Σ thanh toán = phải trả (DB kiểm). */
export async function checkout(args: {
  lines: CartLine[];
  payments: { method: PayMethod; amount: number }[];
  customer_id?: number | null;
  voucher_code?: string | null;
  order_discount?: { type: DiscountType; value: number } | null;
  discount_reason?: string | null;
  discount_request_id?: number | null;
  offline_ref: string;
}) {
  const { branchId } = await activeContext();
  return call<CheckoutResult>("create_retail_sale", {
    p_branch_id: branchId,
    p_payload: {
      items: args.lines,
      payments: args.payments,
      customer_id: args.customer_id || null,
      voucher_code: args.voucher_code || null,
      order_discount: args.order_discount || null,
      discount_reason: args.discount_reason || null,
      discount_request_id: args.discount_request_id || null,
      offline_ref: args.offline_ref,
    },
  });
}

export interface Approver {
  id: string;
  name: string;
  role: "manager" | "owner";
}

export async function listDiscountApprovers(): Promise<Approver[]> {
  const { branchId } = await activeContext();
  return (await call<Approver[]>("list_discount_approvers", { p_branch_id: branchId })) || [];
}

export const approveDiscountWithPin = (requestId: number, approverId: string, pin: string) =>
  call<{ ok: boolean; attempts_left?: number; locked_until?: string | null; status?: string }>(
    "approve_discount_with_pin", { p_request_id: requestId, p_approver_id: approverId, p_pin: pin });

export async function getApprovalStatus(requestId: number): Promise<string | null> {
  const { data, error } = await supabase.from("approval_requests").select("status").eq("id", requestId).maybeSingle();
  if (error) toApiError(error);
  return (data?.status as string) ?? null;
}

export interface PendingApproval {
  id: number;
  entity_type: "refund" | "manual_discount" | string;
  entity_id: number | null;
  note: string | null;
  created_at: string;
  details: { required_level?: "manager" | "owner"; value?: number; payload?: Record<string, any> };
}

/** Yêu cầu chờ duyệt của shop: trả hàng / đổi hàng (refund) và giảm giá tay. */
export async function listPendingRetailApprovals(): Promise<PendingApproval[]> {
  const { branchId } = await activeContext();
  const { data, error } = await supabase
    .from("approval_requests")
    .select("id, entity_type, entity_id, note, created_at, details")
    .eq("branch_id", branchId)
    .eq("status", "pending")
    .in("entity_type", ["refund", "manual_discount"])
    .order("id", { ascending: false })
    .limit(30);
  if (error) toApiError(error);
  return (data || []) as PendingApproval[];
}

export const resolveRetailApproval = (requestId: number, approve: boolean) =>
  call<{ status: string }>("resolve_approval_request", { p_request_id: requestId, p_approve: approve, p_note: null });

// ---------------------------------------------------------------------------
// Đổi hàng một bước
// ---------------------------------------------------------------------------
export interface ExchangePayload {
  order_id: number;
  reason: string;
  return_lines: { order_item_id: number; quantity: number; condition: ReturnCondition }[];
  items: { product_id: number; quantity: number }[];
  payments?: { method: PayMethod; amount: number }[];
  offline_ref?: string;
}

export async function previewExchange(payload: Omit<ExchangePayload, "reason" | "payments" | "offline_ref">) {
  const { branchId } = await activeContext();
  return call<{ return_amount: number; sale_amount: number; difference: number; decision: string }>(
    "preview_goods_exchange", { p_branch_id: branchId, p_payload: payload });
}

export type ExchangeResult =
  | {
      status: "executed"; exchange_id: number; code: string; return_code: string; new_order_id: number;
      return_amount: number; sale_amount: number; difference: number; decision?: string;
    }
  | { status: "pending_approval"; request_id: number; required_level: string; amount: number };

export async function exchangeGoods(payload: ExchangePayload) {
  const { branchId } = await activeContext();
  return call<ExchangeResult>("exchange_goods", { p_branch_id: branchId, p_payload: payload });
}

export const newCheckoutRef = () => newLocalId("RTL");

export interface CustomerHit {
  id: number;
  name: string;
  phone: string;
  points: number;
  tier: string;
}

export async function findCustomer(phone: string): Promise<CustomerHit | null> {
  const p = phone.replace(/\D/g, "");
  if (p.length < 9) return null;
  const { branchId } = await activeContext();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, phone, points, tier")
    .eq("branch_id", branchId)
    .eq("phone", p)
    .maybeSingle();
  if (error) toApiError(error);
  return (data as CustomerHit) ?? null;
}

// ---------------------------------------------------------------------------
// Trả hàng
// ---------------------------------------------------------------------------
export interface ReturnableOrder {
  order_id: number;
  date: string;
  status: string;
  customer_name: string;
  total_amount: number;
  discount_amount: number;
  final_amount: number;
  refunded: number;
  pending_request: boolean;
  items: {
    order_item_id: number;
    product_id: number | null;
    name: string;
    quantity: number;
    unit_price: number;
    is_comp: boolean;
    returned: number;
    returnable: number;
  }[];
  returns: { id: number; code: string; amount: number; reason: string; created_at: string }[];
}

export async function getOrderForReturn(orderId: number) {
  const { branchId } = await activeContext();
  return call<ReturnableOrder>("order_for_return", { p_branch_id: branchId, p_order_id: orderId });
}

export type ReturnResult =
  | { status: "executed"; return_id: number; code: string; amount: number; decision: string }
  | { status: "pending_approval"; request_id: number; required_level: string; amount: number };

export async function returnGoods(payload: {
  order_id: number;
  reason: string;
  lines: { order_item_id: number; quantity: number; condition: ReturnCondition }[];
}) {
  const { branchId } = await activeContext();
  return call<ReturnResult>("return_goods", { p_branch_id: branchId, p_payload: payload });
}

export interface RecentReturn {
  id: number;
  code: string;
  order_id: number;
  amount: number;
  reason: string;
  created_at: string;
}

export async function listRecentReturns(): Promise<RecentReturn[]> {
  const { branchId } = await activeContext();
  const { data, error } = await supabase
    .from("sales_returns")
    .select("id, code, order_id, amount, reason, created_at")
    .eq("branch_id", branchId)
    .order("id", { ascending: false })
    .limit(20);
  if (error) toApiError(error);
  return (data || []) as RecentReturn[];
}

// ---------------------------------------------------------------------------
// Nhập hàng
// ---------------------------------------------------------------------------
export interface Supplier {
  id: number;
  name: string;
  total_debt: number;
}

export async function listSuppliers(): Promise<Supplier[]> {
  const { branchId } = await activeContext();
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name, total_debt")
    .eq("branch_id", branchId)
    .eq("is_active", true)
    .order("name");
  if (error) toApiError(error);
  return (data || []) as Supplier[];
}

export async function receiveGoods(args: {
  supplier_id: number | null;
  items: { stock_item_id: number; quantity: number; unit_cost: number }[];
  paid_amount: number;
  payment_method: PayMethod | null;
}) {
  const { branchId } = await activeContext();
  return call<{ import_id: number; total_amount: number; paid_amount: number; supplier_debt_delta: number }>(
    "create_inventory_import",
    {
      p_branch_id: branchId,
      p_payload: {
        supplier_id: args.supplier_id,
        items: args.items.map((i) => ({ ingredient_id: i.stock_item_id, quantity: i.quantity, unit_price: i.unit_cost })),
        paid_amount: args.paid_amount,
        payment_method: args.paid_amount > 0 ? args.payment_method : null,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Kiểm kê
// ---------------------------------------------------------------------------
export interface StocktakeResult {
  stocktake_id: number;
  code: string;
  changed: number;
  value: number;
  decision: string;
  applied: boolean;
}

export async function submitStocktake(note: string, lines: { product_id: number; counted: number }[]) {
  const { branchId } = await activeContext();
  return call<StocktakeResult>("submit_stocktake", { p_branch_id: branchId, p_payload: { note: note || null, lines } });
}

// ---------------------------------------------------------------------------
// Báo cáo
// ---------------------------------------------------------------------------
export interface RetailReport {
  gross_sales: number;
  orders: number;
  avg_basket: number;
  refunds: number;
  returns: number;
  net_revenue: number;
  cogs: number;
  gross_profit: number;
  top_products: { product_id: number; name: string; quantity: number; revenue: number }[];
  stock_value: number;
  low_stock: { product_id: number; name: string; stock: number; min_stock: number; unit: string }[];
}

export async function getRetailReport(from: string, to: string) {
  const { branchId } = await activeContext();
  return call<RetailReport>("get_retail_report", { p_branch_id: branchId, p_from: from, p_to: to });
}
