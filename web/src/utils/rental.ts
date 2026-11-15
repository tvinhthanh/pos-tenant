/**
 * Nghiệp vụ cho thuê (docs/rental-design.md). Mọi thao tác tiền / trạng thái đi
 * qua RPC — DB giữ bất biến R1–R8 và khóa chống chạy đua. Danh mục (món, giá,
 * unit) CRUD thẳng qua PostgREST, RLS chỉ cho quản lý trở lên của đúng shop.
 */
import { activeContext, supabase, toApiError } from "@/utils/api";

export type TrackingMode = "serialized" | "bulk" | "space";
export type RateUnit = "hour" | "day" | "week" | "month" | "flat";
export type UnitStatus = "available" | "out" | "maintenance" | "lost" | "retired";
export type ContractStatus = "reserved" | "active" | "returned" | "closed" | "cancelled";
export type LineStatus = "reserved" | "out" | "returned" | "lost" | "cancelled";
export type ChargeType = "rental" | "late" | "damage" | "loss" | "cleaning" | "sale" | "discount" | "waiver";
export type PayMethod = "cash" | "bank_transfer" | "momo" | "zalopay" | "vnpay" | "card";

export const TRACKING_LABELS: Record<TrackingMode, string> = {
  serialized: "Từng chiếc (áo, xe, máy…)",
  bulk: "Theo số lượng (ghế, bàn…)",
  space: "Phòng / chỗ tính giờ",
};
export const RATE_UNIT_LABELS: Record<RateUnit, string> = {
  hour: "giờ", day: "ngày", week: "tuần", month: "tháng", flat: "trọn gói",
};
export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  available: "Sẵn sàng", out: "Đang thuê", maintenance: "Bảo trì", lost: "Mất", retired: "Ngừng dùng",
};
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  reserved: "Đặt trước", active: "Đang thuê", returned: "Chờ tất toán", closed: "Đã tất toán", cancelled: "Đã hủy",
};
export const LINE_STATUS_LABELS: Record<LineStatus, string> = {
  reserved: "Đặt trước", out: "Đang thuê", returned: "Đã trả", lost: "Mất", cancelled: "Đã hủy",
};
export const CHARGE_LABELS: Record<ChargeType, string> = {
  rental: "Tiền thuê", late: "Phí trả trễ", damage: "Hư hỏng", loss: "Mất đồ", cleaning: "Vệ sinh",
  sale: "Bán kèm", discount: "Giảm giá", waiver: "Miễn phí",
};
export const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  cash: "Tiền mặt", bank_transfer: "Chuyển khoản", momo: "MoMo", zalopay: "ZaloPay", vnpay: "VNPay", card: "Thẻ",
};

export const vnd = (n: number | null | undefined) =>
  `${Math.round(Number(n || 0)).toLocaleString("vi-VN")}đ`;

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "—";

/** datetime-local (giờ máy) ⇄ ISO */
export function toLocalInput(d: Date): string {
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) toApiError(error);
  return data as T;
}

// ---------------------------------------------------------------------------
// Danh mục
// ---------------------------------------------------------------------------
export interface RentalRate {
  id: number;
  item_id: number;
  rate_unit: RateUnit;
  price: number;
  min_units: number;
  grace_minutes: number;
  cap_per_day: number | null;
  is_default: boolean;
}
export interface RentalUnit {
  id: number;
  item_id: number;
  code: string;
  status: UnitStatus;
  condition: string | null;
  attributes: Record<string, unknown>;
}
export interface RentalItem {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  tracking_mode: TrackingMode;
  bulk_quantity: number | null;
  deposit_amount: number;
  replacement_value: number;
  is_active: boolean;
  rental_rates: RentalRate[];
  rental_units: RentalUnit[];
}

export async function listRentalItems(includeInactive = false): Promise<RentalItem[]> {
  const { branchId } = await activeContext();
  let q = supabase
    .from("rental_items")
    .select("*, rental_rates(*), rental_units(*)")
    .eq("branch_id", branchId)
    .order("name");
  if (!includeInactive) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) toApiError(error);
  return (data || []) as RentalItem[];
}

export async function saveRentalItem(item: {
  id?: number;
  name: string;
  category?: string | null;
  description?: string | null;
  tracking_mode: TrackingMode;
  bulk_quantity?: number | null;
  deposit_amount: number;
  replacement_value: number;
  is_active?: boolean;
}) {
  const { branchId, organizationId } = await activeContext();
  const row = {
    name: item.name.trim(),
    category: item.category?.trim() || null,
    description: item.description?.trim() || null,
    tracking_mode: item.tracking_mode,
    bulk_quantity: item.tracking_mode === "bulk" ? item.bulk_quantity ?? 0 : null,
    deposit_amount: item.deposit_amount,
    replacement_value: item.replacement_value,
    is_active: item.is_active ?? true,
  };
  if (item.id) {
    // Không đổi kiểu theo dõi sau khi tạo (unit / dòng thuê cũ phụ thuộc vào nó)
    const { tracking_mode: _ignored, ...rest } = row;
    void _ignored;
    const { data, error } = await supabase.from("rental_items").update(rest).eq("id", item.id).select().single();
    if (error) toApiError(error);
    return data as RentalItem;
  }
  const { data, error } = await supabase
    .from("rental_items")
    .insert({ ...row, branch_id: branchId, organization_id: organizationId })
    .select()
    .single();
  if (error) toApiError(error);
  return data as RentalItem;
}

export async function saveRentalRate(rate: {
  id?: number;
  item_id: number;
  rate_unit: RateUnit;
  price: number;
  min_units: number;
  grace_minutes: number;
  cap_per_day: number | null;
  is_default: boolean;
}) {
  const { branchId, organizationId } = await activeContext();
  const row = { ...rate, cap_per_day: rate.rate_unit === "hour" ? rate.cap_per_day : null };
  const { error } = rate.id
    ? await supabase.from("rental_rates").update(row).eq("id", rate.id)
    : await supabase.from("rental_rates").insert({ ...row, branch_id: branchId, organization_id: organizationId });
  if (error) toApiError(error);
}

export async function deleteRentalRate(id: number) {
  const { error } = await supabase.from("rental_rates").delete().eq("id", id);
  if (error) toApiError(error);
}

export async function addRentalUnits(itemId: number, codes: string[]) {
  const { branchId, organizationId } = await activeContext();
  const rows = codes.map((code) => ({ item_id: itemId, code: code.trim(), branch_id: branchId, organization_id: organizationId }));
  const { error } = await supabase.from("rental_units").insert(rows);
  if (error) toApiError(error);
}

export async function setUnitStatus(unitId: number, status: UnitStatus, note?: string) {
  return call("set_rental_unit_status", { p_unit_id: unitId, p_status: status, p_note: note || null });
}

// ---------------------------------------------------------------------------
// Bảng unit / hợp đồng
// ---------------------------------------------------------------------------
export interface BoardUnit {
  unit_id: number;
  code: string;
  status: UnitStatus;
  item_id: number;
  item_name: string;
  category: string | null;
  tracking_mode: TrackingMode;
  current: null | { line_id: number; contract_id: number; code: string; customer: string; phone: string; since: string; due: string | null; overdue: boolean };
  next: null | { line_id: number; contract_id: number; code: string; customer: string; start: string; end: string | null };
}
export interface BoardBulk {
  item_id: number;
  item_name: string;
  category: string | null;
  total: number;
  out: number;
  overdue: number;
}

export async function getRentalBoard() {
  const { branchId } = await activeContext();
  return call<{ now: string; units: BoardUnit[]; bulk: BoardBulk[] }>("rental_board", { p_branch_id: branchId });
}

export interface ContractRow {
  id: number;
  code: string;
  status: ContractStatus;
  planned_start: string;
  planned_end: string | null;
  created_at: string;
  closed_at: string | null;
  customers: { name: string; phone: string } | null;
}

export async function listContracts(status: ContractStatus | "open" | "all", search = ""): Promise<ContractRow[]> {
  const { branchId } = await activeContext();
  let q = supabase
    .from("rental_contracts")
    .select("id, code, status, planned_start, planned_end, created_at, closed_at, customers(name, phone)")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (status === "open") q = q.in("status", ["reserved", "active", "returned"]);
  else if (status !== "all") q = q.eq("status", status);
  const term = search.trim();
  if (term) q = q.ilike("code", `%${term}%`);
  const { data, error } = await q;
  if (error) toApiError(error);
  return (data || []) as unknown as ContractRow[];
}

export interface Balance {
  charges: number;
  paid: number;
  deposit_received: number;
  deposit_applied: number;
  deposit_refunded: number;
  deposit_forfeited: number;
  deposit_held: number;
  due: number;
}
export interface ContractDetail {
  contract: {
    id: number; code: string; status: ContractStatus; planned_start: string; planned_end: string | null;
    notes: string | null; created_at: string; checked_out_at: string | null; returned_at: string | null;
    closed_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  };
  customer: { id: number; name: string; phone: string; id_number: string | null; id_type: string | null; address: string | null; is_blacklisted: boolean };
  lines: {
    id: number; item_id: number; item_name: string; unit_id: number | null; unit_code: string | null; quantity: number;
    status: LineStatus; start: string; end: string | null; checked_out_at: string | null; returned_at: string | null;
    return_condition: string | null; rate_unit: RateUnit; rate_price: number; deposit: number; replacement_value: number;
    overdue: boolean; fee_so_far: number | null;
  }[];
  charges: { id: number; line_id: number | null; type: ChargeType; amount: number; reason: string | null; created_at: string }[];
  deposits: { id: number; type: "received" | "applied" | "refunded" | "forfeited"; amount: number; method: PayMethod | null; created_at: string }[];
  payments: { id: number; method: PayMethod; amount: number; created_at: string }[];
  collateral: { id: number; kind: string; description: string | null; received_at: string; returned_at: string | null }[];
  pending_approvals: { id: number; type: "charge_waiver" | "deposit_forfeit"; value: number; required_level: "manager" | "owner" }[];
  balance: Balance;
}

export const getContractDetail = (contractId: number) =>
  call<ContractDetail>("rental_contract_detail", { p_contract_id: contractId });

export async function quoteRental(itemId: number, start: string, end: string | null, quantity: number, rateUnit?: RateUnit) {
  const { branchId } = await activeContext();
  return call<{ rate_unit: RateUnit; price: number; units: number; amount: number; deposit: number }>("rental_quote", {
    p_branch_id: branchId, p_item_id: itemId, p_start: start, p_end: end, p_quantity: quantity, p_rate_unit: rateUnit ?? null,
  });
}

export async function getAvailability(itemId: number, start: string, end: string | null) {
  const { branchId } = await activeContext();
  return call<{ tracking_mode: TrackingMode; total: number; free_quantity?: number; free_units?: { id: number; code: string; status: UnitStatus }[] }>(
    "rental_availability",
    { p_branch_id: branchId, p_item_id: itemId, p_start: start, p_end: end ?? "infinity" },
  );
}

export interface NewRentalPayload {
  customer_id?: number;
  customer?: { name: string; phone: string; id_number?: string; id_type?: string; address?: string };
  checkout: boolean;
  lines: { item_id: number; unit_id?: number | null; quantity?: number; rate_unit?: RateUnit; start?: string | null; end?: string | null }[];
  deposit?: { amount: number; method: PayMethod };
  collateral?: { kind: string; description?: string }[];
  notes?: string;
}

export async function createRental(payload: NewRentalPayload) {
  const { branchId } = await activeContext();
  return call<{ contract_id: number; code: string; status: ContractStatus }>("create_rental", {
    p_branch_id: branchId, p_payload: payload,
  });
}

export async function findCustomerByPhone(phone: string) {
  const { branchId } = await activeContext();
  const clean = phone.replace(/[^0-9+]/g, "");
  if (clean.length < 8) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, phone, id_number, id_type, address, is_blacklisted, blacklist_reason")
    .eq("branch_id", branchId)
    .eq("phone", clean)
    .maybeSingle();
  if (error) toApiError(error);
  return data as null | {
    id: number; name: string; phone: string; id_number: string | null; id_type: string | null;
    address: string | null; is_blacklisted: boolean; blacklist_reason: string | null;
  };
}

export const checkOutRental = (contractId: number) => call("check_out_rental", { p_contract_id: contractId });
export const extendRental = (lineId: number, newEnd: string) => call("extend_rental", { p_line_id: lineId, p_new_end: newEnd });
export const returnRental = (
  contractId: number,
  returns: { line_id: number; condition: "ok" | "damaged" | "lost"; damage_amount?: number; note?: string }[],
) => call<{ status: ContractStatus; balance: Balance }>("return_rental", { p_contract_id: contractId, p_payload: { returns } });
export const settleRental = (
  contractId: number,
  payload: { payments: { method: PayMethod; amount: number }[]; apply_deposit: boolean; refund_method: PayMethod },
) => call("settle_rental", { p_contract_id: contractId, p_payload: payload });
export const cancelRental = (contractId: number, payload: { reason: string; forfeit_amount: number; refund_method: PayMethod }) =>
  call<{ status: string }>("cancel_rental", { p_contract_id: contractId, p_payload: payload });
export const addRentalCharge = (
  contractId: number,
  payload: { type: ChargeType; amount: number; reason?: string; line_id?: number | null },
) => call<{ status: string }>("add_rental_charge", { p_contract_id: contractId, p_payload: payload });
export const resolveApproval = (requestId: number, approve: boolean, note?: string) =>
  call("resolve_approval_request", { p_request_id: requestId, p_approve: approve, p_note: note || null });

export async function getRentalReport(from: string, to: string) {
  const { branchId } = await activeContext();
  return call<{
    revenue: number; revenue_by_type: Partial<Record<ChargeType, number>>; contracts_closed: number;
    deposit_liability: number;
    overdue: { contract_id: number; code: string; customer: string; phone: string; item: string; due: string }[];
    utilization: { item_id: number; item: string; percent: number }[];
  }>("get_rental_report", { p_branch_id: branchId, p_from: from, p_to: to });
}
