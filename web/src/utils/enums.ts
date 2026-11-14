// Giá trị enum của DB (app.payment_method, app.cashbook_type, app.adjustment_type…).
// Form phải gửi đúng mã; nhãn tiếng Việt chỉ để hiển thị.
// Nguồn: supabase/migrations/20260801000100_extensions_enums.sql

export type PaymentMethod =
  | "cash"
  | "bank_transfer"
  | "momo"
  | "zalopay"
  | "vnpay"
  | "card"
  | "debt";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Tiền mặt",
  bank_transfer: "Chuyển khoản",
  momo: "Momo",
  zalopay: "ZaloPay",
  vnpay: "VNPay",
  card: "Thẻ",
  debt: "Ghi nợ",
};

// Các phương thức quán thực sự dùng khi chi tiền / thu tiền ngoài POS.
export const CASH_PAYMENT_METHODS: PaymentMethod[] = ["cash", "bank_transfer"];

export function paymentMethodLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  return PAYMENT_METHOD_LABELS[value as PaymentMethod] || value;
}

export const ADJUSTMENT_TYPE_LABELS: Record<string, string> = {
  LOSS: "Thất thoát",
  DAMAGED: "Hư hỏng",
  EXPIRED: "Hết hạn",
  FOUND: "Kiểm dư",
};

export const ADJUSTMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Chờ duyệt",
  APPROVED: "Đã duyệt",
  REJECTED: "Từ chối",
};
