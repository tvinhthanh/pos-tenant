/** Hàm dùng chung giữa trang POS và các tab con của nó. */

export const PAYMENT_METHODS = [
  { value: "cash", label: "Tiền mặt" },
  { value: "bank_transfer", label: "Chuyển khoản" },
  { value: "momo", label: "Momo" },
  { value: "zalopay", label: "ZaloPay" },
];

export const paymentLabel = (value: string) =>
  PAYMENT_METHODS.find((method) => method.value === value)?.label || value;

export const orderItemCount = (order: any) =>
  (order?.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0);

export const pendingKitchenItemCount = (order: any) =>
  (order?.items || [])
    .filter((item: any) => item.status !== "served")
    .reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0);
