"use client";

import React, { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import AdminLayout from "@/components/AdminLayout";
import ScreenLock from "@/components/ScreenLock";
import api from "@/utils/api";

type CurrentUser = {
  id: string;
  role: string;
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
  const isSuperadmin = user?.role === "superadmin";

  useEffect(() => {
    if (isStaff && pathname !== "/pos") {
      router.replace("/pos");
    }
    if (isSuperadmin && !pathname.startsWith(SUPERADMIN_PREFIX)) {
      router.replace("/superadmin/stores");
    }
    if (user && !isSuperadmin && pathname.startsWith(SUPERADMIN_PREFIX)) {
      router.replace("/");
    }
  }, [isStaff, isSuperadmin, pathname, router, user]);

  if (isPublicPath) {
    return <>{children}</>;
  }

  if (
    isLoading ||
    (isStaff && pathname !== "/pos") ||
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
  if (isStaff) {
    return <ScreenLock key={user.id} user={user}>{children}</ScreenLock>;
  }

  return (
    <ScreenLock key={user.id} user={user}>
      <AdminLayout>{children}</AdminLayout>
    </ScreenLock>
  );
}
