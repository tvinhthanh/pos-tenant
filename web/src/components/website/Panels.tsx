"use client";

import React, { useState } from "react";
import { Check, Copy, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ErrorLine, Field, inputCls } from "@/components/RetailUi";
import { ImageInput } from "@/components/website/SectionForm";
import { errorText, toast } from "@/components/Toaster";
import {
  addDomain, removeDomain, saveSettings, setSubdomain, setTemplate, verifyDomain,
  type EditorData, type SiteTemplate,
} from "@/utils/website";
import { DAY_LABELS, type Integrations, type OpeningHours, type SiteTheme } from "@/utils/site";

const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || "";

function Swatches({ t }: { t: SiteTheme }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-slate-800" aria-hidden="true">
      {[t.background, t.surface, t.primary, t.accent, t.text].map((c, i) => <span key={i} className="h-8 flex-1" style={{ background: c }} />)}
    </div>
  );
}

export function TemplateGrid({ templates, businessType, current, onPick, busy }: {
  templates: SiteTemplate[]; businessType: string; current?: string; onPick: (id: string) => void; busy?: boolean;
}) {
  const sorted = [...templates].sort((a, b) =>
    Number(b.business_type === businessType) - Number(a.business_type === businessType));
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {sorted.map((t) => (
        <button key={t.id} onClick={() => onPick(t.id)} disabled={busy || t.id === current}
          className={`space-y-3 rounded-2xl border p-4 text-left transition disabled:cursor-default ${t.id === current ? "border-indigo-500 bg-indigo-500/5" : "border-slate-800 bg-slate-900 hover:border-slate-600"}`}>
          <div className="rounded-xl p-3" style={{ background: t.theme.background, color: t.theme.text, fontFamily: t.theme.font === "serif" ? "Lora, Georgia, serif" : "inherit" }}>
            <p className="text-base font-semibold">Aa Tiêu đề</p>
            <span className="mt-2 inline-block px-3 py-1 text-xs font-semibold text-white"
              style={{ background: t.theme.primary, borderRadius: { none: 0, sm: 6, md: 10, lg: 16 }[t.theme.radius] }}>Đặt ngay</span>
          </div>
          <Swatches t={t.theme} />
          <div>
            <p className="flex items-center gap-1.5 font-semibold text-slate-100">{t.name}{t.id === current && <Check className="h-4 w-4 text-indigo-500" />}</p>
            <p className="text-xs text-slate-400">{t.description}</p>
            {t.business_type === businessType && <p className="mt-1 text-[11px] font-semibold text-emerald-500">Hợp với shop của bạn</p>}
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------
const COLOR_KEYS: [keyof SiteTheme, string][] = [
  ["primary", "Màu chính"], ["accent", "Màu nhấn"], ["background", "Nền"], ["surface", "Nền khối"], ["text", "Chữ"], ["muted", "Chữ phụ"],
];

export function ThemePanel({ data, baseTheme, onSaved }: { data: EditorData; baseTheme: SiteTheme; onSaved: () => void }) {
  const [t, setT] = useState<Partial<SiteTheme>>(data.site!.theme || {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const merged = { ...baseTheme, ...t } as SiteTheme;

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true); setErr("");
    try { await fn(); toast.success(msg); onSaved(); } catch (e) { setErr(errorText(e, "Không lưu được.")); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Mẫu giao diện</h2>
        <p className="text-xs text-slate-500">Đổi mẫu chỉ đổi màu, chữ, bo góc. Trang và nội dung giữ nguyên.</p>
        <TemplateGrid templates={data.templates} businessType={data.branch.business_type} current={data.site!.template_id} busy={busy}
          onPick={(id) => run(async () => { await setTemplate(id); setT({}); }, "Đã đổi mẫu")} />
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-slate-300">Tinh chỉnh</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {COLOR_KEYS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm text-slate-300">
              <input type="color" value={String(merged[k])} onChange={(e) => setT({ ...t, [k]: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-slate-800 bg-transparent" />
              {label}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kiểu chữ">
            <select value={merged.font} onChange={(e) => setT({ ...t, font: e.target.value as SiteTheme["font"] })} className={inputCls}>
              <option value="sans">Không chân — hiện đại</option>
              <option value="serif">Có chân — ấm áp, sang</option>
            </select>
          </Field>
          <Field label="Bo góc">
            <select value={merged.radius} onChange={(e) => setT({ ...t, radius: e.target.value as SiteTheme["radius"] })} className={inputCls}>
              <option value="none">Vuông</option><option value="sm">Nhẹ</option><option value="md">Vừa</option><option value="lg">Tròn</option>
            </select>
          </Field>
        </div>
        <Field label="Logo" hint="Ảnh vuông, nền trong càng tốt"><ImageInput value={t.logo || ""} onChange={(v) => setT({ ...t, logo: v })} label="Logo" /></Field>
        <ErrorLine text={err} />
        <div className="flex justify-end gap-2">
          <button onClick={() => setT({})} className="rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-300">Về màu của mẫu</button>
          <button onClick={() => run(() => saveSettings({ theme: Object.fromEntries(Object.entries(t).filter(([, v]) => v !== "" && v != null)) }), "Đã lưu giao diện")}
            disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Lưu giao diện</button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thông tin: liên hệ, bản đồ, giờ mở cửa
// ---------------------------------------------------------------------------
const INTEGRATION_FIELDS: [keyof Integrations, string, string][] = [
  ["hotline", "Số điện thoại / hotline", "0901234567"],
  ["zalo_phone", "Zalo (số điện thoại)", "0901234567"],
  ["zalo_oa", "Zalo OA (mã trang)", "tên hoặc id OA"],
  ["messenger_page", "Messenger (tên trang Facebook)", "banhmingon"],
  ["facebook_url", "Link Facebook", "https://facebook.com/…"],
  ["map_query", "Địa chỉ trên bản đồ", "12 Lê Lợi, Huế"],
  ["map_lat", "Vĩ độ (không bắt buộc)", "16.4637"],
  ["map_lng", "Kinh độ (không bắt buộc)", "107.5909"],
];

export function InfoPanel({ data, onSaved }: { data: EditorData; onSaved: () => void }) {
  const [i, setI] = useState<Integrations>(data.site!.integrations || {});
  const [hours, setHours] = useState<OpeningHours[]>(data.site!.opening_hours || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await saveSettings({ integrations: Object.fromEntries(Object.entries(i).map(([k, v]) => [k, (v || "").trim()])), opening_hours: hours });
      toast.success("Đã lưu thông tin");
      onSaved();
    } catch (e) { setErr(errorText(e, "Không lưu được.")); } finally { setBusy(false); }
  };
  const setRow = (idx: number, patch: Partial<OpeningHours>) => setHours((h) => h.map((r, j) => (j === idx ? { ...r, ...patch } : r)));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-slate-300">Liên hệ & bản đồ</h2>
        <p className="text-xs text-slate-500">Tên, địa chỉ, SĐT chính lấy từ Thông tin quán. Bỏ trống mục nào thì website không hiện mục đó.</p>
        {INTEGRATION_FIELDS.map(([k, label, ph]) => (
          <Field key={k} label={label}>
            <input value={i[k] || ""} placeholder={ph} onChange={(e) => setI({ ...i, [k]: e.target.value })} className={inputCls} />
          </Field>
        ))}
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-slate-300">Giờ mở cửa</h2>
        <p className="text-xs text-slate-500">Hiện ở website, chân trang và gửi cho Google. Qua nửa đêm: giờ đóng nhỏ hơn giờ mở.</p>
        {hours.map((r, idx) => (
          <div key={idx} className="space-y-2 rounded-xl border border-slate-800 p-3">
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button key={d} type="button" aria-pressed={r.days.includes(d)}
                  onClick={() => setRow(idx, { days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort() })}
                  className={`rounded-lg px-2 py-1 text-xs ${r.days.includes(d) ? "bg-indigo-600 text-white" : "border border-slate-800 text-slate-400"}`}>
                  {DAY_LABELS[d].replace("Thứ ", "T").replace("Chủ nhật", "CN")}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="time" value={r.open} onChange={(e) => setRow(idx, { open: e.target.value })} className={`${inputCls} w-32`} aria-label="Giờ mở" />
              <span className="text-slate-500">–</span>
              <input type="time" value={r.close} onChange={(e) => setRow(idx, { close: e.target.value })} className={`${inputCls} w-32`} aria-label="Giờ đóng" />
              <button onClick={() => setHours((h) => h.filter((_, j) => j !== idx))} aria-label="Bỏ khung giờ" className="ml-auto text-slate-500 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
        ))}
        <button onClick={() => setHours((h) => [...h, { days: [1, 2, 3, 4, 5, 6, 7], open: "07:00", close: "22:00" }])}
          className="flex items-center gap-1 text-xs font-semibold text-indigo-500 hover:underline"><Plus className="h-3.5 w-3.5" /> Thêm khung giờ</button>
      </section>

      <div className="lg:col-span-2">
        <ErrorLine text={err} />
        <div className="mt-3 flex justify-end">
          <button onClick={save} disabled={busy || hours.some((h) => h.days.length === 0)}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Lưu thông tin</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Địa chỉ web: subdomain + tên miền riêng
// ---------------------------------------------------------------------------
function CopyText({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}
      className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200 hover:bg-slate-700" title="Sao chép">
      {text}{ok ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function DomainPanel({ data, onSaved }: { data: EditorData; onSaved: () => void }) {
  const [sub, setSub] = useState(data.branch.subdomain || "");
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const run = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key); setErr("");
    try { await fn(); if (msg) toast.success(msg); onSaved(); } catch (e) { setErr(errorText(e, "Không thực hiện được.")); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-slate-300">Địa chỉ miễn phí</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[260px] flex-1 items-center rounded-xl border border-slate-800 bg-slate-950 focus-within:border-indigo-500">
            <input value={sub} onChange={(e) => setSub(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} aria-label="Subdomain"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-100 focus:outline-none" />
            {PLATFORM_DOMAIN && <span className="pr-3 font-mono text-xs text-slate-500">.{PLATFORM_DOMAIN}</span>}
          </div>
          <button onClick={() => run("sub", () => setSubdomain(sub || null), "Đã đổi địa chỉ")}
            disabled={busy !== null || sub === (data.branch.subdomain || "")}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Lưu</button>
        </div>
        <p className="text-xs text-slate-500">3–40 ký tự: chữ thường không dấu, số, gạch ngang. Đổi địa chỉ thì địa chỉ cũ tự chuyển sang mới trong 30 ngày.</p>
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Tên miền riêng</h2>
          <p className="text-xs text-slate-500">Chỉ chủ shop thêm được. Gói hiện tại: tối đa {data.limits.max_custom_domains} tên miền.</p>
        </div>
        {data.domains.map((d) => (
          <div key={d.id} className="space-y-3 rounded-xl border border-slate-800 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-sm text-slate-100">{d.domain}</p>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${d.status === "active" ? "bg-emerald-500/10 text-emerald-500" : d.status === "failed" ? "bg-rose-500/10 text-rose-500" : "bg-amber-500/10 text-amber-600"}`}>
                {d.status === "active" ? "Đang hoạt động" : d.status === "failed" ? "Lỗi DNS" : "Chờ xác minh"}
              </span>
            </div>
            {d.status !== "active" && (
              <ol className="list-decimal space-y-2 pl-5 text-xs text-slate-400">
                <li>Vào trang quản lý DNS của tên miền, thêm bản ghi <b>TXT</b> tên <CopyText text={`_pos-verify.${d.domain}`} /> giá trị <CopyText text={d.verify_token} /></li>
                <li>Thêm bản ghi <b>CNAME</b> cho <span className="font-mono">{d.domain}</span> trỏ tới <CopyText text={PLATFORM_DOMAIN || "<PLATFORM_DOMAIN>"} /> (tên miền gốc thì dùng bản ghi A trỏ về IP máy chủ)</li>
                <li>Đợi DNS cập nhật (vài phút đến vài giờ) rồi bấm Kiểm tra.</li>
              </ol>
            )}
            {d.last_error && d.status !== "active" && <p className="text-xs text-rose-500">Lần kiểm gần nhất: {d.last_error}</p>}
            <div className="flex gap-2">
              <button onClick={() => run(`v${d.id}`, async () => {
                  const r = await verifyDomain(d.id);
                  if (r.ok) toast.success("Tên miền đã hoạt động"); else toast.error(r.error || "Chưa thấy bản ghi DNS");
                })}
                disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-xl border border-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${busy === `v${d.id}` ? "animate-spin" : ""}`} /> Kiểm tra
              </button>
              <button onClick={() => { if (confirm(`Gỡ ${d.domain}? Website sẽ ngừng chạy ở tên miền này.`)) run(`r${d.id}`, () => removeDomain(d.id), "Đã gỡ tên miền"); }}
                disabled={busy !== null} className="rounded-xl px-3 py-1.5 text-xs text-rose-500 hover:bg-rose-500/10 disabled:opacity-50">Gỡ</button>
            </div>
          </div>
        ))}
        {data.domains.length < data.limits.max_custom_domains && (
          <form onSubmit={(e) => { e.preventDefault(); if (domain.trim()) run("add", async () => { await addDomain(domain); setDomain(""); }, "Đã thêm, làm theo hướng dẫn DNS để kích hoạt"); }}
            className="flex flex-wrap gap-2">
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="banhmingon.vn" aria-label="Tên miền riêng" className={`${inputCls} min-w-[240px] flex-1 font-mono`} />
            <button type="submit" disabled={busy !== null} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50">Thêm tên miền</button>
          </form>
        )}
      </section>
      <ErrorLine text={err} />
    </div>
  );
}
