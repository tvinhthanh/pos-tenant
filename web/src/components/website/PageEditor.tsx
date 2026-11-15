"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
import { ErrorLine, Field, inputCls } from "@/components/RetailUi";
import SectionForm from "@/components/website/SectionForm";
import Preview from "@/components/website/Preview";
import { savePage, type EditorPage } from "@/utils/website";
import {
  newSectionId, slugify, SECTION_DEFAULTS, SECTION_LABELS,
  type CatalogItem, type PublicSite, type Section, type SectionType,
} from "@/utils/site";
import { errorText, toast } from "@/components/Toaster";

type Draft = Pick<EditorPage, "id" | "path" | "title" | "kind" | "show_in_nav" | "seo"> & { sections: Section[] };

const toDraft = (p: EditorPage): Draft => ({
  id: p.id, path: p.path, title: p.title, kind: p.kind, show_in_nav: p.show_in_nav, seo: p.seo || {},
  sections: p.draft_sections || [],
});

export default function PageEditor({ page, site, catalog, onSaved, onDirty }: {
  page: EditorPage; site: PublicSite; catalog: CatalogItem[];
  onSaved: () => void; onDirty: (dirty: boolean) => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(page));
  const [open, setOpen] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Đổi trang → nạp lại bản nháp
  useEffect(() => { setD(toDraft(page)); setOpen(null); setErr(""); }, [page]);

  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(toDraft(page)), [d, page]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const categories = useMemo(() => [...new Set(catalog.map((c) => c.category))].sort(), [catalog]);
  const isHome = page.kind === "home";

  const setSections = (fn: (s: Section[]) => Section[]) => setD((x) => ({ ...x, sections: fn(x.sections) }));
  const move = (from: number, to: number) => setSections((s) => {
    if (to < 0 || to >= s.length || from === to) return s;
    const next = [...s];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    return next;
  });
  const addSection = (type: SectionType) => {
    const s: Section = { id: newSectionId(), type, visible: true, props: structuredClone(SECTION_DEFAULTS[type]) };
    setSections((list) => [...list, s]);
    setOpen(s.id);
    setAdding(false);
  };

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await savePage({ id: d.id, path: d.path, title: d.title, kind: d.kind, show_in_nav: d.show_in_nav, sections: d.sections, seo: d.seo });
      toast.success("Đã lưu bản nháp");
      onSaved();
    } catch (e) {
      setErr(errorText(e, "Không lưu được trang."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[440px_1fr]">
      <div className="space-y-4">
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tên trang"><input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} className={inputCls} /></Field>
            <Field label="Đường dẫn" hint={isHome ? "Trang chủ luôn là /" : undefined}>
              <input value={d.path} disabled={isHome}
                onChange={(e) => setD({ ...d, path: "/" + slugify(e.target.value.replace(/^\//, "")).replace(/-+$/, "") })}
                className={`${inputCls} font-mono`} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={d.show_in_nav} onChange={(e) => setD({ ...d, show_in_nav: e.target.checked })} className="h-4 w-4 accent-indigo-500" />
            Hiện trên menu
          </label>
          <details className="group">
            <summary className="cursor-pointer text-xs font-semibold text-slate-400">SEO — tiêu đề & mô tả trên Google</summary>
            <div className="mt-3 space-y-3">
              <Field label="Tiêu đề Google" hint={`${(d.seo.title || "").length}/60 ký tự nên dùng`}>
                <input value={d.seo.title || ""} maxLength={120} onChange={(e) => setD({ ...d, seo: { ...d.seo, title: e.target.value } })} className={inputCls} />
              </Field>
              <Field label="Mô tả" hint={`${(d.seo.description || "").length}/160 ký tự nên dùng`}>
                <textarea value={d.seo.description || ""} maxLength={320} rows={2} onChange={(e) => setD({ ...d, seo: { ...d.seo, description: e.target.value } })} className={inputCls} />
              </Field>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={Boolean(d.seo.noindex)} onChange={(e) => setD({ ...d, seo: { ...d.seo, noindex: e.target.checked } })} className="h-4 w-4 accent-indigo-500" />
                Ẩn trang này khỏi Google
              </label>
            </div>
          </details>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Khối · kéo để sắp xếp</p>
          <ol className="space-y-2">
            {d.sections.map((s, i) => (
              <li key={s.id}
                draggable
                onDragStart={() => setDragFrom(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragFrom !== null) move(dragFrom, i); setDragFrom(null); }}
                className={`rounded-xl border bg-slate-900 ${dragFrom === i ? "border-indigo-500 opacity-60" : "border-slate-800"}`}>
                <div className="flex items-center gap-1.5 px-2 py-2">
                  <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-600" aria-hidden="true" />
                  <button onClick={() => setOpen(open === s.id ? null : s.id)} className="min-w-0 flex-1 text-left">
                    <span className={`block truncate text-sm font-medium ${s.visible ? "text-slate-200" : "text-slate-500 line-through"}`}>{SECTION_LABELS[s.type]}</span>
                    {s.props.heading && <span className="block truncate text-xs text-slate-500">{s.props.heading}</span>}
                  </button>
                  <button onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Lên" className="rounded p-1 text-slate-500 hover:text-slate-100 disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                  <button onClick={() => move(i, i + 1)} disabled={i === d.sections.length - 1} aria-label="Xuống" className="rounded p-1 text-slate-500 hover:text-slate-100 disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                  <button onClick={() => setSections((l) => l.map((x) => (x.id === s.id ? { ...x, visible: !x.visible } : x)))}
                    aria-label={s.visible ? "Ẩn khối" : "Hiện khối"} className="rounded p-1 text-slate-500 hover:text-slate-100">
                    {s.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                  <button onClick={() => setSections((l) => l.filter((x) => x.id !== s.id))} aria-label="Xóa khối" className="rounded p-1 text-slate-500 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                </div>
                {open === s.id && (
                  <div className="border-t border-slate-800 p-3">
                    <SectionForm type={s.type} props={s.props} categories={categories}
                      onChange={(p) => setSections((l) => l.map((x) => (x.id === s.id ? { ...x, props: p } : x)))} />
                  </div>
                )}
              </li>
            ))}
          </ol>
          {adding ? (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-dashed border-slate-700 p-2">
              {(Object.keys(SECTION_LABELS) as SectionType[]).map((t) => (
                <button key={t} onClick={() => addSection(t)} className="rounded-lg px-2 py-2 text-left text-xs text-slate-300 hover:bg-slate-800">{SECTION_LABELS[t]}</button>
              ))}
              <button onClick={() => setAdding(false)} className="col-span-2 py-1 text-xs text-slate-500 hover:underline">Đóng</button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} disabled={d.sections.length >= 40}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-700 py-2.5 text-sm text-slate-400 hover:border-indigo-500 hover:text-indigo-500">
              <Plus className="h-4 w-4" /> Thêm khối
            </button>
          )}
        </div>

        <ErrorLine text={err} />
        <div className="sticky bottom-3 flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/95 p-3 backdrop-blur">
          <span className="text-xs text-slate-500">{dirty ? "Có thay đổi chưa lưu" : "Đã lưu bản nháp"}</span>
          <div className="flex gap-2">
            {dirty && <button onClick={() => setD(toDraft(page))} className="rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-300">Hoàn tác</button>}
            <button onClick={save} disabled={!dirty || busy || !d.title.trim()}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
              {busy ? "Đang lưu…" : "Lưu nháp"}
            </button>
          </div>
        </div>
      </div>

      <div className="h-[calc(100vh-11rem)] min-h-[480px] xl:sticky xl:top-20">
        <Preview site={site} sections={d.sections} catalog={catalog} />
      </div>
    </div>
  );
}
