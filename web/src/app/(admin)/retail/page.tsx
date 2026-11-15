"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Minus, Plus, ScanLine, Search, Trash2, UserRound, X } from "lucide-react";
import { supabase, activeContext } from "@/utils/api";
import ShiftButton, { useShiftOpen } from "@/components/ShiftButton";
import ReceiptModal, { type ReceiptData } from "@/components/ReceiptModal";
import { errorText, toast } from "@/components/Toaster";
import {
  checkout, findByCode, findCustomer, getCatalog, newCheckoutRef, vnd, qty as fmtQty,
  PAY_METHOD_LABELS, type CustomerHit, type Goods, type PayMethod,
} from "@/utils/retail";

type Line = { goods: Goods; quantity: number };
type Voucher = { code: string; discount_type: "amount" | "percentage"; value: number; min_order_value: number };

const METHODS: PayMethod[] = ["cash", "bank_transfer", "card", "momo"];

export default function RetailPosPage() {
  const qc = useQueryClient();
  const shiftOpen = useShiftOpen();
  const scanRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [method, setMethod] = useState<PayMethod>("cash");
  const [given, setGiven] = useState<number | "">("");
  const [phone, setPhone] = useState("");
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [voucherCode, setVoucherCode] = useState("");
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [notice, setNotice] = useState("");
  // Một mã cho mỗi lượt thanh toán: bấm lại khi mạng chập chờn không tạo đơn trùng
  const refRef = useRef(newCheckoutRef());

  const { data: catalog = [], isLoading, error } = useQuery({ queryKey: ["retailCatalog"], queryFn: () => getCatalog() });

  useEffect(() => { scanRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return catalog.slice(0, 24);
    return catalog
      .filter((g) => g.name.toLowerCase().includes(t) || g.barcode?.includes(t) || g.sku?.toLowerCase().includes(t))
      .slice(0, 24);
  }, [catalog, term]);

  const add = (g: Goods, n = 1) => {
    setNotice("");
    setLines((ls) => {
      const i = ls.findIndex((l) => l.goods.id === g.id);
      const next = i >= 0 ? ls[i].quantity + n : n;
      if (next > g.stock) setNotice(`"${g.name}" chỉ còn ${fmtQty(g.stock)} ${g.unit} trong kho.`);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, quantity: next } : l));
      return [...ls, { goods: g, quantity: n }];
    });
  };
  const setQty = (id: number, n: number) =>
    setLines((ls) => (n <= 0 ? ls.filter((l) => l.goods.id !== id) : ls.map((l) => (l.goods.id === id ? { ...l, quantity: n } : l))));

  // Máy quét gõ mã rồi Enter. Khớp mã vạch / SKU → thêm ngay; không khớp thì giữ lại để tìm theo tên.
  const onScan = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const hit = findByCode(catalog, term);
    if (hit) {
      add(hit);
      setTerm("");
    } else if (results.length === 1) {
      add(results[0]);
      setTerm("");
    } else if (term.trim()) {
      setNotice(`Không có mã "${term.trim()}". Chọn sản phẩm trong danh sách bên dưới.`);
    }
  };

  const subtotal = lines.reduce((s, l) => s + l.goods.price * l.quantity, 0);
  // Xem trước giảm giá giống công thức trong create_sales_order; DB tính lại và đối chiếu
  const discount = !voucher || subtotal < voucher.min_order_value ? 0
    : voucher.discount_type === "amount" ? Math.min(voucher.value, subtotal)
      : Math.floor((subtotal * voucher.value) / 100);
  const total = subtotal - Math.min(discount, subtotal);
  const change = method === "cash" && given !== "" ? Number(given) - total : 0;
  const overStock = lines.some((l) => l.quantity > l.goods.stock);

  const lookupCustomer = async () => {
    setCustomer(null);
    if (!phone.trim()) return;
    try {
      const c = await findCustomer(phone);
      if (!c) toast.error("Chưa có khách với SĐT này.");
      setCustomer(c);
    } catch (e) {
      toast.error(errorText(e, "Không tra được khách."));
    }
  };

  const applyVoucher = async () => {
    setVoucher(null);
    const code = voucherCode.trim();
    if (!code) return;
    const { branchId } = await activeContext();
    const { data } = await supabase
      .from("vouchers")
      .select("code, discount_type, value, min_order_value")
      .eq("branch_id", branchId)
      .eq("is_active", true)
      .ilike("code", code)
      .maybeSingle();
    if (!data) toast.error(`Mã ${code} không hợp lệ hoặc đã hết hạn.`);
    else setVoucher(data as Voucher);
  };

  const pay = useMutation({
    mutationFn: () =>
      checkout({
        lines: lines.map((l) => ({ product_id: l.goods.id, quantity: l.quantity })),
        payments: total > 0 ? [{ method, amount: total }] : [],
        customer_id: customer?.id,
        voucher_code: voucher?.code,
        offline_ref: refRef.current,
      }),
    onSuccess: (res) => {
      setReceipt({
        id: res.order_id,
        date: new Date().toISOString(),
        customer_name: customer?.name || "Khách lẻ",
        // Bấm lại sau lỗi mạng: DB trả đơn đã ghi trước đó (idempotent), không kèm số tiền
        total_amount: res.total_amount ?? subtotal,
        discount_amount: res.discount_amount ?? subtotal - total,
        final_amount: res.final_amount ?? total,
        payment_method: PAY_METHOD_LABELS[method],
        items: lines.map((l) => ({ product_name: l.goods.name, quantity: l.quantity, price: l.goods.price })),
      });
      setLines([]); setGiven(""); setVoucher(null); setVoucherCode(""); setCustomer(null); setPhone(""); setNotice("");
      refRef.current = newCheckoutRef();
      qc.invalidateQueries({ queryKey: ["retailCatalog"] });
      qc.invalidateQueries({ queryKey: ["currentShift"] });
    },
    onError: (e: any) => {
      toast.error(errorText(e, "Thanh toán không thành công."));
      // Có mã lỗi Postgres = DB đã từ chối, chưa tạo đơn → lượt sau dùng mã mới.
      // Không có mã = lỗi mạng, đơn có thể đã ghi → giữ mã, bấm lại sẽ nhận đúng đơn cũ.
      if (e?.code) refRef.current = newCheckoutRef();
      qc.invalidateQueries({ queryKey: ["retailCatalog"] });
    },
  });

  const canPay = shiftOpen && lines.length > 0 && !pay.isPending && (method !== "cash" || given === "" || change >= 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); scanRef.current?.focus(); }
      if (e.key === "F9" && canPay) { e.preventDefault(); pay.mutate(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canPay, pay]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
      {/* ---------------- Quét & chọn hàng ---------------- */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-slate-100">Bán hàng</h1>
          <ShiftButton />
        </div>

        {!shiftOpen && (
          <p className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600">
            <AlertTriangle className="h-4 w-4 shrink-0" /> Chưa mở ca. Mở ca để bắt đầu thu tiền.
          </p>
        )}

        <div className="relative">
          <ScanLine className="absolute left-3.5 top-3.5 h-5 w-5 text-indigo-500" />
          <input
            ref={scanRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onScan}
            placeholder="Quét mã vạch hoặc gõ tên / SKU rồi Enter  (F2)"
            aria-label="Quét mã vạch hoặc tìm sản phẩm"
            className="w-full rounded-2xl border border-slate-800 bg-slate-900 py-3 pl-11 pr-4 text-base text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        {notice && <p role="status" className="text-sm text-amber-600">{notice}</p>}
        {error && <p className="text-sm text-rose-500">{errorText(error, "Không tải được danh mục.")}</p>}
        {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {results.map((g) => (
            <button
              key={g.id}
              onClick={() => { add(g); scanRef.current?.focus(); }}
              disabled={g.stock <= 0}
              className="rounded-2xl border border-slate-800 bg-slate-900 p-3 text-left transition hover:border-indigo-500/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <p className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-slate-100">{g.name}</p>
              <p className="mt-1 text-sm font-bold tabular-nums text-indigo-500">{vnd(g.price)}</p>
              <p className={`mt-1 text-[11px] ${g.stock <= 0 ? "text-rose-500" : g.low_stock ? "text-amber-600" : "text-slate-500"}`}>
                {g.stock <= 0 ? "Hết hàng" : `Còn ${fmtQty(g.stock)} ${g.unit}`}
                {g.barcode ? <span className="ml-1 font-mono text-slate-600">· {g.barcode}</span> : null}
              </p>
            </button>
          ))}
          {!isLoading && results.length === 0 && (
            <p className="col-span-full flex items-center gap-2 text-sm text-slate-500"><Search className="h-4 w-4" /> Không tìm thấy sản phẩm.</p>
          )}
        </div>
      </section>

      {/* ---------------- Giỏ & thanh toán ---------------- */}
      <aside className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Đơn hàng · {lines.length} món</h2>

        {lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">Quét mã để thêm hàng.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {lines.map((l) => (
              <li key={l.goods.id} className="py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-slate-200">{l.goods.name}</p>
                  <button onClick={() => setQty(l.goods.id, 0)} aria-label={`Bỏ ${l.goods.name}`} className="text-slate-500 hover:text-rose-500">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setQty(l.goods.id, l.quantity - 1)} aria-label="Bớt" className="rounded-lg border border-slate-800 p-1 text-slate-300 hover:bg-slate-800"><Minus className="h-3.5 w-3.5" /></button>
                    <input
                      value={l.quantity}
                      onChange={(e) => setQty(l.goods.id, Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                      inputMode="numeric"
                      aria-label={`Số lượng ${l.goods.name}`}
                      className={`w-12 rounded-lg border bg-slate-950 py-1 text-center text-sm tabular-nums text-slate-100 ${l.quantity > l.goods.stock ? "border-rose-500" : "border-slate-800"}`}
                    />
                    <button onClick={() => add(l.goods)} aria-label="Thêm" className="rounded-lg border border-slate-800 p-1 text-slate-300 hover:bg-slate-800"><Plus className="h-3.5 w-3.5" /></button>
                    <span className="ml-1 text-xs text-slate-500">× {vnd(l.goods.price)}</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-slate-100">{vnd(l.goods.price * l.quantity)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Khách & voucher */}
        <div className="space-y-2 border-t border-slate-800 pt-3">
          {customer ? (
            <div className="flex items-center justify-between rounded-xl bg-indigo-500/10 px-3 py-2 text-sm">
              <span className="flex items-center gap-2 text-slate-200"><UserRound className="h-4 w-4 text-indigo-500" />{customer.name} · {customer.points} điểm</span>
              <button onClick={() => { setCustomer(null); setPhone(""); }} aria-label="Bỏ khách" className="text-slate-500 hover:text-slate-200"><X className="h-4 w-4" /></button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && lookupCustomer()}
                placeholder="SĐT khách tích điểm" inputMode="tel" aria-label="Số điện thoại khách"
                className="min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
              <button onClick={lookupCustomer} className="rounded-xl border border-slate-800 px-3 text-xs text-slate-300 hover:bg-slate-800">Tìm</button>
            </div>
          )}
          <div className="flex gap-2">
            <input value={voucherCode} onChange={(e) => { setVoucherCode(e.target.value); setVoucher(null); }}
              onKeyDown={(e) => e.key === "Enter" && applyVoucher()}
              placeholder="Mã giảm giá" aria-label="Mã giảm giá"
              className="min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm uppercase text-slate-100 placeholder-slate-500 placeholder:normal-case focus:border-indigo-500 focus:outline-none" />
            <button onClick={applyVoucher} className="rounded-xl border border-slate-800 px-3 text-xs text-slate-300 hover:bg-slate-800">Áp dụng</button>
          </div>
          {voucher && subtotal < voucher.min_order_value && (
            <p className="text-xs text-amber-600">Mã {voucher.code} cần đơn từ {vnd(voucher.min_order_value)}.</p>
          )}
        </div>

        {/* Tổng */}
        <dl className="space-y-1 border-t border-slate-800 pt-3 text-sm">
          <div className="flex justify-between text-slate-400"><dt>Tiền hàng</dt><dd className="tabular-nums">{vnd(subtotal)}</dd></div>
          {discount > 0 && <div className="flex justify-between text-emerald-500"><dt>Giảm giá</dt><dd className="tabular-nums">−{vnd(discount)}</dd></div>}
          <div className="flex justify-between text-lg font-bold text-slate-100"><dt>Khách trả</dt><dd className="tabular-nums">{vnd(total)}</dd></div>
        </dl>

        {/* Thanh toán */}
        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Phương thức thanh toán">
          {METHODS.map((m) => (
            <button key={m} role="radio" aria-checked={method === m} onClick={() => setMethod(m)}
              className={`rounded-xl border px-1 py-2 text-xs font-medium ${method === m ? "border-indigo-500 bg-indigo-500/10 text-indigo-500" : "border-slate-800 text-slate-400"}`}>
              {PAY_METHOD_LABELS[m]}
            </button>
          ))}
        </div>
        {method === "cash" && total > 0 && (
          <div className="space-y-2">
            <input value={given} onChange={(e) => setGiven(e.target.value === "" ? "" : Math.max(0, Number(e.target.value.replace(/\D/g, ""))))}
              inputMode="numeric" placeholder="Khách đưa" aria-label="Tiền khách đưa"
              className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-right text-base tabular-nums text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
            <div className="flex flex-wrap gap-1.5">
              {[total, ...[50000, 100000, 200000, 500000].filter((v) => v > total)].slice(0, 4).map((v) => (
                <button key={v} onClick={() => setGiven(v)} className="rounded-lg border border-slate-800 px-2 py-1 text-xs tabular-nums text-slate-300 hover:bg-slate-800">{vnd(v)}</button>
              ))}
            </div>
            {given !== "" && (
              <p className={`flex justify-between text-sm font-semibold ${change < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                <span>{change < 0 ? "Còn thiếu" : "Tiền thối"}</span><span className="tabular-nums">{vnd(Math.abs(change))}</span>
              </p>
            )}
          </div>
        )}

        {overStock && <p className="text-xs text-amber-600">Có món vượt tồn kho — hệ thống sẽ từ chối nếu kho thực sự không đủ.</p>}

        <button
          onClick={() => pay.mutate()}
          disabled={!canPay}
          className="rounded-2xl bg-indigo-600 py-3.5 text-base font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
        >
          {pay.isPending ? "Đang thanh toán…" : `Thanh toán ${vnd(total)}  (F9)`}
        </button>
      </aside>

      <ReceiptModal isOpen={Boolean(receipt)} onClose={() => { setReceipt(null); scanRef.current?.focus(); }} order={receipt} />
    </div>
  );
}
