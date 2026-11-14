"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Delete, Lock, LogOut, WifiOff } from "lucide-react";

import { supabase } from "@/utils/api";
import {
  LOCAL_MAX_ATTEMPTS, PIN_MAX, PIN_MIN,
  cachePinLocally, clearLocalPin, hasLocalPin, idleExpired, isNetworkError,
  isSessionUnlocked, markLocked, markUnlocked, touchActivity, verifyPinLocally,
} from "@/utils/pinLock";

export type LockUser = { id: string; username?: string | null; full_name?: string | null };

// Phát sự kiện này (VD từ nút "Khóa màn hình") để khóa ngay.
export const LOCK_EVENT = "melio:lock-screen";
export const lockScreenNow = () => window.dispatchEvent(new Event(LOCK_EVENT));

type Mode = "checking" | "enter" | "create" | "confirm" | "need-network" | "unlocked";

export default function ScreenLock({ user, children }: { user: LockUser; children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>(() =>
    isSessionUnlocked(user.id) && !idleExpired() ? "unlocked" : "checking",
  );
  const [pin, setPin] = useState("");
  const [firstPin, setFirstPin] = useState("");
  const [message, setMessage] = useState("");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const localFails = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const locked = mode !== "unlocked";

  const switchUser = useCallback(async () => {
    markLocked();
    clearLocalPin(user.id);
    await supabase.auth.signOut().catch(() => undefined);
    localStorage.removeItem("melio_token");
    window.location.reload();
  }, [user.id]);

  // Khi bị khóa: hỏi DB xem tài khoản đã có PIN chưa.
  const loadStatus = useCallback(async () => {
    setMode("checking");
    setPin("");
    setFirstPin("");
    const { data, error } = await supabase.rpc("my_pin_status");
    if (error) {
      // DB chưa chạy migration user_pins (web deploy trước DB) → không khóa ai ngoài.
      if (error.code === "PGRST202") {
        setMode("unlocked");
        return;
      }
      if (isNetworkError(error) && hasLocalPin(user.id)) {
        setOffline(true);
        setMode("enter");
        return;
      }
      setMessage(isNetworkError(error) ? "" : error.message);
      setMode("need-network");
      return;
    }
    setOffline(false);
    if (data?.locked_until && new Date(data.locked_until) > new Date()) {
      setMessage(lockedMessage(data.locked_until));
    } else {
      setMessage("");
    }
    setMode(data?.has_pin ? "enter" : "create");
  }, [user.id]);

  const lock = useCallback(() => {
    markLocked();
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (mode === "checking") {
      void loadStatus();
      return;
    }
    // Vừa đăng nhập bằng mật khẩu (đang mở): tài khoản chưa có PIN thì bắt tạo
    // ngay, để lần khóa sau không ai khác đặt PIN thay.
    void supabase.rpc("my_pin_status").then(({ data }) => {
      if (data && !data.has_pin) setMode("create");
    });
    // chỉ chạy lần đầu; các lần khóa sau gọi loadStatus trực tiếp
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theo dõi thao tác để tự khóa khi để không.
  useEffect(() => {
    if (locked) return;
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last > 5000) {
        last = now;
        touchActivity();
      }
    };
    const check = () => {
      if (idleExpired()) lock();
    };
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [locked, lock]);

  useEffect(() => {
    window.addEventListener(LOCK_EVENT, lock);
    return () => window.removeEventListener(LOCK_EVENT, lock);
  }, [lock]);

  // Nội dung bên dưới vẫn giữ nguyên (giỏ hàng POS không mất) nhưng không
  // được focus/click khi đang khóa.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (locked) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [locked]);

  const unlock = useCallback(() => {
    markUnlocked(user.id);
    localFails.current = 0;
    setPin("");
    setFirstPin("");
    setMessage("");
    setMode("unlocked");
  }, [user.id]);

  const submit = useCallback(async (value: string) => {
    if (busy || value.length < PIN_MIN) return;
    setBusy(true);
    try {
      if (mode === "create") {
        setFirstPin(value);
        setPin("");
        setMessage("");
        setMode("confirm");
        return;
      }

      if (mode === "confirm") {
        if (value !== firstPin) {
          setMessage("Hai lần nhập không khớp. Tạo lại mã PIN.");
          setFirstPin("");
          setPin("");
          setMode("create");
          return;
        }
        const { error } = await supabase.rpc("set_my_pin", { p_pin: value });
        if (error) {
          setMessage(isNetworkError(error) ? "Mất kết nối. Cần có mạng để tạo mã PIN." : error.message);
          setPin("");
          return;
        }
        await cachePinLocally(user.id, value);
        unlock();
        return;
      }

      // mode === "enter"
      const { data, error } = offline
        ? { data: null, error: { message: "offline" } }
        : await supabase.rpc("verify_my_pin", { p_pin: value });

      if (error) {
        if (!isNetworkError(error) && !offline) {
          setPin("");
          // Chủ quán vừa xóa PIN (nhân viên quên PIN) → tạo PIN mới.
          if (/chưa đặt mã PIN/i.test(error.message)) {
            clearLocalPin(user.id);
            setMessage("");
            setMode("create");
            return;
          }
          setMessage(error.message);
          return;
        }
        // Rớt mạng: so với bản băm trên máy, tự giới hạn số lần sai.
        setOffline(true);
        if (await verifyPinLocally(user.id, value)) {
          unlock();
          return;
        }
        localFails.current += 1;
        if (localFails.current >= LOCAL_MAX_ATTEMPTS) {
          await switchUser();
          return;
        }
        setMessage(`Mã PIN không đúng. Còn ${LOCAL_MAX_ATTEMPTS - localFails.current} lần thử.`);
        setPin("");
        navigator.vibrate?.(200);
        return;
      }

      if (data?.ok) {
        await cachePinLocally(user.id, value);
        unlock();
        return;
      }
      setMessage(
        data?.locked_until
          ? lockedMessage(data.locked_until)
          : `Mã PIN không đúng. Còn ${data?.attempts_left ?? 0} lần thử.`,
      );
      setPin("");
      navigator.vibrate?.(200);
    } finally {
      setBusy(false);
    }
  }, [busy, mode, firstPin, offline, user.id, unlock, switchUser]);

  const press = useCallback((digit: string) => {
    if (busy || pin.length >= PIN_MAX) return;
    const next = pin + digit;
    setPin(next);
    // Đủ 6 số thì tự gửi; 4–5 số bấm OK / Enter.
    if (next.length === PIN_MAX) void submit(next);
  }, [busy, pin, submit]);

  // Bàn phím thật: số, Backspace, Enter.
  useEffect(() => {
    if (mode !== "enter" && mode !== "create" && mode !== "confirm") return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") void submit(pin);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, pin, press, submit]);

  const name = user.full_name || user.username || "Tài khoản";
  const title =
    mode === "create" ? "Tạo mã PIN khóa màn hình"
    : mode === "confirm" ? "Nhập lại mã PIN"
    : "Màn hình đang khóa";
  const hint =
    mode === "create" ? `Chọn ${PIN_MIN}–${PIN_MAX} chữ số. Lần sau chỉ cần nhập PIN này để mở khóa.`
    : mode === "confirm" ? "Nhập lại để xác nhận."
    : `Nhập mã PIN của ${name} để tiếp tục.`;

  return (
    <>
      <div ref={contentRef} aria-hidden={locked || undefined}>{children}</div>

      {locked && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-y-auto bg-slate-950 p-4" role="dialog" aria-modal="true" aria-label={title}>
          {mode === "checking" ? (
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-indigo-500" />
          ) : mode === "need-network" ? (
            <div className="flex w-full max-w-sm flex-col items-center space-y-4 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
                <WifiOff className="h-7 w-7" />
              </div>
              <h1 className="text-lg font-bold text-slate-100">Không mở khóa được</h1>
              <p className="text-sm text-slate-400">
                {message || "Máy đang mất kết nối và chưa có mã PIN lưu trên máy này. Kết nối mạng rồi thử lại."}
              </p>
              <button onClick={() => void loadStatus()} className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500">
                Thử lại
              </button>
              <SwitchUserButton onClick={switchUser} />
            </div>
          ) : (
            <div className="flex w-full max-w-sm flex-col items-center space-y-7">
              <div className="flex flex-col items-center space-y-3 text-center">
                <div className={`flex h-16 w-16 items-center justify-center rounded-2xl border transition-all ${
                  message ? "border-rose-500/30 bg-rose-500/10 text-rose-500" : "border-indigo-600/25 bg-indigo-600/10 text-indigo-400"
                }`}>
                  <Lock className="h-7 w-7" />
                </div>
                <p className="text-sm font-semibold text-indigo-300">{name}</p>
                <h1 className="text-lg font-bold tracking-tight text-slate-100">{title}</h1>
                <p className="max-w-[290px] text-xs text-slate-500">{hint}</p>
                {offline && mode === "enter" && (
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                    <WifiOff className="h-3.5 w-3.5" /> Đang mất mạng — kiểm tra bằng PIN lưu trên máy
                  </p>
                )}
              </div>

              <div className="flex h-4 items-center justify-center space-x-3" aria-label={`Đã nhập ${pin.length} số`}>
                {Array.from({ length: PIN_MAX }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-3.5 w-3.5 rounded-full border transition-all duration-150 ${
                      i < pin.length
                        ? "scale-110 border-indigo-400 bg-indigo-500 shadow-md shadow-indigo-500/50"
                        : i < PIN_MIN ? "border-slate-700 bg-slate-900" : "border-slate-800/60 bg-transparent"
                    }`}
                  />
                ))}
              </div>

              <p className="min-h-[1rem] text-center text-xs font-semibold text-rose-400" aria-live="polite">{message}</p>

              <div className="grid w-full max-w-[270px] grid-cols-3 gap-4">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((num) => (
                  <KeyButton key={num} onClick={() => press(num)}>{num}</KeyButton>
                ))}
                <button
                  onClick={() => setPin((p) => p.slice(0, -1))}
                  aria-label="Xóa một số"
                  className="flex h-16 w-16 items-center justify-center rounded-full text-slate-500 transition-all hover:text-slate-300 active:scale-90"
                >
                  <Delete className="h-5 w-5" />
                </button>
                <KeyButton onClick={() => press("0")}>0</KeyButton>
                <button
                  onClick={() => void submit(pin)}
                  disabled={busy || pin.length < PIN_MIN}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white transition-all hover:bg-indigo-500 active:scale-90 disabled:bg-slate-900 disabled:text-slate-600"
                >
                  {busy ? <span className="h-5 w-5 animate-spin rounded-full border-b-2 border-white" /> : "OK"}
                </button>
              </div>

              <SwitchUserButton onClick={switchUser} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function lockedMessage(until: string) {
  const time = new Date(until).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return `Sai PIN quá nhiều lần. Thử lại sau ${time}, hoặc đổi người dùng để đăng nhập bằng mật khẩu.`;
}

function KeyButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex h-16 w-16 items-center justify-center rounded-full border border-slate-800/40 bg-slate-900/60 text-xl font-bold text-slate-200 transition-all hover:bg-slate-800 active:scale-90"
    >
      {children}
    </button>
  );
}

function SwitchUserButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-200">
      <LogOut className="h-4 w-4" /> Đổi người dùng / Đăng nhập lại
    </button>
  );
}
