"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Coffee, Mail, MailCheck } from "lucide-react";
import { requestPasswordReset } from "@/utils/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      await requestPasswordReset(email);
      setSentTo(email.trim());
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || "Không gửi được email. Vui lòng thử lại.");
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl">
        {sentTo ? (
          <div className="text-center">
            <MailCheck className="mx-auto h-10 w-10 text-emerald-400" />
            <h1 className="mt-4 text-xl font-bold text-slate-100">Kiểm tra hộp thư</h1>
            <p className="mt-2 text-sm text-slate-400">
              Nếu <span className="font-semibold text-slate-200">{sentTo}</span> đã đăng ký tài khoản, bạn sẽ nhận được email
              chứa link đặt lại mật khẩu trong vài phút. Xem cả mục Spam nếu không thấy.
            </p>
            <button
              type="button"
              onClick={() => setSentTo(null)}
              className="mt-6 text-xs font-semibold text-indigo-400 hover:text-indigo-300"
            >
              Gửi lại hoặc dùng email khác
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div className="flex flex-col items-center text-center">
              <div className="mb-4 rounded-2xl bg-indigo-600 p-3 shadow-lg shadow-indigo-500/20">
                <Coffee className="h-8 w-8 text-white" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-100">Quên mật khẩu</h1>
              <p className="mt-1.5 text-sm text-slate-400">Nhập email đăng ký, chúng tôi sẽ gửi link đặt lại mật khẩu.</p>
            </div>

            {error && (
              <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label htmlFor="reset-email" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Email
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500">
                  <Mail className="h-4 w-4" />
                </span>
                <input
                  id="reset-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ban@example.com"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 py-3 pl-10 pr-4 text-sm text-white placeholder-slate-600 transition-all focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">Nhân viên đăng nhập bằng tên đăng nhập: nhờ chủ quán đặt lại mật khẩu.</p>
            </div>

            <button
              type="submit"
              disabled={sending}
              className="flex w-full items-center justify-center rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-60"
            >
              {sending ? <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-white" /> : "Gửi link đặt lại"}
            </button>
          </form>
        )}

        <Link href="/" className="mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-500 hover:text-slate-300">
          <ArrowLeft className="h-3.5 w-3.5" /> Quay lại đăng nhập
        </Link>
      </div>
    </main>
  );
}
