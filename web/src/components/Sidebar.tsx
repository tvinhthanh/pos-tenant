"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Coffee, ShieldCheck, User, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import api, { supabase } from "@/utils/api";
import { getBranchProfile } from "@/utils/rpc";
import { BUSINESS_TYPE_LABELS, type BusinessType } from "@/utils/shop";
import { getNavGroups } from "@/utils/nav";

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

  const isSuperadmin = user?.role === "superadmin";
  const businessType: BusinessType = user?.business_type ?? "fnb";

  // Tên quán lấy từ trang "Thông tin quán" (hoặc tên cửa hàng), không viết cứng
  const { data: branchProfile } = useQuery({
    queryKey: ["branchProfile"],
    queryFn: getBranchProfile,
    enabled: Boolean(user) && !isSuperadmin,
  });
  const storeName = isSuperadmin
    ? "POS Admin"
    : branchProfile?.receipt_name || user?.shop_name || branchProfile?.organization_name || "POS";

  const navGroups = getNavGroups(user?.role, businessType);

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
          {navGroups.map((group) => (
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
