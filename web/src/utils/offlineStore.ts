// Utility quản lý lưu trữ Offline và Queue đơn hàng chờ đồng bộ cho POS

export interface OfflineOrderItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  option_ids?: number[];
  note?: string;
  /** Món tặng: gửi kèm khi đồng bộ để DB ghi lý do + người tặng */
  comp?: boolean;
  comp_reason?: string;
}

/**
 * pending_sync / failed (lỗi mạng tạm thời) → tự đồng bộ lại.
 * rejected → server từ chối vì dữ liệu (tùy chọn ngừng dùng, voucher hết hạn,
 * lệch tiền...) — KHÔNG tự gửi lại; nhân viên xem lý do rồi thử lại hoặc bỏ đơn.
 */
export type OfflineOrderStatus = "pending_sync" | "syncing" | "synced" | "failed" | "rejected";

export interface OfflineOrder {
  local_id: string; // Mã đơn local, dùng làm offline_ref chống tạo trùng khi gửi lại
  created_at: string;
  customer_id?: number | null;
  customer_phone?: string;
  customer_name?: string;
  voucher_code?: string | null;
  table_id?: number;
  payment_method: string;
  total_amount: number;
  discount_amount: number;
  /** Số tiền thực thu của khách = total_amount - discount_amount */
  final_amount: number;
  items: OfflineOrderItem[];
  status: OfflineOrderStatus;
  error_message?: string;
}

/** Id đủ ngẫu nhiên để nhiều máy POS cùng chi nhánh không đụng nhau. */
export function newLocalId(prefix = "OFF"): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() // chỉ có trên https / localhost
      : Array.from(
          typeof crypto !== "undefined" && crypto.getRandomValues
            ? crypto.getRandomValues(new Uint8Array(16))
            : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
          (b) => b.toString(16).padStart(2, "0")
        ).join("");
  return `${prefix}-${uuid}`;
}

const PENDING_ORDERS_KEY = "melio_offline_pending_orders";
const CATALOG_CACHE_KEY = "melio_offline_catalog_cache";

/**
 * Lưu Cache Thực đơn, Sản phẩm, Bàn khi Online
 */
export function cacheCatalog(catalogData: {
  products: any[];
  categories?: any[];
  tables?: any[];
}) {
  if (typeof window === "undefined") return;
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      data: catalogData,
    };
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.error("Lỗi khi lưu Offline Catalog Cache:", err);
  }
}

/**
 * Lấy Cache Thực đơn khi Offline
 */
export function getCachedCatalog(): {
  products: any[];
  categories?: any[];
  tables?: any[];
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.data || null;
  } catch (err) {
    console.error("Lỗi khi đọc Offline Catalog Cache:", err);
    return null;
  }
}

/**
 * Lưu 1 đơn hàng tạo khi Offline vào Queue chờ đồng bộ
 */
export function saveOfflineOrder(orderInput: {
  customer_id?: number | null;
  customer_phone?: string;
  customer_name?: string;
  voucher_code?: string | null;
  table_id?: number;
  payment_method: string;
  total_amount: number;
  discount_amount: number;
  items: OfflineOrderItem[];
}): OfflineOrder {
  if (typeof window === "undefined") {
    throw new Error("Window environment is not available");
  }

  const newOrder: OfflineOrder = {
    local_id: newLocalId(),
    created_at: new Date().toISOString(),
    customer_id: orderInput.customer_id ?? null,
    customer_phone: orderInput.customer_phone,
    customer_name: orderInput.customer_name,
    voucher_code: orderInput.voucher_code ?? null,
    table_id: orderInput.table_id,
    payment_method: orderInput.payment_method,
    total_amount: orderInput.total_amount,
    discount_amount: orderInput.discount_amount,
    final_amount: Math.max(0, orderInput.total_amount - orderInput.discount_amount),
    items: orderInput.items,
    status: "pending_sync",
  };

  const currentOrders = getPendingOrders();
  currentOrders.push(newOrder);

  try {
    localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(currentOrders));
  } catch (err) {
    console.error("Lỗi khi lưu đơn hàng offline vào LocalStorage:", err);
  }

  return newOrder;
}

/**
 * Lấy danh sách toàn bộ các đơn hàng chưa đồng bộ
 */
export function getPendingOrders(): OfflineOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PENDING_ORDERS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as OfflineOrder[];
  } catch (err) {
    console.error("Lỗi khi đọc đơn hàng offline:", err);
    return [];
  }
}

/**
 * Cập nhật trạng thái của các đơn offline trong Queue
 */
export function updateOfflineOrdersStatus(
  localIds: string[],
  status: OfflineOrderStatus,
  errorMessage?: string
) {
  if (typeof window === "undefined") return;
  const orders = getPendingOrders();
  const updated = orders.map((ord) => {
    if (localIds.includes(ord.local_id)) {
      return { ...ord, status, error_message: errorMessage };
    }
    return ord;
  });
  localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(updated));
}

/**
 * Xóa danh sách các đơn đã đồng bộ thành công khỏi LocalStorage
 */
export function removeSyncedOrders(syncedLocalIds: string[]) {
  if (typeof window === "undefined") return;
  const orders = getPendingOrders();
  const remaining = orders.filter(
    (ord) => !syncedLocalIds.includes(ord.local_id) && ord.status !== "synced"
  );
  localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(remaining));
}

/** Bỏ hẳn một đơn offline khỏi hàng đợi (nhân viên xác nhận không đồng bộ nữa). */
export function discardOfflineOrder(localId: string) {
  if (typeof window === "undefined") return;
  const remaining = getPendingOrders().filter((ord) => ord.local_id !== localId);
  localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(remaining));
}
