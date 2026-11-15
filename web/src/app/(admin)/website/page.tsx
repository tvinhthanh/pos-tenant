"use client";

import React, { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FilePlus2, GripVertical, Trash2 } from "lucide-react";
import { ErrorLine, Field, Modal, PageHead, inputCls } from "@/components/RetailUi";
import PageEditor from "@/components/website/PageEditor";
import { DomainPanel, InfoPanel, TemplateGrid, ThemePanel } from "@/components/website/Panels";
import { errorText, toast } from "@/components/Toaster";
import {
  deletePage, getEditor, getOnlineSettings, initSite, previewCatalog, publishSite, reorderPages, savePage,
  type EditorData,
} from "@/utils/website";
import { slugify, type PublicSite, type SiteTheme } from "@/utils/site";

type Tab = "pages" | "theme" | "info" | "domain";
const TABS: [Tab, string][] = [["pages", "Trang"], ["theme", "Giao diện"], ["info", "Thông tin"], ["domain", "Địa chỉ web"]];
const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || "";

export default function WebsitePage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["siteEditor"], queryFn: getEditor });
  const { data: online } = useQuery({ queryKey: ["onlineSettings"], queryFn: getOnlineSettings, enabled: Boolean(data?.site) });
  const { data: catalog = [] } = useQuery({
    queryKey: ["sitePreviewCatalog", data?.branch.business_type],
    queryFn: () => previewCatalog(data!.branch.business_type),
    enabled: Boolean(data),
  });
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["siteEditor"] }), [qc]);

  const init = useMutation({
    mutationFn: initSite,
    onSuccess: () => { toast.success("Đã tạo website từ mẫu"); refresh(); },
    onError: (e) => toast.error(errorText(e, "Không tạo được website.")),
  });

  if (isLoading) return <p className="text-sm text-slate-500">Đang tải…</p>;
  if (error) return <ErrorLine text={errorText(error, "Không tải được website.")} />;
  if (!data) return null;

  if (!data.site) {
    return (
      <div className="space-y-6">
        <PageHead title="Website" sub="Chọn một mẫu để bắt đầu. Có sẵn trang chủ, danh mục, liên hệ — sửa nội dung sau." />
        <TemplateGrid templates={data.templates} businessType={data.branch.business_type} onPick={(id) => init.mutate(id)} busy={init.isPending} />
      </div>
    );
  }

  return <Editor data={data} catalog={catalog} online={online ?? null} refresh={refresh} />;
}

function Editor({ data, catalog, online, refresh }: {
  data: EditorData; catalog: Awaited<ReturnType<typeof previewCatalog>>;
  online: Awaited<ReturnType<typeof getOnlineSettings>>; refresh: () => void;
}) {
  const [tab, setTab] = useState<Tab>("pages");
  const [pageId, setPageId] = useState<number>(data.pages[0]?.id);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const template = data.templates.find((t) => t.id === data.site!.template_id);
  const theme = useMemo(() => ({ ...(template?.theme as SiteTheme), ...data.site!.theme }) as SiteTheme, [template, data.site]);
  const page = data.pages.find((p) => p.id === pageId) ?? data.pages[0];

  // Website dựng từ bản nháp cho khung xem trước
  const previewSite: PublicSite = useMemo(() => ({
    shop: data.branch.subdomain || "", name: data.branch.name, tagline: null, business_type: data.branch.business_type,
    address: data.branch.address, phone: data.branch.phone, logo_url: theme.logo || data.branch.logo_url, theme,
    integrations: data.site!.integrations || {}, opening_hours: data.site!.opening_hours || [], published_at: null, custom_domain: null,
    nav: data.pages.filter((p) => p.show_in_nav).map((p) => ({ path: p.path, title: p.title })),
    online: online ? {
      accept_orders: online.accept_orders && data.branch.business_type !== "rental",
      accept_reservations: online.accept_reservations && data.branch.business_type === "rental",
      fulfillments: online.fulfillments, min_order_amount: online.min_order_amount, notice: online.notice,
    } : null,
  }), [data, theme, online]);

  const unpublished = data.pages.some((p) => JSON.stringify(p.draft_sections) !== JSON.stringify(p.published_sections));
  const siteUrl = data.branch.subdomain
    ? (PLATFORM_DOMAIN ? `${PLATFORM_DOMAIN.includes("localhost") ? "http" : "https"}://${data.branch.subdomain}.${PLATFORM_DOMAIN}${PLATFORM_DOMAIN.includes("localhost") ? ":3000" : ""}` : `/site/${data.branch.subdomain}`)
    : null;

  const publish = useMutation({
    mutationFn: () => publishSite(true),
    onSuccess: (r) => { toast.success(`Đã xuất bản ${r.pages} trang`); refresh(); },
    onError: (e) => toast.error(errorText(e, "Không xuất bản được.")),
  });
  const unpublish = useMutation({
    mutationFn: () => publishSite(false),
    onSuccess: () => { toast.success("Đã tạm ẩn website"); refresh(); },
    onError: (e) => toast.error(errorText(e, "Không ẩn được.")),
  });
  const remove = useMutation({
    mutationFn: deletePage,
    onSuccess: () => { toast.success("Đã xóa trang"); setPageId(data.pages[0]?.id); refresh(); },
    onError: (e) => toast.error(errorText(e, "Không xóa được trang.")),
  });

  const pick = (id: number) => {
    if (dirty && !confirm("Trang đang sửa có thay đổi chưa lưu. Bỏ thay đổi?")) return;
    setPageId(id);
  };
  const dropPage = async (to: number) => {
    if (dragFrom === null || dragFrom === to) return;
    const ids = data.pages.map((p) => p.id);
    const [it] = ids.splice(dragFrom, 1);
    ids.splice(to, 0, it);
    setDragFrom(null);
    try { await reorderPages(ids); refresh(); } catch (e) { toast.error(errorText(e, "Không sắp xếp được.")); }
  };

  return (
    <div className="space-y-5">
      <PageHead title="Website" sub={data.site!.is_published
        ? `Đang chạy${data.site!.published_at ? ` · xuất bản ${new Date(data.site!.published_at).toLocaleString("vi-VN")}` : ""}`
        : "Chưa xuất bản — khách chưa thấy website."}>
        {siteUrl && data.site!.is_published && (
          <a href={siteUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-900">
            <ExternalLink className="h-4 w-4" /> Xem website
          </a>
        )}
        {data.site!.is_published && (
          <button onClick={() => { if (confirm("Tạm ẩn website? Khách sẽ không vào được.")) unpublish.mutate(); }}
            className="rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-400 hover:bg-slate-900">Tạm ẩn</button>
        )}
        <button onClick={() => publish.mutate()} disabled={publish.isPending || dirty || !data.branch.subdomain}
          title={!data.branch.subdomain ? "Đặt địa chỉ web trước" : dirty ? "Lưu nháp trang đang sửa trước" : undefined}
          className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
          {publish.isPending ? "Đang xuất bản…" : unpublished || !data.site!.is_published ? "Xuất bản" : "Đã xuất bản"}
        </button>
      </PageHead>

      {!data.branch.subdomain && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600">
          Shop chưa có địa chỉ web. Vào tab <button onClick={() => setTab("domain")} className="font-semibold underline">Địa chỉ web</button> để đặt, rồi mới xuất bản được.
        </p>
      )}

      <div role="tablist" className="flex gap-1 border-b border-slate-800">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            onClick={() => { if (tab === "pages" && dirty && !confirm("Trang đang sửa có thay đổi chưa lưu. Bỏ thay đổi?")) return; setDirty(false); setTab(k); }}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === k ? "border-indigo-500 text-indigo-500" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "pages" && page && (
        <div className="grid gap-4 lg:grid-cols-[200px_1fr]">
          <aside className="space-y-2">
            <ul className="space-y-1">
              {data.pages.map((p, i) => {
                const changed = JSON.stringify(p.draft_sections) !== JSON.stringify(p.published_sections);
                return (
                  <li key={p.id} draggable onDragStart={() => setDragFrom(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => dropPage(i)}
                    className={`group flex items-center gap-1 rounded-xl px-2 py-2 ${p.id === page.id ? "bg-indigo-500/10" : "hover:bg-slate-900"}`}>
                    <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-600" aria-hidden="true" />
                    <button onClick={() => pick(p.id)} className="min-w-0 flex-1 text-left">
                      <span className={`block truncate text-sm ${p.id === page.id ? "font-semibold text-indigo-500" : "text-slate-200"}`}>{p.title}</span>
                      <span className="block truncate font-mono text-[11px] text-slate-500">{p.path}{changed ? " · chưa xuất bản" : ""}</span>
                    </button>
                    {p.kind !== "home" && (
                      <button onClick={() => { if (confirm(`Xóa trang "${p.title}"?`)) remove.mutate(p.id); }} aria-label={`Xóa ${p.title}`}
                        className="rounded p-1 text-slate-600 opacity-0 hover:text-rose-500 group-hover:opacity-100 focus:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                    )}
                  </li>
                );
              })}
            </ul>
            <button onClick={() => setAdding(true)} disabled={data.pages.length >= data.limits.max_site_pages}
              className="flex w-full items-center gap-1.5 rounded-xl px-2 py-2 text-sm text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40">
              <FilePlus2 className="h-4 w-4" /> Thêm trang
            </button>
            <p className="px-2 text-[11px] text-slate-500">{data.pages.length}/{data.limits.max_site_pages} trang theo gói</p>
          </aside>
          <PageEditor page={page} site={previewSite} catalog={catalog} onSaved={refresh} onDirty={setDirty} />
        </div>
      )}
      {tab === "theme" && <ThemePanel data={data} baseTheme={template!.theme} onSaved={refresh} />}
      {tab === "info" && <InfoPanel data={data} onSaved={refresh} />}
      {tab === "domain" && <DomainPanel data={data} onSaved={refresh} />}

      {adding && <AddPageDialog onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); refresh(); setPageId(id); }} />}
    </div>
  );
}

function AddPageDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState("");
  const effPath = touched ? path : `/${slugify(title)}`;
  const m = useMutation({
    mutationFn: () => savePage({ path: effPath, title: title.trim(), show_in_nav: true, sections: [], seo: {} }),
    onSuccess: (r) => { toast.success("Đã thêm trang"); onCreated(r.id); },
    onError: (e) => setErr(errorText(e, "Không thêm được trang.")),
  });
  return (
    <Modal title="Thêm trang" onClose={onClose}>
      <Field label="Tên trang"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Khuyến mãi" className={inputCls} /></Field>
      <Field label="Đường dẫn" hint="Chữ thường không dấu, gạch ngang">
        <input value={effPath} onChange={(e) => { setTouched(true); setPath("/" + slugify(e.target.value.replace(/^\//, ""))); }} className={`${inputCls} font-mono`} />
      </Field>
      <ErrorLine text={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Hủy</button>
        <button onClick={() => { setErr(""); m.mutate(); }} disabled={!title.trim() || effPath === "/" || m.isPending}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Thêm</button>
      </div>
    </Modal>
  );
}
