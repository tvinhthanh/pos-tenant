"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import api from "@/utils/api";
import {
  addRentalUnits, deleteRentalRate, listRentalItems, saveRentalItem, saveRentalRate, setUnitStatus, vnd,
  RATE_UNIT_LABELS, TRACKING_LABELS, UNIT_STATUS_LABELS,
  type RateUnit, type RentalItem, type RentalRate, type TrackingMode, type UnitStatus,
} from "@/utils/rental";
import { errorText, toast } from "@/components/Toaster";

const input = "w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none";
const label = "mb-1 block text-xs font-medium text-slate-400";
const btnPrimary = "rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50";
const btnGhost = "rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900";

export default function RentalCatalogPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RentalItem | "new" | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const { data: items = [], isLoading, error } = useQuery({
    queryKey: ["rentalItems", showInactive],
    queryFn: () => listRentalItems(showInactive),
  });
  const { data: me } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => (await api.get("/api/v1/auth/me")).data as { role: string },
  });
  const canEdit = me?.role === "owner" || me?.role === "manager" || me?.role === "superadmin";
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["rentalItems"] });
    queryClient.invalidateQueries({ queryKey: ["rentalBoard"] });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Danh mục cho thuê</h1>
          <p className="text-sm text-slate-400">Món, bảng giá, từng chiếc và số lượng.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Hiện món đã ngừng
          </label>
          {canEdit && (
            <button className={`${btnPrimary} flex items-center gap-1.5`} onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> Thêm món
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-rose-500">{errorText(error, "Không tải được danh mục.")}</p>}
      {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}
      {!isLoading && items.length === 0 && (
        <p className="rounded-2xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-400">
          Chưa có món nào{canEdit ? ". Bấm “Thêm món” để bắt đầu." : "."}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} canEdit={canEdit} onEdit={() => setEditing(item)} onChanged={refresh} />
        ))}
      </div>

      {editing && (
        <ItemDialog item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
    </div>
  );
}

function ItemCard({ item, canEdit, onEdit, onChanged }: { item: RentalItem; canEdit: boolean; onEdit: () => void; onChanged: () => void }) {
  const [codes, setCodes] = useState("");
  const [rateDraft, setRateDraft] = useState<Partial<RentalRate> | null>(null);

  const addUnits = useMutation({
    mutationFn: () => addRentalUnits(item.id, codes.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean)),
    onSuccess: () => { setCodes(""); toast.success("Đã thêm chiếc"); onChanged(); },
    onError: (e) => toast.error(errorText(e, "Không thêm được (mã có thể đã tồn tại).")),
  });
  const unitStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: UnitStatus }) => setUnitStatus(id, status),
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(errorText(e, "Không đổi được trạng thái.")),
  });
  const removeRate = useMutation({
    mutationFn: (id: number) => deleteRentalRate(id),
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(errorText(e, "Không xóa được giá.")),
  });

  const units = [...item.rental_units].sort((a, b) => a.code.localeCompare(b.code));

  return (
    <section className={`space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 ${item.is_active ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-100">{item.name} {!item.is_active && <span className="text-xs text-slate-500">(ngừng cho thuê)</span>}</h2>
          <p className="text-xs text-slate-500">
            {TRACKING_LABELS[item.tracking_mode]}{item.category ? ` · ${item.category}` : ""}
            {item.tracking_mode === "bulk" ? ` · Tổng ${item.bulk_quantity}` : ` · ${units.filter((u) => u.status !== "retired").length} chiếc`}
          </p>
          <p className="mt-1 text-xs text-slate-400">Cọc {vnd(item.deposit_amount)} · Đền khi mất {vnd(item.replacement_value)}</p>
        </div>
        {canEdit && (
          <button onClick={onEdit} aria-label="Sửa món" className="rounded-lg p-2 text-slate-500 hover:text-slate-100"><Pencil className="h-4 w-4" /></button>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Bảng giá</h3>
          {canEdit && (
            <button className="text-xs font-semibold text-indigo-500 hover:underline"
              onClick={() => setRateDraft({ rate_unit: "day", price: 0, min_units: 1, grace_minutes: 0, cap_per_day: null, is_default: item.rental_rates.length === 0 })}>
              + Thêm giá
            </button>
          )}
        </div>
        {item.rental_rates.length === 0 && <p className="text-xs text-rose-500">Chưa có giá — chưa cho thuê được.</p>}
        <ul className="space-y-1 text-sm">
          {item.rental_rates.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-slate-300">
              <span className="font-semibold text-slate-100">{vnd(r.price)}</span>/{RATE_UNIT_LABELS[r.rate_unit]}
              <span className="text-xs text-slate-500">
                {r.min_units > 1 && `tối thiểu ${r.min_units} · `}
                {r.grace_minutes > 0 && `ân hạn ${r.grace_minutes} phút · `}
                {r.cap_per_day != null && `tối đa ${vnd(r.cap_per_day)}/ngày · `}
                {r.is_default && "mặc định"}
              </span>
              {canEdit && (
                <span className="ml-auto flex gap-1">
                  <button aria-label="Sửa giá" onClick={() => setRateDraft(r)} className="p-1 text-slate-500 hover:text-slate-100"><Pencil className="h-3.5 w-3.5" /></button>
                  <button aria-label="Xóa giá" onClick={() => removeRate.mutate(r.id)} className="p-1 text-slate-500 hover:text-rose-500"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {rateDraft && <RateForm itemId={item.id} draft={rateDraft} onClose={() => setRateDraft(null)} onSaved={onChanged} />}
      </div>

      {item.tracking_mode !== "bulk" && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Từng chiếc</h3>
          <ul className="divide-y divide-slate-800 text-sm">
            {units.map((u) => (
              <li key={u.id} className="flex items-center gap-2 py-1.5">
                <span className="font-mono text-slate-100">{u.code}</span>
                <span className="text-xs text-slate-500">{UNIT_STATUS_LABELS[u.status]}</span>
                {canEdit && u.status !== "out" && (
                  <select
                    aria-label={`Đổi trạng thái ${u.code}`}
                    value=""
                    onChange={(e) => e.target.value && unitStatus.mutate({ id: u.id, status: e.target.value as UnitStatus })}
                    className="ml-auto rounded-lg border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-300"
                  >
                    <option value="">Đổi trạng thái…</option>
                    {u.status !== "available" && <option value="available">Sẵn sàng</option>}
                    {u.status !== "maintenance" && u.status !== "lost" && <option value="maintenance">Bảo trì</option>}
                    {u.status !== "retired" && <option value="retired">Ngừng dùng</option>}
                  </select>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <div className="mt-2 flex gap-2">
              <input value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="Mã chiếc mới, cách nhau dấu phẩy (AD-03, AD-04)"
                className={input} aria-label="Mã chiếc mới" />
              <button className={btnGhost} disabled={!codes.trim() || addUnits.isPending} onClick={() => addUnits.mutate()}>Thêm</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RateForm({ itemId, draft, onClose, onSaved }: { itemId: number; draft: Partial<RentalRate>; onClose: () => void; onSaved: () => void }) {
  const [rate, setRate] = useState({
    rate_unit: (draft.rate_unit ?? "day") as RateUnit,
    price: draft.price ?? 0,
    min_units: draft.min_units ?? 1,
    grace_minutes: draft.grace_minutes ?? 0,
    cap_per_day: draft.cap_per_day ?? null as number | null,
    is_default: draft.is_default ?? false,
  });
  const save = useMutation({
    mutationFn: () => saveRentalRate({ id: draft.id, item_id: itemId, ...rate }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e) => toast.error(errorText(e, "Không lưu được giá (mỗi đơn vị tính chỉ một giá).")),
  });
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-slate-800 p-3 sm:grid-cols-3">
      <div>
        <label className={label}>Tính theo</label>
        <select value={rate.rate_unit} onChange={(e) => setRate({ ...rate, rate_unit: e.target.value as RateUnit })} className={input}>
          {(Object.keys(RATE_UNIT_LABELS) as RateUnit[]).map((u) => <option key={u} value={u}>{RATE_UNIT_LABELS[u]}</option>)}
        </select>
      </div>
      <div>
        <label className={label}>Giá</label>
        <input type="number" min={0} step={1000} value={rate.price} onChange={(e) => setRate({ ...rate, price: Math.max(0, Number(e.target.value) || 0) })} className={input} />
      </div>
      <div>
        <label className={label}>Tối thiểu (đơn vị)</label>
        <input type="number" min={1} value={rate.min_units} onChange={(e) => setRate({ ...rate, min_units: Math.max(1, Number(e.target.value) || 1) })} className={input} />
      </div>
      <div>
        <label className={label}>Ân hạn trả trễ (phút)</label>
        <input type="number" min={0} max={1440} value={rate.grace_minutes} onChange={(e) => setRate({ ...rate, grace_minutes: Math.max(0, Number(e.target.value) || 0) })} className={input} />
      </div>
      {rate.rate_unit === "hour" && (
        <div>
          <label className={label}>Tối đa mỗi 24 giờ</label>
          <input type="number" min={0} step={1000} value={rate.cap_per_day ?? ""} placeholder="Không giới hạn"
            onChange={(e) => setRate({ ...rate, cap_per_day: e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0) })} className={input} />
        </div>
      )}
      <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-400">
        <input type="checkbox" checked={rate.is_default} onChange={(e) => setRate({ ...rate, is_default: e.target.checked })} /> Giá mặc định
      </label>
      <div className="col-span-full flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Hủy</button>
        <button className={btnPrimary} disabled={save.isPending} onClick={() => save.mutate()}>Lưu giá</button>
      </div>
    </div>
  );
}

function ItemDialog({ item, onClose, onSaved }: { item: RentalItem | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: item?.name ?? "",
    category: item?.category ?? "",
    description: item?.description ?? "",
    tracking_mode: (item?.tracking_mode ?? "serialized") as TrackingMode,
    bulk_quantity: item?.bulk_quantity ?? 0,
    deposit_amount: item?.deposit_amount ?? 0,
    replacement_value: item?.replacement_value ?? 0,
    is_active: item?.is_active ?? true,
  });
  const [err, setErr] = useState("");
  const save = useMutation({
    mutationFn: () => saveRentalItem({ id: item?.id, ...form }),
    onSuccess: () => { toast.success(item ? "Đã lưu món" : "Đã thêm món — nhớ thêm giá và từng chiếc"); onSaved(); onClose(); },
    onError: (e) => setErr(errorText(e, "Không lưu được món.")),
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-6" role="dialog" aria-modal="true" aria-label="Món cho thuê">
      <form onSubmit={(e) => { e.preventDefault(); setErr(""); save.mutate(); }}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-100">{item ? "Sửa món" : "Thêm món cho thuê"}</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="rounded-lg p-1 text-slate-500 hover:text-slate-100"><X className="h-4 w-4" /></button>
        </div>
        {err && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-sm text-rose-500">{err}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={label}>Tên món</label>
            <input required maxLength={160} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
          </div>
          <div>
            <label className={label}>Nhóm</label>
            <input value={form.category} placeholder="Áo dài, Xe máy…" onChange={(e) => setForm({ ...form, category: e.target.value })} className={input} />
          </div>
          <div>
            <label className={label}>Cách theo dõi</label>
            <select value={form.tracking_mode} disabled={Boolean(item)} onChange={(e) => setForm({ ...form, tracking_mode: e.target.value as TrackingMode })} className={input}>
              {(Object.keys(TRACKING_LABELS) as TrackingMode[]).map((t) => <option key={t} value={t}>{TRACKING_LABELS[t]}</option>)}
            </select>
          </div>
          {form.tracking_mode === "bulk" && (
            <div>
              <label className={label}>Tổng số lượng</label>
              <input type="number" min={0} value={form.bulk_quantity} onChange={(e) => setForm({ ...form, bulk_quantity: Math.max(0, Number(e.target.value) || 0) })} className={input} />
            </div>
          )}
          <div>
            <label className={label}>Tiền cọc mỗi {form.tracking_mode === "bulk" ? "cái" : "chiếc"}</label>
            <input type="number" min={0} step={1000} value={form.deposit_amount} onChange={(e) => setForm({ ...form, deposit_amount: Math.max(0, Number(e.target.value) || 0) })} className={input} />
          </div>
          <div>
            <label className={label}>Giá trị đền khi mất</label>
            <input type="number" min={0} step={1000} value={form.replacement_value} onChange={(e) => setForm({ ...form, replacement_value: Math.max(0, Number(e.target.value) || 0) })} className={input} />
          </div>
          {item && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Đang cho thuê
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Hủy</button>
          <button type="submit" className={btnPrimary} disabled={save.isPending || !form.name.trim()}>{save.isPending ? "Đang lưu…" : "Lưu"}</button>
        </div>
      </form>
    </div>
  );
}
