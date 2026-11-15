"use client";

import React, { useEffect, useState } from "react";
import { Coffee, KeyRound, User, Lock, AlertCircle, Eye, EyeOff } from "lucide-react";
import { usePathname } from "next/navigation";

import api, { supabase } from "@/utils/api";
import { markUnlocked } from "@/utils/pinLock";

const PUBLIC_PATHS = new Set<string>(["/signup"]);

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicPath = PUBLIC_PATHS.has(pathname);
  const [token, setToken] = useState<string | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (isPublicPath) {
      setChecking(false);
      return;
    }

    const localToken = localStorage.getItem("melio_token");
    if (!localToken) {
      setToken(null);
      setChecking(false);
      return;
    }

    api
      .get("/api/v1/auth/me")
      .then(() => {
        setToken(localToken);
        setSubscriptionError(null);
      })
      .catch((err: any) => {
        const status = err.response?.status;
        const detail = err.response?.data?.detail || "";
        if (status === 402 || (status === 403 && (detail.includes("thuê bao") || detail.includes("khóa") || detail.includes("hết hạn")))) {
          setSubscriptionError(detail);
          setToken(localToken);
        } else {
          localStorage.removeItem("melio_token");
          setToken(null);
        }
      })
      .finally(() => {
        setChecking(false);
      });
  }, [token, isPublicPath]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const formData = new URLSearchParams();
      formData.append("username", username);
      formData.append("password", password);

      const res = await api.post("/api/v1/auth/login", formData);
      const accessToken = res.data.access_token;
      localStorage.setItem("melio_token", accessToken);
      // Vừa nhập mật khẩu xong thì không bắt nhập PIN lại ngay.
      if (res.data.user?.id) markUnlocked(res.data.user.id);
      setToken(accessToken);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Đăng nhập thất bại. Kiểm tra tài khoản, mật khẩu và kết nối Supabase.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    supabase.auth.signOut();
    localStorage.removeItem("melio_token");
    setToken(null);
    setSubscriptionError(null);
    window.location.reload();
  };

  if (isPublicPath) {
    return <>{children}</>;
  }

  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (subscriptionError) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 px-4">
        <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-rose-500/20 bg-slate-900/80 p-8 text-center shadow-2xl backdrop-blur-xl">
          <div className="absolute left-1/4 right-1/4 top-0 h-[1px] bg-gradient-to-r from-transparent via-rose-500/40 to-transparent" />
          <div className="mb-6 flex flex-col items-center">
            <div className="mb-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 p-3.5 text-rose-400">
              <AlertCircle className="h-8 w-8" />
            </div>
            <h1 className="text-xl font-bold text-slate-100">Dịch vụ tạm khóa</h1>
            <p className="mt-3 px-2 text-sm text-slate-400">{subscriptionError}</p>
          </div>
          <button
            onClick={handleLogout}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-slate-700 active:scale-95"
          >
            Đăng xuất / Dùng tài khoản khác
          </button>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 px-4">
        <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-xl">
          <div className="absolute left-1/4 right-1/4 top-0 h-[1px] bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />

          <div className="mb-8 flex flex-col items-center">
            <div className="mb-4 rounded-2xl bg-indigo-600 p-3 shadow-lg shadow-indigo-500/20">
              <Coffee className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Đăng nhập</h1>
            <p className="mt-1.5 text-sm text-slate-400">Đăng nhập tài khoản POS & kế toán</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            {error && (
              <div className="flex items-start space-x-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Tên đăng nhập</label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500">
                  <User className="h-4 w-4" />
                </span>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="owner@example.com"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 py-3 pl-10 pr-4 text-sm text-white placeholder-slate-600 transition-all focus:border-indigo-500 focus:outline-none"
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Mật khẩu</label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500">
                  <Lock className="h-4 w-4" />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 py-3 pl-10 pr-11 text-sm text-white placeholder-slate-600 transition-all focus:border-indigo-500 focus:outline-none"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-500 transition-colors hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 hover:shadow-indigo-500/30 active:scale-95 disabled:opacity-60"
            >
              {loading ? (
                <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-white" />
              ) : (
                <>
                  <KeyRound className="mr-2 h-4 w-4" />
                  <span>Xác thực</span>
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-500">
            Chưa có cửa hàng?{" "}
            <a href="/signup" className="font-semibold text-indigo-400 hover:text-indigo-300">Đăng ký shop miễn phí</a>
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
