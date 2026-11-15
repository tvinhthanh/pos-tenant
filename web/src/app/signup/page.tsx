"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Coffee } from "lucide-react";
import { selfSignup } from "@/utils/api";
import { errorText } from "@/components/Toaster";
import { BUSINESS_TYPE_LABELS, normalizeSubdomain, type BusinessType } from "@/utils/shop";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || "";
const MIN_PASSWORD = 10;

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void }) => string;
      reset: (id?: string) => void;
    };
  }
}

const BUSINESS_HINTS: Record<BusinessType, string> = {
  fnb: "Quán ăn, quán nước: thực đơn, công thức, bàn, bếp",
  retail: "Tạp hóa, cửa hàng: sản phẩm, tồn kho, mã vạch",
  rental: "Cho thuê đồ, xe, phòng: hợp đồng, tiền cọc, lịch",
};

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [shopName, setShopName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("fnb");
  const [subdomain, setSubdomain] = useState("");
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ confirm: boolean } | null>(null);

  const captchaRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  const effectiveSubdomain = subdomainTouched ? subdomain : normalizeSubdomain(shopName);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !captchaRef.current) return;
    const mount = () => {
      if (window.turnstile && captchaRef.current && !widgetId.current) {
        widgetId.current = window.turnstile.render(captchaRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: setCaptchaToken,
          "expired-callback": () => setCaptchaToken(""),
        });
      }
    };
    if (window.turnstile) {
      mount();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = mount;
    document.head.appendChild(script);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < MIN_PASSWORD) {
      setError(`Mật khẩu phải có ít nhất ${MIN_PASSWORD} ký tự.`);
      return;
    }
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError("Vui lòng hoàn tất xác minh chống bot.");
      return;
    }
    setSaving(true);
    try {
      const res = await selfSignup({
        email: email.trim(),
        password,
        full_name: fullName.trim() || undefined,
        shop_name: shopName.trim(),
        business_type: businessType,
        subdomain: effectiveSubdomain || null,
        captcha_token: captchaToken || undefined,
      });
      setDone({ confirm: res.email_confirmation_required });
    } catch (err) {
      setError(errorText(err, "Đăng ký thất bại."));
      if (widgetId.current) window.turnstile?.reset(widgetId.current);
      setCaptchaToken("");
    } finally {
      setSaving(false);
    }
  };

  const input = "mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none";

  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
          <h1 className="mt-4 text-xl font-bold text-slate-100">Đã tạo shop “{shopName.trim()}”</h1>
          <p className="mt-2 text-sm text-slate-400">
            {done.confirm
              ? `Kiểm tra hộp thư ${email.trim()} và bấm link xác thực, rồi đăng nhập bằng email này.`
              : "Bạn có thể đăng nhập ngay bằng email và mật khẩu vừa tạo."}
          </p>
          <Link href="/" className="mt-6 inline-block rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500">
            Đến trang đăng nhập
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-lg space-y-5 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 sm:p-8 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-indigo-600 p-2.5"><Coffee className="h-6 w-6 text-white" /></div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">Đăng ký shop</h1>
            <p className="text-xs text-slate-400">Dùng thử 14 ngày, tối đa 3 shop. Tạo thêm shop sau khi đăng nhập.</p>
          </div>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{error}</span>
          </div>
        )}

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Tài khoản chủ shop</h2>
          <label className="block text-xs text-slate-400">
            Họ tên
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" className={input} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Email
              <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={input} />
            </label>
            <label className="block text-xs text-slate-400">
              Mật khẩu (≥ {MIN_PASSWORD} ký tự)
              <input required type="password" minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={input} />
            </label>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Shop đầu tiên</h2>
          <label className="block text-xs text-slate-400">
            Tên shop
            <input required maxLength={120} value={shopName} onChange={(e) => setShopName(e.target.value)} className={input} />
          </label>

          <fieldset>
            <legend className="text-xs text-slate-400">Nghiệp vụ</legend>
            <div className="mt-1 grid gap-2 sm:grid-cols-3">
              {(Object.keys(BUSINESS_TYPE_LABELS) as BusinessType[]).map((type) => (
                <label
                  key={type}
                  className={`cursor-pointer rounded-xl border p-3 text-xs ${
                    businessType === type ? "border-indigo-500 bg-indigo-500/10" : "border-slate-800 hover:border-slate-700"
                  }`}
                >
                  <input type="radio" name="business_type" value={type} checked={businessType === type}
                    onChange={() => setBusinessType(type)} className="sr-only" />
                  <span className="block font-semibold text-slate-100">{BUSINESS_TYPE_LABELS[type]}</span>
                  <span className="mt-1 block text-[11px] leading-snug text-slate-500">{BUSINESS_HINTS[type]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block text-xs text-slate-400">
            Địa chỉ website
            <div className="mt-1 flex items-center rounded-xl border border-slate-800 bg-slate-950/60 focus-within:border-indigo-500">
              <input
                value={effectiveSubdomain}
                onChange={(e) => {
                  setSubdomainTouched(true);
                  setSubdomain(normalizeSubdomain(e.target.value));
                }}
                placeholder="ten-shop"
                className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 font-mono text-sm text-slate-100 placeholder-slate-600 focus:outline-none"
              />
              {PLATFORM_DOMAIN && <span className="pr-3.5 font-mono text-xs text-slate-500">.{PLATFORM_DOMAIN}</span>}
            </div>
            <span className="mt-1 block text-[11px] text-slate-500">Đổi được sau trong Thông tin quán. Để trống nếu chưa cần.</span>
          </label>
        </section>

        {TURNSTILE_SITE_KEY && <div ref={captchaRef} />}

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {saving ? "Đang tạo shop…" : "Tạo shop"}
        </button>

        <p className="text-center text-xs text-slate-500">
          Đã có tài khoản? <Link href="/" className="font-semibold text-indigo-400 hover:text-indigo-300">Đăng nhập</Link>
        </p>
      </form>
    </main>
  );
}
