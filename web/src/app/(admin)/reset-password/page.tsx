"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Coffee, Eye, EyeOff, Lock } from "lucide-react";
import { MIN_PASSWORD_LENGTH, supabase, updatePassword } from "@/utils/api";
import { markUnlocked } from "@/utils/pinLock";

type Stage = "checking" | "ready" | "invalid";

export default function ResetPasswordPage() {
  const [stage, setStage] = useState<Stage>("checking");
  const [invalidReason, setInvalidReason] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Link hỏng / hết hạn: Supabase chuyển về đây với #error=...&error_code=otp_expired
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get("error")) {
      setInvalidReason(
        hash.get("error_code") === "otp_expired"
          ? "Link đặt lại mật khẩu đã hết hạn hoặc đã được dùng."
          : "Link đặt lại mật khẩu không hợp lệ.",
      );
      setStage("invalid");
      return;
    }
    // Client tự đọc token khôi phục trong URL (detectSessionInUrl) và mở phiên tạm.
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) {
        setStage("ready");
      } else {
        setInvalidReason("Link đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.");
        setStage("invalid");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Hai mật khẩu không khớp.");
      return;
    }
    setSaving(true);
    try {
      const token = await updatePassword(password);
      const { data } = await supabase.auth.getUser();
      if (token) localStorage.setItem("melio_token", token);
      // Vừa đặt mật khẩu xong thì không bắt nhập PIN lại ngay.
      if (data.user?.id) markUnlocked(data.user.id);
      window.location.replace("/");
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Không đổi được mật khẩu. Vui lòng thử lại.");
      setSaving(false);
    }
  };

  const input =
    "w-full rounded-xl border border-slate-800 bg-slate-950 py-3 pl-10 pr-11 text-sm text-white placeholder-slate-600 transition-all focus:border-indigo-500 focus:outline-none";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 rounded-2xl bg-indigo-600 p-3 shadow-lg shadow-indigo-500/20">
            <Coffee className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Đặt mật khẩu mới</h1>
        </div>

        {stage === "checking" && (
          <div className="flex justify-center py-6">
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-indigo-500" />
          </div>
        )}

        {stage === "invalid" && (
          <div className="text-center">
            <p className="text-sm text-slate-400">{invalidReason}</p>
            <Link
              href="/forgot-password"
              className="mt-6 inline-block rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Gửi lại email
            </Link>
          </div>
        )}

        {stage === "ready" && (
          <form onSubmit={submit} className="space-y-5">
            {error && (
              <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label htmlFor="new-password" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Mật khẩu mới (≥ {MIN_PASSWORD_LENGTH} ký tự)
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500">
                  <Lock className="h-4 w-4" />
                </span>
                <input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  required
                  className={input}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-500 transition-colors hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="confirm-password" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Nhập lại mật khẩu
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500">
                  <Lock className="h-4 w-4" />
                </span>
                <input
                  id="confirm-password"
                  type={showPassword ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  className={input}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="flex w-full items-center justify-center rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-60"
            >
              {saving ? <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-white" /> : "Lưu mật khẩu và đăng nhập"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
