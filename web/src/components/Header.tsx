"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CornerDownLeft, Menu, Search, ShieldCheck } from "lucide-react";
import api from "@/utils/api";
import type { BusinessType, MyShop } from "@/utils/shop";
import { SHOP_ROLE_LABELS, type ShopRole } from "@/utils/shop";
import { foldVietnamese, getNavGroups, pageTitle } from "@/utils/nav";
import ThemeToggle from "./ThemeToggle";
import ShopSwitcher from "./ShopSwitcher";
import OnlineBell from "./OnlineBell";

interface HeaderProps {
  onMenuToggle: () => void;
}

type HeaderUser = {
  full_name: string | null;
  role: string;
  branch_id?: number;
  business_type?: BusinessType | null;
  shops?: MyShop[];
  is_org_owner?: boolean;
};

export default function Header({ onMenuToggle }: HeaderProps) {
  const pathname = usePathname();
  const [user, setUser] = useState<HeaderUser | null>(null);

  useEffect(() => {
    api.get("/api/v1/auth/me")
      .then((res) => setUser(res.data))
      .catch(() => setUser(null));
  }, []);

  // profiles.full_name cho phép null → không gọi thẳng .charAt(0)
  const displayName = user?.full_name?.trim() || "Người dùng";
  const roleLabel = user ? SHOP_ROLE_LABELS[user.role as ShopRole] ?? user.role : "";
  const isPrivileged = user?.role === "owner" || user?.role === "superadmin";

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center gap-3 border-b border-slate-850 bg-slate-950/80 px-4 backdrop-blur-md md:px-6">
      {/* Trái: menu (mobile) + shop + tên trang */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          onClick={onMenuToggle}
          aria-label="Mở menu"
          className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-850 hover:text-slate-100 focus:outline-none lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        {user?.shops && user.shops.length > 0 && user.branch_id && (
          <ShopSwitcher shops={user.shops} activeBranchId={user.branch_id} canCreate={Boolean(user.is_org_owner)} />
        )}

        <span className="hidden truncate text-sm font-semibold text-slate-200 sm:block">{pageTitle(pathname)}</span>
      </div>

      {/* Phải: tìm nhanh + giao diện + đơn online + người dùng */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {user && <QuickNav role={user.role} businessType={user.business_type} />}

        <ThemeToggle />

        {/* Đơn online đang chờ (shop, không phải admin nền tảng) */}
        {user && user.role !== "superadmin" && <OnlineBell />}

        {user && (
          <div className="ml-1 flex items-center gap-2.5 border-l border-slate-850 pl-3" title={`${displayName} · ${roleLabel}`}>
            <div className="hidden min-w-0 text-right lg:block">
              <span className="block max-w-[10rem] truncate text-xs font-semibold text-slate-200">{displayName}</span>
              <span className="block text-[10px] text-slate-500">{roleLabel}</span>
            </div>
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-600/10 text-sm font-bold uppercase text-indigo-400">
              {displayName.charAt(0)}
              {isPrivileged && (
                <ShieldCheck className="absolute -bottom-1 -right-1 h-3.5 w-3.5 fill-slate-950 text-emerald-400" aria-label="Quản trị" />
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * Ô "Tìm nhanh": gõ tên màn hình (có dấu hay không đều được) → Enter để mở.
 * Chỉ liệt kê màn người dùng được vào (cùng nguồn menu với Sidebar). Ctrl/⌘ + K để focus.
 */
function QuickNav({ role, businessType }: { role: string; businessType?: BusinessType | null }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const items = useMemo(
    () => getNavGroups(role, businessType).flatMap((g) => g.items.map((i) => ({ ...i, group: g.title }))),
    [role, businessType],
  );
  const results = useMemo(() => {
    const q = foldVietnamese(query);
    if (!q) return items;
    return items.filter((i) => foldVietnamese(`${i.name} ${i.group}`).includes(q));
  }, [items, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(path);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active].path);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={boxRef} className="relative hidden md:block md:w-56 xl:w-72">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="quicknav-list"
        aria-label="Tìm nhanh màn hình"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Tìm màn hình…"
        className="w-full rounded-xl border border-slate-850 bg-slate-900 py-2 pl-9 pr-14 text-xs text-slate-100 placeholder-slate-500 transition-colors focus:border-indigo-500 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-slate-800 px-1.5 py-0.5 font-sans text-[10px] text-slate-500">
        Ctrl K
      </kbd>

      {open && (
        <ul
          id="quicknav-list"
          role="listbox"
          className="absolute right-0 z-40 mt-2 max-h-80 w-full min-w-[16rem] overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 py-1 shadow-2xl"
        >
          {results.length === 0 && <li className="px-3 py-3 text-xs text-slate-500">Không có màn hình nào khớp “{query}”.</li>}
          {results.map((item, i) => {
            const Icon = item.icon;
            return (
              <li key={item.path} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item.path)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs ${
                    i === active ? "bg-indigo-600/10 text-slate-100" : "text-slate-300"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-slate-500" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{item.name}</span>
                  <span className="shrink-0 text-[10px] text-slate-500">{item.group}</span>
                  {i === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-slate-500" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
