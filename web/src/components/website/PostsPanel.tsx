"use client";

/**
 * Bài viết / tin tức của website shop: danh sách, viết / sửa, đăng / hẹn giờ.
 * Bài đăng hiện ở /tin-tuc ngay (không cần "Xuất bản" website) nếu website đang chạy.
 */
import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, Trash2 } from "lucide-react";
import { ErrorLine, Field, inputCls } from "@/components/RetailUi";
import { ImageInput } from "@/components/website/SectionForm";
import { RichText } from "@/components/site/Sections";
import { errorText, toast } from "@/components/Toaster";
import { deletePost, getPosts, savePost, type SitePost } from "@/utils/website";
import { fmtDateVN, slugify } from "@/utils/site";

type Draft = {
  id?: number; title: string; slug: string; excerpt: string; cover_image: string; body: string;
  status: "draft" | "published"; published_at: string;
};

const blank: Draft = { title: "", slug: "", excerpt: "", cover_image: "", body: "", status: "draft", published_at: "" };

/** ISO ⇄ "YYYY-MM-DDTHH:mm" giờ máy */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusOf(p: SitePost): { label: string; tone: string } {
  if (p.status === "draft") return { label: "Nháp", tone: "bg-slate-800 text-slate-400" };
  if (p.published_at && new Date(p.published_at) > new Date()) return { label: "Hẹn giờ", tone: "bg-amber-500/10 text-amber-600" };
  return { label: "Đã đăng", tone: "bg-emerald-500/10 text-emerald-500" };
}

export default function PostsPanel({ siteUrl }: { siteUrl: string | null }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["sitePosts"], queryFn: getPosts });
  const [edit, setEdit] = useState<Draft | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [err, setErr] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["sitePosts"] });

  const save = useMutation({
    mutationFn: (d: Draft) => savePost({
      id: d.id, title: d.title.trim(), slug: d.slug, excerpt: d.excerpt.trim() || null, cover_image: d.cover_image.trim() || null,
      body: d.body, status: d.status, published_at: d.published_at ? new Date(d.published_at).toISOString() : null,
    }),
    onSuccess: (r, d) => {
      toast.success(d.status === "published" ? "Đã lưu và đăng bài" : "Đã lưu nháp");
      setEdit({ ...d, id: r.id }); refresh();
    },
    onError: (e) => setErr(errorText(e, "Không lưu được bài viết.")),
  });
  const remove = useMutation({
    mutationFn: deletePost,
    onSuccess: () => { toast.success("Đã xóa bài viết"); setEdit(null); refresh(); },
    onError: (e) => toast.error(errorText(e, "Không xóa được.")),
  });

  if (isLoading) return <p className="text-sm text-slate-500">Đang tải…</p>;
  if (error) return <ErrorLine text={errorText(error, "Không tải được bài viết.")} />;
  const posts = data?.posts ?? [];
  const max = data?.limits.max_site_posts ?? 0;

  const open = (p?: SitePost) => {
    setErr("");
    setSlugTouched(Boolean(p));
    setEdit(p ? {
      id: p.id, title: p.title, slug: p.slug, excerpt: p.excerpt ?? "", cover_image: p.cover_image ?? "", body: p.body,
      status: p.status, published_at: toLocalInput(p.published_at),
    } : blank);
  };
  const set = (patch: Partial<Draft>) => setEdit((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-2">
        <button onClick={() => open()} disabled={posts.length >= max}
          className="flex w-full items-center gap-1.5 rounded-xl px-2 py-2 text-sm text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40">
          <FilePlus2 className="h-4 w-4" /> Viết bài mới
        </button>
        <p className="px-2 text-[11px] text-slate-500">{posts.length}/{max} bài theo gói</p>
        {posts.length === 0 && <p className="px-2 text-sm text-slate-500">Chưa có bài nào. Viết tin khai trương, ưu đãi, món mới…</p>}
        <ul className="space-y-1">
          {posts.map((p) => {
            const s = statusOf(p);
            return (
              <li key={p.id}>
                <button onClick={() => open(p)}
                  className={`w-full rounded-xl px-2 py-2 text-left ${edit?.id === p.id ? "bg-indigo-500/10" : "hover:bg-slate-900"}`}>
                  <span className={`block truncate text-sm ${edit?.id === p.id ? "font-semibold text-indigo-500" : "text-slate-200"}`}>{p.title}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                    <span className={`rounded-full px-1.5 py-px ${s.tone}`}>{s.label}</span>
                    {p.published_at ? fmtDateVN(p.published_at) : `sửa ${fmtDateVN(p.updated_at)}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {!edit ? (
        <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-400">
          Chọn một bài để sửa, hoặc viết bài mới. Bài đã đăng hiện ở trang <span className="font-mono">/tin-tuc</span> và menu website.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <Field label="Tiêu đề">
              <input value={edit.title} maxLength={160} className={inputCls}
                onChange={(e) => set({ title: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })} />
            </Field>
            <Field label="Đường dẫn" hint="Chữ thường không dấu, gạch ngang">
              <div className="flex items-center gap-1 text-sm text-slate-500">
                <span className="font-mono">/tin-tuc/</span>
                <input value={edit.slug} className={`${inputCls} font-mono`}
                  onChange={(e) => { setSlugTouched(true); set({ slug: slugify(e.target.value) }); }} />
              </div>
            </Field>
            <Field label="Ảnh bìa"><ImageInput value={edit.cover_image} onChange={(v) => set({ cover_image: v })} label="Ảnh bìa" /></Field>
            <Field label="Mô tả ngắn" hint="Hiện ở danh sách bài và khi chia sẻ (≤ 300 ký tự)">
              <textarea value={edit.excerpt} maxLength={300} rows={2} onChange={(e) => set({ excerpt: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Nội dung" hint="**đậm**, *nghiêng*, dòng bắt đầu bằng “- ” thành danh sách, dòng trống tách đoạn">
              <textarea value={edit.body} maxLength={20000} rows={14} onChange={(e) => set({ body: e.target.value })} className={inputCls} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Trạng thái">
                <select value={edit.status} onChange={(e) => set({ status: e.target.value as Draft["status"] })} className={inputCls}>
                  <option value="draft">Nháp (khách chưa thấy)</option>
                  <option value="published">Đăng</option>
                </select>
              </Field>
              <Field label="Giờ đăng" hint="Để trống = đăng ngay; giờ tương lai = hẹn giờ">
                <input type="datetime-local" value={edit.published_at} onChange={(e) => set({ published_at: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <ErrorLine text={err} />
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => { setErr(""); save.mutate(edit); }} disabled={save.isPending || !edit.title.trim() || !edit.slug}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
                {save.isPending ? "Đang lưu…" : edit.status === "published" ? "Lưu & đăng" : "Lưu nháp"}
              </button>
              {edit.id && siteUrl && edit.status === "published" && (
                <a href={`${siteUrl}/tin-tuc/${edit.slug}`} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-500 hover:underline">Xem trên website</a>
              )}
              {edit.id && (
                <button onClick={() => { if (confirm(`Xóa bài "${edit.title}"?`)) remove.mutate(edit.id!); }}
                  className="ml-auto flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-rose-500 hover:bg-rose-500/10">
                  <Trash2 className="h-4 w-4" /> Xóa
                </button>
              )}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-white p-6 text-[#1c1917]" aria-label="Xem trước">
            <p className="text-xs uppercase tracking-wide text-slate-400">Xem trước</p>
            <h2 className="mt-2 text-2xl font-semibold">{edit.title || "Tiêu đề bài viết"}</h2>
            {edit.cover_image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={edit.cover_image} alt="" className="mt-4 w-full rounded-lg object-cover" />
            )}
            {edit.excerpt && <p className="mt-4 text-slate-500">{edit.excerpt}</p>}
            <RichText text={edit.body} className="mt-4 text-sm leading-relaxed" />
          </div>
        </div>
      )}
    </div>
  );
}
