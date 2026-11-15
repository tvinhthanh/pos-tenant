// Shop đang làm việc (multi-shop, docs/multi-shop-design.md §1).
//
// Chỉ là lựa chọn giao diện: quyền thật do DB kiểm theo user_assignments ở từng
// RPC / policy. Đổi shop = ghi localStorage rồi tải lại trang để mọi cache
// react-query của shop cũ bị bỏ.

export type BusinessType = "fnb" | "retail" | "rental";
export type ShopRole = "owner" | "manager" | "staff" | "superadmin";

export interface MyShop {
  branch_id: number;
  organization_id: number;
  name: string;
  business_type: BusinessType;
  subdomain: string | null;
  role: ShopRole;
  is_active: boolean;
}

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  fnb: "Ăn uống (F&B)",
  retail: "Bán lẻ",
  rental: "Cho thuê",
};

export const SHOP_ROLE_LABELS: Record<ShopRole, string> = {
  owner: "Chủ cửa hàng",
  manager: "Quản lý",
  staff: "Nhân viên",
  superadmin: "Superadmin",
};

// Thuê bao POS cần có theo nghiệp vụ của shop.
export const POS_SERVICE_BY_TYPE: Record<BusinessType, string> = {
  fnb: "pos_fb",
  retail: "pos_retail",
  rental: "pos_rental",
};

const ACTIVE_SHOP_KEY = "pos_active_branch_id";

export function getStoredShopId(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_SHOP_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function storeShopId(branchId: number) {
  try {
    window.localStorage.setItem(ACTIVE_SHOP_KEY, String(branchId));
  } catch {
    // Trình duyệt chặn storage: vẫn chạy với shop mặc định của tài khoản.
  }
}

export function clearStoredShopId() {
  try {
    window.localStorage.removeItem(ACTIVE_SHOP_KEY);
  } catch {
    // bỏ qua
  }
}

/** Chọn shop đang dùng: shop đã lưu → shop chính của tài khoản → shop đầu tiên. */
export function pickActiveShop(shops: MyShop[], homeBranchId: number | null): MyShop | null {
  const stored = getStoredShopId();
  return (
    shops.find((s) => s.branch_id === stored) ??
    shops.find((s) => s.branch_id === homeBranchId) ??
    shops[0] ??
    null
  );
}

export function switchShop(branchId: number) {
  storeShopId(branchId);
  window.location.assign("/");
}

/** Chuẩn hóa subdomain giống app.normalize_subdomain (DB vẫn kiểm lại). */
export function normalizeSubdomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
