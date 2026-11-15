"use client";

import React, { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, Bell, Search, User, ShieldCheck } from "lucide-react";
import api from "@/utils/api";
import type { MyShop } from "@/utils/shop";
import { SHOP_ROLE_LABELS, type ShopRole } from "@/utils/shop";
import ThemeToggle from "./ThemeToggle";
import ShopSwitcher from "./ShopSwitcher";

interface HeaderProps {
  onMenuToggle: () => void;
}

export default function Header({ onMenuToggle }: HeaderProps) {
  const pathname = usePathname();
  const [user, setUser] = useState<{
    full_name: string | null;
    role: string;
    branch_id?: number;
    shops?: MyShop[];
    is_org_owner?: boolean;
  } | null>(null);
  const [hasNotifications, setHasNotifications] = useState(true);

  useEffect(() => {
    api.get("/api/v1/auth/me")
      .then((res) => setUser(res.data))
      .catch(() => setUser(null));
  }, []);

  // Map path to friendly page name
  const getPageTitle = () => {
    switch (pathname) {
      case "/":
        return "Tổng quan";
      case "/pos":
        return "POS Bán hàng";
      case "/inventory":
        return "Kho & Định lượng";
      case "/inventory/adjustments":
        return "Điều chỉnh kho";
      case "/expenses":
        return "Chi phí & Sổ quỹ";
      case "/suppliers":
        return "Công nợ & NCC";
      case "/reports":
        return "Báo cáo & Thuế";
      case "/menu":
        return "Thực đơn & Tùy chọn";
      case "/settings":
        return "Thông tin quán";
      case "/users":
        return "Nhân viên";
      case "/tables":
        return "Khu vực & Bàn";
      case "/shifts":
        return "Lịch sử ca";
      case "/rental":
        return "Bảng cho thuê";
      case "/rental/new":
        return "Thuê mới";
      case "/rental/contracts":
        return "Hợp đồng thuê";
      case "/rental/catalog":
        return "Danh mục cho thuê";
      case "/rental/report":
        return "Báo cáo cho thuê";
      case "/retail":
        return "Bán hàng";
      case "/retail/returns":
        return "Trả hàng";
      case "/retail/products":
        return "Sản phẩm";
      case "/retail/receive":
        return "Nhập hàng";
      case "/retail/stocktake":
        return "Kiểm kê";
      case "/retail/report":
        return "Báo cáo bán lẻ";
      case "/marketing":
        return "Marketing & Loyalty";
      case "/superadmin/stores":
        return "Cửa hàng & Chủ tiệm";
      case "/superadmin/stats":
        return "Thống kê hệ thống";
      case "/superadmin/audit-logs":
        return "Audit logs";
      default:
        return "Hệ thống";
    }
  };

  // profiles.full_name cho phép null → không gọi thẳng .charAt(0)
  const displayName = user?.full_name?.trim() || "Người dùng";

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-slate-900 bg-slate-950/80 px-4 md:px-6 backdrop-blur-md">
      {/* Left side: Hamburger menu + Breadcrumbs */}
      <div className="flex items-center space-x-4">
        <button
          onClick={onMenuToggle}
          className="rounded-lg p-2 text-slate-400 hover:bg-slate-850 hover:text-slate-100 lg:hidden focus:outline-none"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Shop đang dùng (multi-shop) */}
        {user?.shops && user.shops.length > 0 && user.branch_id && (
          <ShopSwitcher shops={user.shops} activeBranchId={user.branch_id} canCreate={Boolean(user.is_org_owner)} />
        )}

        {/* Breadcrumb / Title */}
        <div className="hidden sm:flex items-center space-x-2 text-sm font-medium">
          <span className="text-slate-200 font-semibold">{getPageTitle()}</span>
        </div>
      </div>

      {/* Right side: Search + Notification + User */}
      <div className="flex items-center space-x-4">
        {/* Search Input (desktop) */}
        <div className="relative hidden md:block w-64">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input
            type="text"
            placeholder="Tìm nhanh..."
            className="w-full rounded-xl bg-slate-900 border border-slate-850 py-1.5 pl-9 pr-4 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none transition-all"
          />
        </div>

        {/* Theme Toggle Button */}
        <ThemeToggle />

        {/* Notifications */}
        <button 
          onClick={() => setHasNotifications(false)}
          className="relative rounded-xl p-2.5 text-slate-400 hover:bg-slate-850 hover:text-slate-100 focus:outline-none border border-slate-850"
        >
          <Bell className="w-4 h-4" />
          {hasNotifications && (
            <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-indigo-500 ring-2 ring-slate-950 animate-pulse" />
          )}
        </button>

        {/* User Profile */}
        {user && (
          <div className="flex items-center space-x-3 pl-2 border-l border-slate-900">
            <div className="hidden text-right lg:block">
              <span className="block text-xs font-semibold text-slate-200">{displayName}</span>
              <span className="block text-[10px] text-slate-500">{SHOP_ROLE_LABELS[user.role as ShopRole] ?? user.role}</span>
            </div>
            
            <div className="relative flex h-8.5 w-8.5 items-center justify-center rounded-xl bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 font-bold text-sm uppercase shrink-0">
              {user.role === "owner" || user.role === "superadmin" ? (
                <ShieldCheck className="absolute -bottom-1 -right-1 h-3.5 w-3.5 text-emerald-400 fill-slate-950" />
              ) : null}
              {displayName.charAt(0)}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
