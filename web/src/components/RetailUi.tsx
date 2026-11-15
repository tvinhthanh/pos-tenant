"use client";

import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export const inputCls =
  "w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-60";

/** Hộp thoại gắn vào body: header dùng backdrop-filter nên dialog lồng bên trong bị cắt. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`w-full ${wide ? "max-w-2xl" : "max-w-lg"} space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl`}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-100">{title}</h2>
          <button onClick={onClose} aria-label="Đóng" className="rounded-lg p-1 text-slate-500 hover:text-slate-100"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-sm text-rose-500">{text}</p> : null;
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">{title}</h1>
        {sub && <p className="text-sm text-slate-400">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/** Ô nhập số nguyên ≥ 0 (tiền / số lượng), cho phép để trống khi đang gõ. */
export function NumberInput({ value, onChange, ...rest }: {
  value: number | "";
  onChange: (v: number | "") => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <input
      {...rest}
      inputMode="numeric"
      value={value === "" ? "" : String(value)}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d]/g, "");
        onChange(raw === "" ? "" : Number(raw));
      }}
      className={`${inputCls} text-right tabular-nums ${rest.className ?? ""}`}
    />
  );
}

/**
 * Ô quét mã / tìm sản phẩm: máy quét gõ mã + Enter → chọn ngay; gõ tên → danh sách gợi ý.
 */
export function GoodsPicker<G extends { id: number; name: string; barcode: string | null; sku: string | null; unit: string; stock: number }>({
  catalog, onPick, placeholder = "Quét mã vạch hoặc gõ tên sản phẩm",
}: {
  catalog: G[];
  onPick: (g: G) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const t = term.trim().toLowerCase();
  const hits = t
    ? catalog.filter((g) => g.name.toLowerCase().includes(t) || g.barcode?.includes(t) || g.sku?.toLowerCase().includes(t)).slice(0, 8)
    : [];
  const pick = (g: G) => { onPick(g); setTerm(""); setMsg(""); };
  return (
    <div className="relative">
      <input
        value={term}
        onChange={(e) => { setTerm(e.target.value); setMsg(""); }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const c = term.trim();
          const exact = catalog.find((g) => g.barcode === c) ?? catalog.find((g) => g.sku?.toLowerCase() === c.toLowerCase());
          if (exact) pick(exact);
          else if (hits.length === 1) pick(hits[0]);
          else if (c) setMsg(`Không có mã "${c}".`);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className={inputCls}
      />
      {msg && <p className="mt-1 text-xs text-amber-600">{msg}</p>}
      {hits.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
          {hits.map((g) => (
            <li key={g.id}>
              <button onClick={() => pick(g)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800">
                <span>{g.name}<span className="ml-2 font-mono text-xs text-slate-500">{g.barcode ?? g.sku ?? ""}</span></span>
                <span className="text-xs tabular-nums text-slate-500">tồn {Number(g.stock).toLocaleString("vi-VN")} {g.unit}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
