"use client";

import React, { useRef, useState } from "react";
import { ImagePlus, Plus, Trash2 } from "lucide-react";
import { inputCls } from "@/components/RetailUi";
import { uploadSiteImage } from "@/utils/website";
import type { SectionType } from "@/utils/site";

type FieldKind = "text" | "textarea" | "image" | "link" | "bool" | "number" | "category" | "list";
interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  item?: FieldDef[];
  max?: number;
}

const FIELDS: Record<SectionType, FieldDef[]> = {
  hero: [
    { key: "heading", label: "Tiêu đề lớn", kind: "text" },
    { key: "subheading", label: "Dòng giới thiệu", kind: "textarea" },
    { key: "image", label: "Ảnh nền", kind: "image" },
    { key: "cta_label", label: "Chữ trên nút", kind: "text" },
    { key: "cta_href", label: "Nút dẫn tới", kind: "link", hint: "VD /dat-hang, /thuc-don hoặc https://…" },
  ],
  text: [
    { key: "heading", label: "Tiêu đề", kind: "text" },
    { key: "body", label: "Nội dung", kind: "textarea", hint: "**đậm**, *nghiêng*, dòng bắt đầu bằng “- ” thành danh sách" },
  ],
  image_gallery: [
    { key: "heading", label: "Tiêu đề", kind: "text" },
    { key: "images", label: "Ảnh", kind: "list", max: 12, item: [{ key: "url", label: "Ảnh", kind: "image" }, { key: "alt", label: "Mô tả ảnh", kind: "text" }] },
  ],
  catalog: [
    { key: "heading", label: "Tiêu đề", kind: "text" },
    { key: "category", label: "Chỉ hiện nhóm", kind: "category" },
    { key: "show_prices", label: "Hiện giá", kind: "bool" },
  ],
  featured_items: [
    { key: "heading", label: "Tiêu đề", kind: "text" },
    { key: "limit", label: "Số món", kind: "number", hint: "Lấy món bán chạy 30 ngày gần nhất" },
  ],
  hours: [{ key: "heading", label: "Tiêu đề", kind: "text", hint: "Giờ lấy từ tab Thông tin" }],
  map: [{ key: "heading", label: "Tiêu đề", kind: "text", hint: "Địa chỉ / tọa độ lấy từ tab Thông tin" }],
  contact: [{ key: "heading", label: "Tiêu đề", kind: "text", hint: "SĐT, Zalo, Messenger lấy từ tab Thông tin" }],
  cta_order: [
    { key: "heading", label: "Tiêu đề", kind: "text" },
    { key: "body", label: "Mô tả", kind: "textarea" },
    { key: "label", label: "Chữ trên nút", kind: "text", hint: "Chỉ hiện khi shop bật nhận đơn online" },
  ],
  testimonials: [
    { key: "heading", label: "Tiêu đề", kind: "text" },
    { key: "items", label: "Lời khách", kind: "list", max: 12, item: [{ key: "name", label: "Tên khách", kind: "text" }, { key: "quote", label: "Nhận xét", kind: "textarea" }] },
  ],
  faq: [
    { key: "heading", label: "Tiêu đề", kind: "text" },
    { key: "items", label: "Câu hỏi", kind: "list", max: 20, item: [{ key: "q", label: "Câu hỏi", kind: "text" }, { key: "a", label: "Trả lời", kind: "textarea" }] },
  ],
};

function ImageInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="h-10 w-14 shrink-0 rounded-md object-cover" />
        ) : null}
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://… hoặc tải ảnh lên" aria-label={label} className={inputCls} />
        <button type="button" onClick={() => ref.current?.click()} disabled={busy}
          className="flex shrink-0 items-center gap-1 rounded-xl border border-slate-800 px-2.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          <ImagePlus className="h-4 w-4" />{busy ? "Đang tải…" : "Tải lên"}
        </button>
        <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setBusy(true); setErr("");
            try { onChange(await uploadSiteImage(f)); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
          }} />
      </div>
      {err && <p className="text-xs text-rose-500">{err}</p>}
    </div>
  );
}

function FieldInput({ def, value, onChange, categories }: { def: FieldDef; value: any; onChange: (v: any) => void; categories: string[] }) {
  switch (def.kind) {
    case "textarea":
      return <textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} rows={4} aria-label={def.label} className={inputCls} />;
    case "image":
      return <ImageInput value={value ?? ""} onChange={onChange} label={def.label} />;
    case "bool":
      return (
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={value !== false} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-indigo-500" />{def.label}
        </label>
      );
    case "number":
      return <input type="number" min={1} max={24} value={value ?? 6} onChange={(e) => onChange(Math.min(24, Math.max(1, Number(e.target.value) || 1)))} aria-label={def.label} className={`${inputCls} w-24`} />;
    case "category":
      return (
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={def.label} className={inputCls}>
          <option value="">Tất cả</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      );
    case "list": {
      const list: any[] = Array.isArray(value) ? value : [];
      const set = (i: number, patch: any) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      return (
        <div className="space-y-2">
          {list.map((row, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-slate-800 p-2.5">
              {def.item!.map((f) => (
                <div key={f.key}>
                  <span className="mb-1 block text-[11px] text-slate-500">{f.label}</span>
                  <FieldInput def={f} value={row?.[f.key]} onChange={(v) => set(i, { [f.key]: v })} categories={categories} />
                </div>
              ))}
              <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className="flex items-center gap-1 text-xs text-rose-500 hover:underline">
                <Trash2 className="h-3.5 w-3.5" /> Bỏ
              </button>
            </div>
          ))}
          {list.length < (def.max ?? 12) && (
            <button type="button" onClick={() => onChange([...list, Object.fromEntries(def.item!.map((f) => [f.key, ""]))])}
              className="flex items-center gap-1 text-xs font-semibold text-indigo-500 hover:underline">
              <Plus className="h-3.5 w-3.5" /> Thêm
            </button>
          )}
        </div>
      );
    }
    default:
      return <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={def.label} className={inputCls} />;
  }
}

export default function SectionForm({ type, props, onChange, categories }: {
  type: SectionType; props: Record<string, any>; onChange: (p: Record<string, any>) => void; categories: string[];
}) {
  return (
    <div className="space-y-3">
      {FIELDS[type].map((f) => (
        <div key={f.key}>
          {f.kind !== "bool" && <span className="mb-1 block text-xs font-medium text-slate-400">{f.label}</span>}
          <FieldInput def={f} value={props[f.key]} onChange={(v) => onChange({ ...props, [f.key]: v })} categories={categories} />
          {f.hint && <span className="mt-1 block text-[11px] text-slate-500">{f.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export { ImageInput };
