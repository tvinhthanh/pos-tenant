"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard, ShoppingCart, Package, DollarSign,
  Users, BarChart3, LogOut, Coffee, ShieldCheck, User, X,
  Map, History, Megaphone, Scale, Store, UtensilsCrossed, Settings,
  LayoutGrid, FileText, Boxes, PieChart
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import api, { supabase } from "@/utils/api";
import { getBranchProfile } from "@/utils/rpc";
import { BUSINESS_TYPE_LABELS, type BusinessType } from "@/utils/shop";

// Màn hình chỉ có nghĩa với một số nghiệp vụ. Không có trong bảng = mọi nghiệp vụ.
// (Chỉ ẩn menu; DB tự chặn RPC sai nghiệp vụ trong app.assert_service.)
const PATHS_BY_BUSINESS: Record<string, BusinessType[]> = {
  "/tables": ["fnb"],
  "/pos": ["fnb", "retail"],
  "/menu": ["fnb", "retail"],
  "/inventory": ["fnb", "retail"],
  "/inventory/adjustments": ["fnb", "retail"],
  "/suppliers": ["fnb", "retail"],
  "/rental": ["rental"],
  "/rental/contracts": ["rental"],
  "/rental/catalog": ["rental"],
  "/rental/report": ["rental"],
};

interface SidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

export default function Sidebar({ isOpen, setIsOpen }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<{
    full_name: string | null;
    role: string;
    business_type?: BusinessType | null;
    shop_name?: string | null;
  } | null>(null);

  useEffect(() => {
    api.get("/api/v1/auth/me")
      .then((res) => setUser(res.data))
      .catch(() => setUser(null));
  }, []);

  const handleLogout = async () => {
    // Xóa token cục bộ thôi là chưa đủ: phiên Supabase vẫn còn trong localStorage
    // và refresh token vẫn hợp lệ cho tới khi hết hạn.
    await supabase.auth.signOut().catch(() => undefined);
    localStorage.removeItem("melio_token");
    router.push("/");
    window.location.reload();
  };

  const isOwner = user?.role === "owner" || user?.role === "superadmin";
  const isSuperadmin = user?.role === "superadmin";
  // Quản lý một shop cũng được tạo tài khoản staff cho shop đó.
  const canManageUsers = isOwner || user?.role === "manager";
  const businessType: BusinessType = user?.business_type ?? "fnb";
  const isStaff = user?.role === "staff";
  // Nhân viên shop cho thuê chỉ làm việc trong các màn hình cho thuê (RoleLayout cũng chặn).
  const allowedHere = (path: string) =>
    (!PATHS_BY_BUSINESS[path] || PATHS_BY_BUSINESS[path].includes(businessType)) &&
    (!isStaff || (path.startsWith("/rental") && path !== "/rental/report"));

  // Tên quán lấy từ trang "Thông tin quán" (hoặc tên cửa hàng), không viết cứng
  const { data: branchProfile } = useQuery({
    queryKey: ["branchProfile"],
    queryFn: getBranchProfile,
    enabled: Boolean(user) && !isSuperadmin,
  });
  const storeName = isSuperadmin
    ? "POS Admin"
    : branchProfile?.receipt_name || user?.shop_name || branchProfile?.organization_name || "POS";

  const navGroups = isSuperadmin ? [
    {
      title: "SaaS Admin",
      items: [
        { name: "Cửa hàng & Chủ tiệm", path: "/superadmin/stores", icon: Store },
        { name: "Thống kê hệ thống", path: "/superadmin/stats", icon: BarChart3 },
        { name: "Audit logs", path: "/superadmin/audit-logs", icon: History },
      ]
    }
  ] : [
    {
      title: "Quản lý quán",
      items: [
        { name: "Tổng quan", path: "/", icon: LayoutDashboard },
        { name: "Khu vực & Bàn", path: "/tables", icon: Map },
        ...(canManageUsers ? [{ name: "Nhân viên", path: "/users", icon: User }] : []),
        { name: "Thông tin quán", path: "/settings", icon: Settings },
      ]
    },
    {
      title: businessType === "rental" ? "Cho thuê" : "Bán hàng & Kho",
      items: [
        { name: "Bảng cho thuê", path: "/rental", icon: LayoutGrid },
        { name: "Hợp đồng thuê", path: "/rental/contracts", icon: FileText },
        { name: "Danh mục cho thuê", path: "/rental/catalog", icon: Boxes },
        { name: "POS Bán hàng", path: "/pos", icon: ShoppingCart },
        { name: businessType === "retail" ? "Sản phẩm" : "Thực đơn & Tùy chọn", path: "/menu", icon: UtensilsCrossed },
        { name: "Kho & Định lượng", path: "/inventory", icon: Package },
        { name: "Điều chỉnh kho", path: "/inventory/adjustments", icon: Scale },
      ]
    },
    {
      title: "Tài chính & Đối tác",
      items: [
        { name: "Chi phí & Sổ quỹ", path: "/expenses", icon: DollarSign },
        { name: "Công nợ & NCC", path: "/suppliers", icon: Users },
        { name: "Marketing & Loyalty", path: "/marketing", icon: Megaphone },
      ]
    },
    {
      title: "Báo cáo",
      items: [
        { name: "Báo cáo cho thuê", path: "/rental/report", icon: PieChart },
        { name: "Báo cáo & Thuế", path: "/reports", icon: BarChart3 },
        { name: "Lịch sử ca", path: "/shifts", icon: History },
      ]
    }
  ];

  return (
    <aside 
      className={`w-64 bg-slate-950 border-r border-slate-900 h-screen fixed left-0 top-0 flex flex-col justify-between z-50 transition-transform duration-300 ease-in-out lg:translate-x-0 ${
        isOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex flex-col flex-1 overflow-y-auto">
        {/* Brand Logo & Close Button (mobile) */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-900">
          <div className="flex items-center space-x-3">
            <div className="bg-gradient-to-tr from-indigo-500 to-violet-600 p-2 rounded-xl shadow-lg shadow-indigo-500/20">
              <Coffee className="w-5.5 h-5.5 text-white" />
            </div>
            <div>
              <span className="text-base font-bold tracking-tight text-slate-100 block truncate max-w-[9.5rem]" title={storeName}>{storeName}</span>
              <span className="text-[10px] text-indigo-400 font-medium tracking-wide">
                {isSuperadmin ? "SaaS Administration" : BUSINESS_TYPE_LABELS[businessType]}
              </span>
            </div>
          </div>

          <button
            onClick={() => setIsOpen(false)}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-900 hover:text-white lg:hidden"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation List */}
        <nav className="mt-6 px-4 space-y-6 flex-1">
          {navGroups
            .map((group) => ({ ...group, items: group.items.filter((item) => allowedHere(item.path)) }))
            .filter((group) => group.items.length > 0)
            .map((group) => (
            <div key={group.title} className="space-y-2">
              <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest px-3.5 block">
                {group.title}
              </span>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.path;
                  return (
                    <Link 
                      key={item.path} 
                      href={item.path}
                      onClick={() => setIsOpen(false)}
                      className={`flex items-center space-x-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200 relative group ${
                        isActive 
                          ? "bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-600/20 active-tab-glow" 
                          : "text-slate-400 hover:text-slate-100 hover:bg-slate-900/60"
                      }`}
                    >
                      {/* Active Indicator Line */}
                      {isActive && (
                        <span className="absolute left-0 top-2.5 bottom-2.5 w-1 bg-white rounded-r-full" />
                      )}
                      <Icon className={`w-4.5 h-4.5 ${isActive ? "text-white" : "text-slate-400 group-hover:text-slate-100"}`} />
                      <span>{item.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      {/* User Session Box */}
      <div className="p-4 border-t border-slate-900">
        {user && (
          <div className="flex items-center space-x-3 px-3 py-2.5 bg-slate-900/30 rounded-xl border border-slate-900/50 mb-3">
            <div className="bg-slate-900 p-1.5 rounded-lg border border-slate-800">
              {user.role === "owner" || user.role === "superadmin" ? (
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
              ) : (
                <User className="w-4 h-4 text-indigo-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-bold text-slate-200 block truncate">{user.full_name?.trim() || "Người dùng"}</span>
              <span className="text-[10px] text-slate-500 font-semibold capitalize mt-0.5 block">{user.role}</span>
            </div>
          </div>
        )}
        <button 
          onClick={handleLogout}
          className="w-full flex items-center space-x-3 px-3.5 py-2.5 text-xs font-bold text-rose-400 hover:bg-rose-500/10 rounded-xl transition-all duration-200"
        >
          <LogOut className="w-4.5 h-4.5" />
          <span>Đăng xuất</span>
        </button>
      </div>
    </aside>
  );
}
