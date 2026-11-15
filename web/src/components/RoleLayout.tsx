"use client";

import React, { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import AdminLayout from "@/components/AdminLayout";
import ScreenLock from "@/components/ScreenLock";
import api from "@/utils/api";
import { staffCanOpen } from "@/components/Sidebar";

type CurrentUser = {
  id: string;
  role: string;
  business_type?: "fnb" | "retail" | "rental" | null;
  username?: string | null;
  full_name?: string | null;
};

const PUBLIC_PATHS = new Set<string>(["/signup"]);
const SUPERADMIN_PREFIX = "/superadmin";

export default function RoleLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublicPath = PUBLIC_PATHS.has(pathname);

  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => {
      const res = await api.get("/api/v1/auth/me");
      return res.data as CurrentUser;
    },
    retry: false,
    enabled: !isPublicPath,
  });

  const isStaff = user?.role === "staff";
  // Nhân viên: F&B chỉ dùng màn POS toàn màn hình; cho thuê / bán lẻ có vài màn tại quầy.
  const staffType = user?.business_type ?? "fnb";
  const staffUsesShell = isStaff && (staffType === "rental" || staffType === "retail");
  const staffHome = staffType === "rental" ? "/rental" : staffType === "retail" ? "/retail" : "/pos";
  const staffAllowed = staffCanOpen(staffType, pathname);
  const isSuperadmin = user?.role === "superadmin";

  useEffect(() => {
    if (isStaff && !staffAllowed) {
      router.replace(staffHome);
    }
    if (isSuperadmin && !pathname.startsWith(SUPERADMIN_PREFIX)) {
      router.replace("/superadmin/stores");
    }
    if (user && !isSuperadmin && pathname.startsWith(SUPERADMIN_PREFIX)) {
      router.replace("/");
    }
  }, [isStaff, staffAllowed, staffHome, isSuperadmin, pathname, router, user]);

  if (isPublicPath) {
    return <>{children}</>;
  }

  if (
    isLoading ||
    (isStaff && !staffAllowed) ||
    (isSuperadmin && !pathname.startsWith(SUPERADMIN_PREFIX)) ||
    (Boolean(user) && !isSuperadmin && pathname.startsWith(SUPERADMIN_PREFIX))
  ) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  if (!user) {
    return <>{children}</>;
  }

  // Khóa màn hình bằng PIN của chính tài khoản đang đăng nhập (mọi trang, kể cả POS).
  if (isStaff && !staffUsesShell) {
    return <ScreenLock key={user.id} user={user}>{children}</ScreenLock>;
  }

  return (
    <ScreenLock key={user.id} user={user}>
      <AdminLayout>{children}</AdminLayout>
    </ScreenLock>
  );
}
