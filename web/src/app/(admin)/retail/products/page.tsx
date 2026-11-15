"use client";

import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Barcode, Pencil, Plus, Printer, Search, Tag, Trash2 } from "lucide-react";
import { changeProductPrice, getBranchProfile } from "@/utils/rpc";
import { getCatalog, saveGoods, vnd, qty, type Goods, type GoodsInput } from "@/utils/retail";
import { code128Svg, isEncodable, labelsHtml, LABEL_SIZES, type LabelSize } from "@/utils/barcode";
import { printHtml } from "@/utils/printer";
import { errorText, toast } from "@/components/Toaster";
import { ErrorLine, Field, GoodsPicker, Modal, NumberInput, PageHead, inputCls } from "@/components/RetailUi";

type Filter = "active" | "low" | "inactive";

export default function RetailProductsPage() {
  const [filter, setFilter] = useState<Filter>("active");
  const [term, setTerm] = useState("");
  const [editing, setEditing] = useState<Goods | "new" | null>(null);
  const [pricing, setPricing] = useState<Goods | null>(null);
  const [labels, setLabels] = useState<Goods[] | null>(null);

  const { data = [], isLoading, error } = useQuery({ queryKey: ["retailCatalog", "all"], queryFn: () => getCatalog(true) });

  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    return data.filter((g) => {
      if (filter === "active" && !g.is_active) return false;
      if (filter === "inactive" && g.is_active) return false;
      if (filter === "low" && !(g.is_active && g.low_stock)) return false;
      return !t || g.name.toLowerCase().includes(t) || g.barcode?.includes(t) || g.sku?.toLowerCase().includes(t);
    });
  }, [data, filter, term]);

  const active = data.filter((g) => g.is_active);
  const stockValue = active.reduce((s, g) => s + g.stock * (g.cost_price ?? 0), 0);
  const lowCount = active.filter((g) => g.low_stock).length;

  return (
    <div className="space-y-6">
      <PageHead title="Sản phẩm" sub="Giá vốn bình quân tự cập nhật khi nhập hàng. Đổi giá bán đi qua duyệt.">
        <button onClick={() => setLabels([])}
          className="flex items-center gap-1.5 rounded-xl border border-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">
          <Printer className="h-4 w-4" /> In tem mã vạch
        </button>
        <button onClick={() => setEditing("new")}
          className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          <Plus className="h-4 w-4" /> Thêm sản phẩm
        </button>
      </PageHead>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Đang bán" value={String(active.length)} />
        <Stat label="Giá trị tồn kho" value={vnd(stockValue)} />
        <Stat label="Sắp hết hàng" value={String(lowCount)} danger={lowCount > 0} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {([["active", "Đang bán"], ["low", "Sắp hết"], ["inactive", "Ngừng bán"]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${filter === k ? "border-indigo-500 bg-indigo-500/10 text-indigo-500" : "border-slate-800 text-slate-400"}`}>
            {label}
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Tên, mã vạch, SKU…" aria-label="Tìm sản phẩm"
            className={`${inputCls} pl-9`} />
        </div>
      </div>

      {error && <ErrorLine text={errorText(error, "Không tải được sản phẩm.")} />}
      {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}

      {!isLoading && data.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-400">
          Chưa có sản phẩm. Bấm <b>Thêm sản phẩm</b> để tạo mặt hàng đầu tiên kèm tồn đầu kỳ.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Sản phẩm</th>
                <th className="px-4 py-2.5">Mã vạch / SKU</th>
                <th className="px-4 py-2.5 text-right">Giá bán</th>
                <th className="px-4 py-2.5 text-right">Giá vốn</th>
                <th className="px-4 py-2.5 text-right">Tồn</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((g) => {
                const margin = g.cost_price != null && g.price > 0 ? Math.round(((g.price - g.cost_price) / g.price) * 100) : null;
                return (
                  <tr key={g.id} className={g.is_active ? "text-slate-200" : "text-slate-500"}>
                    <td className="px-4 py-2.5">
                      <p className="font-medium">{g.name}</p>
                      <p className="text-xs text-slate-500">{g.category}</p>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-400">
                      {g.barcode || "—"}{g.sku ? <span className="block text-slate-500">{g.sku}</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{vnd(g.price)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                      {g.cost_price == null ? "—" : vnd(g.cost_price)}
                      {margin != null && <span className={`block text-[11px] ${margin < 0 ? "text-rose-500" : "text-slate-500"}`}>lãi {margin}%</span>}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${g.low_stock && g.is_active ? "font-semibold text-amber-600" : ""}`}>
                      {qty(g.stock)} <span className="text-xs text-slate-500">{g.unit}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => setLabels([g])} disabled={!g.is_active} title="In tem mã vạch" aria-label={`In tem ${g.name}`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"><Barcode className="h-4 w-4" /></button>
                        <button onClick={() => setPricing(g)} disabled={!g.is_active} title="Đổi giá bán" aria-label={`Đổi giá ${g.name}`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"><Tag className="h-4 w-4" /></button>
                        <button onClick={() => setEditing(g)} title="Sửa" aria-label={`Sửa ${g.name}`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"><Pencil className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">Không có sản phẩm phù hợp.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && <GoodsDialog goods={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {pricing && <PriceDialog goods={pricing} onClose={() => setPricing(null)} />}
      {labels && <LabelDialog initial={labels} catalog={active} onClose={() => setLabels(null)} />}
    </div>
  );
}

/** Mã in trên tem: mã vạch của sản phẩm, không có thì SKU (máy quét ở màn Bán hàng nhận cả hai). */
const labelCode = (g: Goods) => g.barcode || g.sku || "";

function LabelDialog({ initial, catalog, onClose }: { initial: Goods[]; catalog: Goods[]; onClose: () => void }) {
  const [rows, setRows] = useState(() => initial.map((g) => ({ goods: g, copies: 1 as number | "" })));
  const [size, setSize] = useState<LabelSize>("50x30");
  const [showPrice, setShowPrice] = useState(true);
  const [showShop, setShowShop] = useState(true);
  const { data: profile } = useQuery({ queryKey: ["branchProfile"], queryFn: getBranchProfile });
  const shopName = profile?.receipt_name || profile?.organization_name || "";

  const add = (g: Goods) =>
    setRows((rs) => (rs.some((r) => r.goods.id === g.id)
      ? rs.map((r) => (r.goods.id === g.id ? { ...r, copies: Number(r.copies || 0) + 1 } : r))
      : [...rs, { goods: g, copies: 1 }]));
  const printable = rows.filter((r) => isEncodable(labelCode(r.goods)) && Number(r.copies) > 0);
  const missing = rows.filter((r) => !isEncodable(labelCode(r.goods)));
  const totalCopies = printable.reduce((s, r) => s + Number(r.copies), 0);
  const first = printable[0]?.goods;

  const print = () => {
    printHtml(labelsHtml(
      printable.map((r) => ({ name: r.goods.name, price: r.goods.price, code: labelCode(r.goods), copies: Number(r.copies) })),
      size, { showPrice, shopName: showShop ? shopName : undefined }));
  };

  return (
    <Modal title="In tem mã vạch" onClose={onClose} wide>
      <GoodsPicker catalog={catalog} onPick={add} placeholder="Quét mã hoặc gõ tên sản phẩm cần in tem" />
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">Chọn sản phẩm cần in tem.</p>
      ) : (
        <ul className="max-h-64 divide-y divide-slate-800 overflow-y-auto rounded-xl border border-slate-800">
          {rows.map((r) => (
            <li key={r.goods.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 text-slate-200">
                <span className="block truncate">{r.goods.name}</span>
                <span className={`font-mono text-xs ${labelCode(r.goods) ? "text-slate-500" : "text-rose-500"}`}>
                  {labelCode(r.goods) || "Chưa có mã vạch / SKU — sửa sản phẩm để thêm mã"} · {vnd(r.goods.price)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-xs text-slate-500">Số tem</span>
                <NumberInput value={r.copies} onChange={(v) => setRows((rs) => rs.map((x) => (x.goods.id === r.goods.id ? { ...x, copies: v } : x)))}
                  aria-label={`Số tem ${r.goods.name}`} className="w-16 py-1" />
                <button onClick={() => setRows((rs) => rs.filter((x) => x.goods.id !== r.goods.id))} aria-label={`Bỏ ${r.goods.name}`}
                  className="text-slate-500 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Khổ tem">
          <select value={size} onChange={(e) => setSize(e.target.value as LabelSize)} className={inputCls}>
            {(Object.keys(LABEL_SIZES) as LabelSize[]).map((k) => <option key={k} value={k}>{LABEL_SIZES[k].label}</option>)}
          </select>
        </Field>
        <div className="flex flex-col justify-end gap-1.5 pb-1 text-sm text-slate-300">
          <label className="flex items-center gap-2"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} className="h-4 w-4 accent-indigo-500" /> In giá bán</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={showShop} onChange={(e) => setShowShop(e.target.checked)} className="h-4 w-4 accent-indigo-500" /> In tên cửa hàng{shopName ? ` (${shopName})` : ""}</label>
        </div>
      </div>

      {first && (
        <div className="flex items-center gap-4 rounded-xl border border-slate-800 bg-white p-3 text-black">
          <div className="w-48 text-center">
            <p className="truncate text-xs">{first.name}</p>
            {showPrice && <p className="text-sm font-bold">{vnd(first.price)}</p>}
            <div className="h-10" dangerouslySetInnerHTML={{ __html: code128Svg(labelCode(first)).replace("<svg ", '<svg style="width:100%;height:100%" ') }} />
            <p className="font-mono text-[10px]">{labelCode(first)}</p>
          </div>
          <p className="text-xs text-slate-600">Xem trước tem đầu tiên. Máy in tem: chọn đúng khổ giấy trong hộp thoại in, lề = 0.</p>
        </div>
      )}

      {missing.length > 0 && <p className="text-xs text-amber-600">{missing.length} sản phẩm chưa có mã in được sẽ bị bỏ qua.</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Đóng</button>
        <button onClick={print} disabled={totalCopies === 0}
          className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
          <Printer className="h-4 w-4" /> In {totalCopies} tem
        </button>
      </div>
    </Modal>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${danger ? "text-amber-600" : "text-slate-100"}`}>{value}</p>
    </div>
  );
}

function GoodsDialog({ goods, onClose }: { goods: Goods | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = !goods;
  const [f, setF] = useState({
    name: goods?.name ?? "",
    category: goods?.category ?? "",
    unit: goods?.unit ?? "cái",
    barcode: goods?.barcode ?? "",
    sku: goods?.sku ?? "",
    min_stock: (goods?.min_stock ?? 0) as number | "",
    is_active: goods?.is_active ?? true,
    price: "" as number | "",
    opening_stock: "" as number | "",
    opening_cost: "" as number | "",
  });
  const [err, setErr] = useState("");
  const set = (patch: Partial<typeof f>) => setF((s) => ({ ...s, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const input: GoodsInput = {
        id: goods?.id,
        name: f.name.trim(),
        category: f.category.trim() || undefined,
        unit: f.unit.trim() || undefined,
        barcode: f.barcode.trim() || null,
        sku: f.sku.trim() || null,
        min_stock: Number(f.min_stock || 0),
        image_url: goods?.image_url ?? null,
        is_active: f.is_active,
      };
      if (isNew) {
        input.price = Number(f.price || 0);
        input.opening_stock = Number(f.opening_stock || 0);
        input.opening_cost = Number(f.opening_cost || 0);
      }
      return saveGoods(input);
    },
    onSuccess: () => {
      toast.success(isNew ? "Đã thêm sản phẩm" : "Đã lưu");
      qc.invalidateQueries({ queryKey: ["retailCatalog"] });
      onClose();
    },
    onError: (e) => setErr(errorText(e, "Không lưu được sản phẩm.")),
  });

  const valid = f.name.trim() && (!isNew || f.price !== "") && (!isNew || !Number(f.opening_stock) || f.opening_cost !== "");

  return (
    <Modal title={isNew ? "Thêm sản phẩm" : `Sửa: ${goods!.name}`} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Tên sản phẩm *"><input autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} /></Field></div>
        <Field label="Mã vạch" hint="Quét thẳng vào ô này"><input value={f.barcode} onChange={(e) => set({ barcode: e.target.value })} className={`${inputCls} font-mono`} /></Field>
        <Field label="Mã SKU"><input value={f.sku} onChange={(e) => set({ sku: e.target.value })} className={`${inputCls} font-mono`} /></Field>
        <Field label="Nhóm hàng"><input value={f.category} onChange={(e) => set({ category: e.target.value })} placeholder="Hàng hóa" className={inputCls} /></Field>
        <Field label="Đơn vị tính"><input value={f.unit} onChange={(e) => set({ unit: e.target.value })} className={inputCls} /></Field>
        <Field label="Cảnh báo khi tồn ≤"><NumberInput value={f.min_stock} onChange={(v) => set({ min_stock: v })} /></Field>
        {isNew ? (
          <>
            <Field label="Giá bán *"><NumberInput value={f.price} onChange={(v) => set({ price: v })} /></Field>
            <Field label="Tồn đầu kỳ" hint="Số đang có trên kệ lúc bắt đầu dùng"><NumberInput value={f.opening_stock} onChange={(v) => set({ opening_stock: v })} /></Field>
            <Field label="Giá vốn mỗi đơn vị" hint="Bắt buộc nếu có tồn đầu kỳ"><NumberInput value={f.opening_cost} onChange={(v) => set({ opening_cost: v })} /></Field>
          </>
        ) : (
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-300">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set({ is_active: e.target.checked })} className="h-4 w-4 accent-indigo-500" />
            Đang bán
          </label>
        )}
      </div>
      {!isNew && <p className="text-xs text-slate-500">Giá bán đổi bằng nút <Tag className="inline h-3 w-3" />. Tồn kho thay đổi qua Nhập hàng hoặc Kiểm kê.</p>}
      <ErrorLine text={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Hủy</button>
        <button onClick={() => { setErr(""); save.mutate(); }} disabled={!valid || save.isPending}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
          {save.isPending ? "Đang lưu…" : "Lưu"}
        </button>
      </div>
    </Modal>
  );
}

function PriceDialog({ goods, onClose }: { goods: Goods; onClose: () => void }) {
  const qc = useQueryClient();
  const [price, setPrice] = useState<number | "">(goods.price);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => changeProductPrice(goods.id, Number(price), reason.trim() || undefined),
    onSuccess: (res) => {
      toast.success(res.applied ? "Đã đổi giá" : "Đã gửi yêu cầu đổi giá chờ duyệt");
      qc.invalidateQueries({ queryKey: ["retailCatalog"] });
      onClose();
    },
    onError: (e) => setErr(errorText(e, "Không đổi được giá.")),
  });
  return (
    <Modal title={`Đổi giá: ${goods.name}`} onClose={onClose}>
      <p className="text-sm text-slate-400">Giá hiện tại {vnd(goods.price)}{goods.cost_price != null ? ` · giá vốn ${vnd(goods.cost_price)}` : ""}</p>
      <Field label="Giá bán mới"><NumberInput autoFocus value={price} onChange={setPrice} /></Field>
      <Field label="Lý do"><input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} /></Field>
      {goods.cost_price != null && price !== "" && price < goods.cost_price && (
        <p className="text-xs text-amber-600">Giá mới thấp hơn giá vốn.</p>
      )}
      <ErrorLine text={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Hủy</button>
        <button onClick={() => { setErr(""); m.mutate(); }} disabled={price === "" || price === goods.price || m.isPending}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
          Đổi giá
        </button>
      </div>
    </Modal>
  );
}
