"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";

/**
 * Thông báo nổi thay cho window.alert(): không chặn màn hình, tự ẩn, đọc được
 * ở cả light/dark. Gọi từ bất kỳ đâu: toast.success("..."), toast.error("...").
 */
type Kind = "success" | "error";
interface Toast { id: number; kind: Kind; message: string }

let nextId = 1;
let items: Toast[] = [];
const listeners = new Set<(list: Toast[]) => void>();

function emit() {
  listeners.forEach((fn) => fn(items));
}

function push(kind: Kind, message: unknown) {
  const text = String(message || (kind === "error" ? "Có lỗi xảy ra." : "Đã xong."));
  const id = nextId++;
  items = [...items, { id, kind, message: text }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3500);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: unknown) => push("success", message),
  error: (message: unknown) => push("error", message),
};

/** Lấy thông báo lỗi từ lỗi api.ts / rpc.ts ({ response.data.detail }). */
export const errorText = (err: any, fallback: string) =>
  err?.response?.data?.detail || err?.message || fallback;

export default function Toaster() {
  const [list, setList] = useState<Toast[]>([]);

  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-4 sm:top-auto sm:bottom-6 sm:items-end"
    >
      {list.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium shadow-xl ${
            t.kind === "error"
              ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/70 dark:bg-rose-950 dark:text-rose-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950 dark:text-emerald-200"
          }`}
        >
          {t.kind === "error" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="flex-1 leading-snug">{t.message}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Đóng thông báo" className="opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
