import {
  LayoutDashboard, ShoppingCart, Package, DollarSign, Users, BarChart3, User,
  Map, History, Megaphone, Scale, Store, UtensilsCrossed, Settings,
  LayoutGrid, FileText, Boxes, PieChart, Undo2, PackagePlus, ClipboardCheck, Globe, Inbox,
  CalendarDays, type LucideIcon,
} from "lucide-react";
import type { BusinessType } from "@/utils/shop";

// Menu dùng chung cho Sidebar và ô "Tìm nhanh" trên Header — một nguồn duy nhất
// để hai chỗ luôn khớp quyền.

// Màn hình chỉ có nghĩa với một số nghiệp vụ. Không có trong bảng = mọi nghiệp vụ.
// (Chỉ ẩn menu; DB tự chặn RPC sai nghiệp vụ trong app.assert_service.)
const PATHS_BY_BUSINESS: Record<string, BusinessType[]> = {
  "/tables": ["fnb"],
  "/pos": ["fnb"],
  "/menu": ["fnb"],
  "/inventory": ["fnb"],
  "/inventory/adjustments": ["fnb", "retail"],
  "/suppliers": ["fnb", "retail"],
  "/rental": ["rental"],
  "/rental/contracts": ["rental"],
  "/rental/catalog": ["rental"],
  "/rental/calendar": ["rental"],
  "/rental/report": ["rental"],
  "/retail": ["retail"],
  "/retail/returns": ["retail"],
  "/retail/products": ["retail"],
  "/retail/receive": ["retail"],
  "/retail/stocktake": ["retail"],
  "/retail/report": ["retail"],
};

// Màn nhân viên (thu ngân) được vào, theo nghiệp vụ. RoleLayout dùng cùng hàm này.
const STAFF_PATHS: Partial<Record<BusinessType, string[]>> = {
  fnb: ["/pos", "/online"],
  retail: ["/retail", "/retail/returns", "/retail/stocktake", "/online"],
};
export const staffCanOpen = (type: BusinessType | null | undefined, path: string) => {
  if (type === "rental") return (path.startsWith("/rental") && !path.startsWith("/rental/report")) || path === "/online";
  return (STAFF_PATHS[type ?? "fnb"] ?? []).includes(path);
};

export type NavItem = { name: string; path: string; icon: LucideIcon };
export type NavGroup = { title: string; items: NavItem[] };

/** Nhóm menu mà người dùng này được thấy (đã lọc theo vai trò và nghiệp vụ shop). */
export function getNavGroups(role: string | undefined, businessType: BusinessType | null | undefined): NavGroup[] {
  const type: BusinessType = businessType ?? "fnb";
  if (role === "superadmin") {
    return [{
      title: "SaaS Admin",
      items: [
        { name: "Cửa hàng & Chủ tiệm", path: "/superadmin/stores", icon: Store },
        { name: "Thống kê hệ thống", path: "/superadmin/stats", icon: BarChart3 },
        { name: "Audit logs", path: "/superadmin/audit-logs", icon: History },
      ],
    }];
  }

  // Quản lý một shop cũng được tạo tài khoản staff cho shop đó.
  const canManageUsers = role === "owner" || role === "manager";
  const isStaff = role === "staff";
  const allowed = (path: string) =>
    (!PATHS_BY_BUSINESS[path] || PATHS_BY_BUSINESS[path].includes(type)) &&
    (!isStaff || staffCanOpen(type, path));

  const groups: NavGroup[] = [
    {
      title: "Quản lý quán",
      items: [
        { name: "Tổng quan", path: "/", icon: LayoutDashboard },
        { name: "Khu vực & Bàn", path: "/tables", icon: Map },
        ...(canManageUsers ? [{ name: "Nhân viên", path: "/users", icon: User }] : []),
        ...(canManageUsers ? [{ name: "Website", path: "/website", icon: Globe }] : []),
        { name: "Đơn online", path: "/online", icon: Inbox },
        { name: "Thông tin quán", path: "/settings", icon: Settings },
      ],
    },
    {
      title: type === "rental" ? "Cho thuê" : "Bán hàng & Kho",
      items: [
        { name: "Bảng cho thuê", path: "/rental", icon: LayoutGrid },
        { name: "Hợp đồng thuê", path: "/rental/contracts", icon: FileText },
        { name: "Lịch cho thuê", path: "/rental/calendar", icon: CalendarDays },
        { name: "Danh mục cho thuê", path: "/rental/catalog", icon: Boxes },
        { name: "Bán hàng", path: "/retail", icon: ShoppingCart },
        { name: "Trả hàng", path: "/retail/returns", icon: Undo2 },
        { name: "Sản phẩm", path: "/retail/products", icon: Package },
        { name: "Nhập hàng", path: "/retail/receive", icon: PackagePlus },
        { name: "Kiểm kê", path: "/retail/stocktake", icon: ClipboardCheck },
        { name: "POS Bán hàng", path: "/pos", icon: ShoppingCart },
        { name: "Thực đơn & Tùy chọn", path: "/menu", icon: UtensilsCrossed },
        { name: "Kho & Định lượng", path: "/inventory", icon: Package },
        { name: "Điều chỉnh kho", path: "/inventory/adjustments", icon: Scale },
      ],
    },
    {
      title: "Tài chính & Đối tác",
      items: [
        { name: "Chi phí & Sổ quỹ", path: "/expenses", icon: DollarSign },
        { name: "Công nợ & NCC", path: "/suppliers", icon: Users },
        { name: "Marketing & Loyalty", path: "/marketing", icon: Megaphone },
      ],
    },
    {
      title: "Báo cáo",
      items: [
        { name: "Báo cáo cho thuê", path: "/rental/report", icon: PieChart },
        { name: "Báo cáo bán lẻ", path: "/retail/report", icon: PieChart },
        { name: "Báo cáo & Thuế", path: "/reports", icon: BarChart3 },
        { name: "Lịch sử ca", path: "/shifts", icon: History },
      ],
    },
  ];

  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.path)) }))
    .filter((g) => g.items.length > 0);
}

// Tiêu đề trang trên Header. Lấy từ menu (mọi vai trò/nghiệp vụ) + vài trang không có trong menu.
const EXTRA_TITLES: Record<string, string> = { "/rental/new": "Thuê mới" };
const ALL_TITLES: Record<string, string> = Object.fromEntries(
  [
    ...getNavGroups("owner", "fnb"), ...getNavGroups("owner", "retail"), ...getNavGroups("owner", "rental"),
    ...getNavGroups("superadmin", null),
  ].flatMap((g) => g.items.map((i) => [i.path, i.name] as const)),
);
export const pageTitle = (path: string) => EXTRA_TITLES[path] ?? ALL_TITLES[path] ?? "Hệ thống";

/** Bỏ dấu + chữ thường để tìm "bao cao" ra "Báo cáo". */
export const foldVietnamese = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();
