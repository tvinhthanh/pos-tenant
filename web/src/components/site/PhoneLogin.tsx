"use client";

import React, { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { customerClient, friendlyError, toE164 } from "@/utils/customerAuth";

const input = "w-full rounded-[var(--radius)] border border-black/15 bg-white px-3 py-2.5 text-base text-[var(--c-text)] focus:border-[var(--c-primary)] focus:outline-none";
const primary = "w-full rounded-[var(--radius)] bg-[var(--c-primary)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50";

/** Phiên khách hiện tại; null khi chưa đăng nhập, undefined khi đang tải */
export function useCustomerSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const sb = customerClient();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

export default function PhoneLogin({ title = "Đăng nhập bằng số điện thoại" }: { title?: string }) {
  const [phone, setPhone] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const e164 = toE164(phone);
    if (!e164) { setErr("Số điện thoại không hợp lệ (VD 0901234567)."); return; }
    setBusy(true); setErr("");
    const { error } = await customerClient().auth.signInWithOtp({ phone: e164, options: { channel: "sms" } });
    setBusy(false);
    if (error) { setErr(friendlyError(error, "Không gửi được mã.")); return; }
    setSent(e164); setCooldown(60);
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sent) return;
    setBusy(true); setErr("");
    const { error } = await customerClient().auth.verifyOtp({ phone: sent, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) setErr(friendlyError(error, "Không xác thực được mã."));
  };

  return (
    <div className="mx-auto max-w-sm rounded-[var(--radius)] border border-black/10 bg-[var(--c-surface)] p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-[var(--c-muted)]">Không cần mật khẩu. Shop gửi mã 6 số qua tin nhắn.</p>
      {!sent ? (
        <form onSubmit={send} className="mt-5 space-y-3">
          <label className="block text-sm font-medium" htmlFor="phone">Số điện thoại</label>
          <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel"
            placeholder="0901 234 567" className={input} />
          <button type="submit" disabled={busy} className={primary}>{busy ? "Đang gửi…" : "Gửi mã"}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-5 space-y-3">
          <label className="block text-sm font-medium" htmlFor="otp">Mã đã gửi tới {sent.replace("+84", "0")}</label>
          <input id="otp" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" className={`${input} text-center tracking-[0.5em]`} />
          <button type="submit" disabled={busy || code.length < 6} className={primary}>{busy ? "Đang xác thực…" : "Xác nhận"}</button>
          <div className="flex justify-between text-sm">
            <button type="button" onClick={() => { setSent(null); setCode(""); }} className="text-[var(--c-muted)] hover:underline">Đổi số</button>
            <button type="button" disabled={cooldown > 0 || busy} onClick={() => send()} className="text-[var(--c-primary)] hover:underline disabled:text-[var(--c-muted)] disabled:no-underline">
              {cooldown > 0 ? `Gửi lại sau ${cooldown}s` : "Gửi lại mã"}
            </button>
          </div>
        </form>
      )}
      {err && <p role="alert" className="mt-3 text-sm text-rose-600">{err}</p>}
    </div>
  );
}
