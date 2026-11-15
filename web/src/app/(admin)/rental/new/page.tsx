"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Plus, Trash2, UserCheck } from "lucide-react";
import {
  createRental, findCustomerByPhone, fromLocalInput, getAvailability, listRentalItems, quoteRental,
  toLocalInput, vnd, PAY_METHOD_LABELS, RATE_UNIT_LABELS,
  type PayMethod, type RateUnit, type RentalItem,
} from "@/utils/rental";
import { errorText, toast } from "@/components/Toaster";

interface LineDraft {
  key: string;
  item_id: number | null;
  unit_id: number | null;       // null = để hệ thống tự chọn chiếc còn trống
  quantity: number;
  rate_unit: RateUnit | null;
  start: string;                // datetime-local
  end: string;                  // datetime-local, rỗng = mở (chỉ phòng / chỗ)
}

const COLLATERAL_KINDS = ["CCCD", "Bằng lái xe", "Giấy tờ xe", "Hộ chiếu", "Khác"];
const input = "w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none";
const label = "mb-1 block text-xs font-medium text-slate-400";

let keySeq = 0;
const newKey = () => `l${++keySeq}`;

function defaultLine(): LineDraft {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  return { key: newKey(), item_id: null, unit_id: null, quantity: 1, rate_unit: null, start: toLocalInput(now), end: toLocalInput(tomorrow) };
}

export default function NewRentalPage() {
  const router = useRouter();
  const [checkout, setCheckout] = useState(true);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [idType, setIdType] = useState("CCCD");
  const [address, setAddress] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([defaultLine()]);
  const [depositAmount, setDepositAmount] = useState<number | null>(null); // null = theo gợi ý
  const [depositMethod, setDepositMethod] = useState<PayMethod>("cash");
  const [collateral, setCollateral] = useState<{ kind: string; description: string }[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const { data: items = [] } = useQuery({ queryKey: ["rentalItems"], queryFn: () => listRentalItems() });
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // Tìm khách theo SĐT (sau khi gõ xong)
  const cleanPhone = phone.replace(/[^0-9+]/g, "");
  const { data: found } = useQuery({
    queryKey: ["rentalCustomer", cleanPhone],
    queryFn: () => findCustomerByPhone(cleanPhone),
    enabled: cleanPhone.length >= 9,
  });
  useEffect(() => {
    if (found) {
      setName(found.name);
      setIdNumber(found.id_number ?? "");
      setIdType(found.id_type ?? "CCCD");
      setAddress(found.address ?? "");
    }
  }, [found]);

  const suggestedDeposit = lines.reduce((sum, l) => {
    const item = l.item_id ? itemById.get(l.item_id) : undefined;
    return sum + (item ? item.deposit_amount * (item.tracking_mode === "bulk" ? l.quantity : 1) : 0);
  }, 0);
  const deposit = depositAmount ?? suggestedDeposit;

  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (found?.is_blacklisted) {
      setError(`Khách nằm trong danh sách không cho thuê: ${found.blacklist_reason ?? "không ghi lý do"}`);
      return;
    }
    const ready = lines.filter((l) => l.item_id);
    if (ready.length === 0) {
      setError("Chọn ít nhất 1 món cho thuê.");
      return;
    }
    setSaving(true);
    try {
      const res = await createRental({
        ...(found ? { customer_id: found.id } : {}),
        customer: { name: name.trim(), phone: cleanPhone, id_number: idNumber.trim(), id_type: idType, address: address.trim() },
        checkout,
        lines: ready.map((l) => ({
          item_id: l.item_id!,
          unit_id: l.unit_id,
          quantity: l.quantity,
          rate_unit: l.rate_unit ?? undefined,
          start: checkout ? null : fromLocalInput(l.start),
          end: fromLocalInput(l.end),
        })),
        deposit: deposit > 0 ? { amount: deposit, method: depositMethod } : undefined,
        collateral: collateral.filter((c) => c.kind.trim()),
        notes: notes.trim() || undefined,
      });
      toast.success(`${checkout ? "Đã giao đồ" : "Đã đặt trước"}: ${res.code}`);
      router.push(`/rental/contracts/${res.contract_id}`);
    } catch (err) {
      setError(errorText(err, "Không tạo được hợp đồng."));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/rental" aria-label="Quay lại" className="rounded-lg p-2 text-slate-400 hover:bg-slate-900"><ArrowLeft className="h-5 w-5" /></Link>
        <h1 className="text-2xl font-bold text-slate-100">Thuê mới</h1>
      </div>

      <div className="inline-flex rounded-xl border border-slate-800 p-1" role="radiogroup" aria-label="Kiểu giao">
        {[{ v: true, t: "Giao ngay" }, { v: false, t: "Đặt trước" }].map((o) => (
          <button
            key={o.t}
            type="button"
            role="radio"
            aria-checked={checkout === o.v}
            onClick={() => setCheckout(o.v)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium ${checkout === o.v ? "bg-indigo-600 text-white" : "text-slate-400"}`}
          >
            {o.t}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {/* Khách */}
      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Khách thuê</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="phone">Số điện thoại</label>
            <input id="phone" required inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={input} placeholder="09xx xxx xxx" />
            {found && !found.is_blacklisted && (
              <p className="mt-1 flex items-center gap-1 text-xs text-emerald-500"><UserCheck className="h-3.5 w-3.5" /> Khách cũ</p>
            )}
            {found?.is_blacklisted && (
              <p className="mt-1 text-xs font-semibold text-rose-500">Không cho thuê: {found.blacklist_reason ?? "trong danh sách đen"}</p>
            )}
          </div>
          <div>
            <label className={label} htmlFor="name">Họ tên</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)} className={input} />
          </div>
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <div>
              <label className={label} htmlFor="idType">Giấy tờ</label>
              <select id="idType" value={idType} onChange={(e) => setIdType(e.target.value)} className={input}>
                {["CCCD", "Hộ chiếu", "Bằng lái"].map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="idNumber">Số giấy tờ</label>
              <input id="idNumber" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} className={input} />
            </div>
          </div>
          <div>
            <label className={label} htmlFor="address">Địa chỉ</label>
            <input id="address" value={address} onChange={(e) => setAddress(e.target.value)} className={input} />
          </div>
        </div>
      </section>

      {/* Món */}
      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Món thuê</h2>
          <button type="button" onClick={() => setLines((ls) => [...ls, defaultLine()])}
            className="flex items-center gap-1 text-xs font-semibold text-indigo-500 hover:underline">
            <Plus className="h-4 w-4" /> Thêm món
          </button>
        </div>
        {items.length === 0 && (
          <p className="text-sm text-slate-500">Chưa có món nào. <Link href="/rental/catalog" className="text-indigo-500 hover:underline">Thêm danh mục</Link></p>
        )}
        {lines.map((line) => (
          <LineEditor
            key={line.key}
            line={line}
            items={items}
            checkout={checkout}
            onChange={(patch) => updateLine(line.key, patch)}
            onRemove={lines.length > 1 ? () => setLines((ls) => ls.filter((l) => l.key !== line.key)) : undefined}
          />
        ))}
      </section>

      {/* Cọc & giấy tờ */}
      <section className="grid gap-5 rounded-2xl border border-slate-800 bg-slate-900 p-5 md:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">Tiền cọc</h2>
          <div className="grid grid-cols-[1fr_9rem] gap-2">
            <input
              type="number" min={0} step={1000} value={deposit}
              onChange={(e) => setDepositAmount(Math.max(0, Number(e.target.value) || 0))}
              className={input} aria-label="Số tiền cọc"
            />
            <select value={depositMethod} onChange={(e) => setDepositMethod(e.target.value as PayMethod)} className={input} aria-label="Phương thức">
              {(Object.keys(PAY_METHOD_LABELS) as PayMethod[]).map((m) => <option key={m} value={m}>{PAY_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
          <p className="text-xs text-slate-500">
            Gợi ý theo danh mục: {vnd(suggestedDeposit)}. Cọc là tiền giữ hộ khách, trừ vào tiền thuê khi tất toán.
          </p>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Giấy tờ / tài sản giữ lại</h2>
            <button type="button" onClick={() => setCollateral((c) => [...c, { kind: "CCCD", description: "" }])}
              className="flex items-center gap-1 text-xs font-semibold text-indigo-500 hover:underline">
              <Plus className="h-4 w-4" /> Thêm
            </button>
          </div>
          {collateral.length === 0 && <p className="text-xs text-slate-500">Không giữ giấy tờ.</p>}
          {collateral.map((c, i) => (
            <div key={i} className="grid grid-cols-[8rem_1fr_auto] gap-2">
              <select value={c.kind} onChange={(e) => setCollateral((cs) => cs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))} className={input} aria-label="Loại giấy tờ">
                {COLLATERAL_KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
              <input value={c.description} placeholder="Ghi chú (số, bản gốc…)" onChange={(e) => setCollateral((cs) => cs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} className={input} />
              <button type="button" aria-label="Xóa" onClick={() => setCollateral((cs) => cs.filter((_, j) => j !== i))} className="rounded-lg p-2 text-slate-500 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <label className={label} htmlFor="notes">Ghi chú hợp đồng</label>
        <textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={input} />
      </section>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-slate-800 bg-slate-950/95 py-4 backdrop-blur">
        <span className="mr-auto text-sm text-slate-400">
          {checkout ? "Giao đồ ngay, cần ca đang mở." : "Đặt trước, giữ chỗ theo thời gian đã chọn."}
        </span>
        <Link href="/rental" className="rounded-xl px-4 py-2.5 text-sm text-slate-400 hover:text-slate-100">Hủy</Link>
        <button type="submit" disabled={saving}
          className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          {saving ? "Đang lưu…" : checkout ? "Giao đồ & thu cọc" : "Đặt trước"}
        </button>
      </div>
    </form>
  );
}

function LineEditor({
  line, items, checkout, onChange, onRemove,
}: {
  line: LineDraft;
  items: RentalItem[];
  checkout: boolean;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove?: () => void;
}) {
  const item = items.find((i) => i.id === line.item_id);
  const startIso = checkout ? new Date().toISOString() : fromLocalInput(line.start);
  const endIso = fromLocalInput(line.end);

  const { data: avail } = useQuery({
    queryKey: ["rentalAvail", line.item_id, checkout ? "now" : startIso, endIso],
    queryFn: () => getAvailability(line.item_id!, startIso!, endIso),
    enabled: Boolean(line.item_id && startIso && (endIso || item?.tracking_mode === "space")),
  });
  const { data: quote, error: quoteError } = useQuery({
    queryKey: ["rentalQuote", line.item_id, line.rate_unit, checkout ? "now" : startIso, endIso, line.quantity],
    queryFn: () => quoteRental(line.item_id!, startIso!, endIso, line.quantity, line.rate_unit ?? undefined),
    enabled: Boolean(line.item_id && startIso && endIso),
  });

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_10rem_auto]">
        <div>
          <label className={label}>Món</label>
          <select
            value={line.item_id ?? ""}
            onChange={(e) => onChange({ item_id: Number(e.target.value) || null, unit_id: null, rate_unit: null, quantity: 1 })}
            className={input}
          >
            <option value="">— Chọn món —</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Tính theo</label>
          <select
            value={line.rate_unit ?? ""}
            onChange={(e) => onChange({ rate_unit: (e.target.value || null) as RateUnit | null })}
            className={input}
            disabled={!item}
          >
            <option value="">Mặc định</option>
            {item?.rental_rates.map((r) => (
              <option key={r.id} value={r.rate_unit}>{vnd(r.price)} / {RATE_UNIT_LABELS[r.rate_unit]}</option>
            ))}
          </select>
        </div>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label="Bỏ món" className="self-end rounded-lg p-2 text-slate-500 hover:text-rose-500">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {!checkout && (
          <div>
            <label className={label}>Nhận lúc</label>
            <input type="datetime-local" value={line.start} onChange={(e) => onChange({ start: e.target.value })} className={input} />
          </div>
        )}
        <div>
          <label className={label}>{item?.tracking_mode === "space" ? "Trả lúc (bỏ trống = tính giờ)" : "Hẹn trả"}</label>
          <input type="datetime-local" value={line.end} onChange={(e) => onChange({ end: e.target.value })} className={input}
            required={item?.tracking_mode !== "space"} />
        </div>
        {item?.tracking_mode === "bulk" ? (
          <div>
            <label className={label}>Số lượng {avail?.free_quantity != null && <span className="text-slate-500">(còn {avail.free_quantity}/{avail.total})</span>}</label>
            <input type="number" min={1} max={avail?.free_quantity ?? undefined} value={line.quantity}
              onChange={(e) => onChange({ quantity: Math.max(1, Number(e.target.value) || 1) })} className={input} />
          </div>
        ) : item ? (
          <div>
            <label className={label}>Chiếc {avail?.free_units && <span className="text-slate-500">({avail.free_units.length} trống)</span>}</label>
            <select value={line.unit_id ?? ""} onChange={(e) => onChange({ unit_id: Number(e.target.value) || null })} className={input}>
              <option value="">Tự chọn chiếc trống</option>
              {avail?.free_units?.filter((u) => !checkout || u.status === "available").map((u) => (
                <option key={u.id} value={u.id}>{u.code}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {item && (
        <p className="text-xs text-slate-400">
          {quote
            ? <>Dự tính <span className="font-semibold text-slate-200">{vnd(quote.amount)}</span> ({quote.units} {RATE_UNIT_LABELS[quote.rate_unit]}) · tính theo giờ thực khi trả</>
            : quoteError ? <span className="text-rose-500">{errorText(quoteError, "Chưa tính được giá")}</span>
            : item.tracking_mode === "space" && !line.end ? "Tính tiền theo giờ thực khi trả phòng." : "…"}
          {avail?.free_units && avail.free_units.length === 0 && <span className="ml-2 font-semibold text-rose-500">Hết chiếc trống trong thời gian này</span>}
        </p>
      )}
    </div>
  );
}
