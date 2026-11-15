"use client";

import React, { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Minus, Plus, Search, Undo2 } from "lucide-react";
import {
  exchangeGoods, getCatalog, getOrderForReturn, listRecentReturns, previewExchange, returnGoods, fmtTime, vnd,
  CONDITION_LABELS, type Goods, type ReturnCondition, type ReturnableOrder,
} from "@/utils/retail";
import { newLocalId } from "@/utils/offlineStore";
import { errorText, toast } from "@/components/Toaster";
import { useShiftOpen } from "@/components/ShiftButton";
import { ErrorLine, Field, GoodsPicker, NumberInput, PageHead, inputCls } from "@/components/RetailUi";
import { PaymentBox, PendingApprovalsPanel, paymentReady, resolvePayments, type PayRow } from "@/components/RetailCheckout";

type Pick = { quantity: number | ""; condition: ReturnCondition };
type Mode = "return" | "exchange";

export default function RetailReturnsPage() {
  const qc = useQueryClient();
  const shiftOpen = useShiftOpen();
  const [orderNo, setOrderNo] = useState("");
  const [order, setOrder] = useState<ReturnableOrder | null>(null);
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<Mode>("return");
  const [newItems, setNewItems] = useState<{ goods: Goods; quantity: number }[]>([]);
  const [payRows, setPayRows] = useState<PayRow[]>([{ method: "cash", amount: "" }]);
  const [given, setGiven] = useState<number | "">("");
  const exRef = useRef(newLocalId("EXC"));
  const { data: recent = [] } = useQuery({ queryKey: ["retailReturns"], queryFn: listRecentReturns });
  const { data: catalog = [] } = useQuery({ queryKey: ["retailCatalog"], queryFn: () => getCatalog(), enabled: mode === "exchange" });

  const load = useMutation({
    mutationFn: () => getOrderForReturn(Number(orderNo.replace(/\D/g, ""))),
    onSuccess: (o) => {
      setOrder(o);
      setPicks(Object.fromEntries(o.items.map((it) => [it.order_item_id, { quantity: "", condition: "resell" as const }])));
      setErr("");
    },
    onError: (e) => { setOrder(null); setErr(errorText(e, "Không tìm thấy hóa đơn.")); },
  });

  const chosen = order?.items.filter((it) => Number(picks[it.order_item_id]?.quantity || 0) > 0) ?? [];
  const returnLines = chosen.map((it) => ({
    order_item_id: it.order_item_id, quantity: Number(picks[it.order_item_id].quantity), condition: picks[it.order_item_id].condition,
  }));
  // Xem trước giống DB: phân bổ giảm giá của đơn theo tỉ lệ, chặn trần phần còn lại
  const ratio = order && order.total_amount > 0 ? order.final_amount / order.total_amount : 0;
  const preview = order
    ? Math.min(
        chosen.reduce((s, it) => s + Math.floor(Number(picks[it.order_item_id].quantity) * it.unit_price * ratio), 0),
        order.final_amount - order.refunded,
      )
    : 0;
  const over = chosen.some((it) => Number(picks[it.order_item_id].quantity) > it.returnable);

  // ---- Đổi hàng: số liệu do DB tính (cùng công thức với lúc ghi) ----
  const exItems = newItems.map((n) => ({ product_id: n.goods.id, quantity: n.quantity }));
  const { data: ex, error: exErr } = useQuery({
    queryKey: ["exchangePreview", order?.order_id, returnLines, exItems],
    queryFn: () => previewExchange({ order_id: order!.order_id, return_lines: returnLines, items: exItems }),
    enabled: mode === "exchange" && !!order && returnLines.length > 0 && exItems.length > 0 && !over,
  });
  const extra = ex ? Math.max(ex.difference, 0) : 0;

  const addNew = (g: Goods) =>
    setNewItems((xs) => {
      const i = xs.findIndex((x) => x.goods.id === g.id);
      return i >= 0 ? xs.map((x, j) => (j === i ? { ...x, quantity: x.quantity + 1 } : x)) : [...xs, { goods: g, quantity: 1 }];
    });
  const setNewQty = (id: number, n: number) =>
    setNewItems((xs) => (n <= 0 ? xs.filter((x) => x.goods.id !== id) : xs.map((x) => (x.goods.id === id ? { ...x, quantity: n } : x))));

  const afterDone = () => {
    setReason(""); setNewItems([]); setGiven(""); setPayRows([{ method: "cash", amount: "" }]);
    exRef.current = newLocalId("EXC");
    qc.invalidateQueries({ queryKey: ["retailReturns"] });
    qc.invalidateQueries({ queryKey: ["retailCatalog"] });
    qc.invalidateQueries({ queryKey: ["retailApprovals"] });
    qc.invalidateQueries({ queryKey: ["currentShift"] });
    load.mutate();
  };

  const submit = useMutation({
    mutationFn: () => returnGoods({ order_id: order!.order_id, reason: reason.trim(), lines: returnLines }),
    onSuccess: (res) => {
      if (res.status === "pending_approval") toast.success(`Trả ${vnd(res.amount)} cần ${res.required_level === "owner" ? "chủ" : "quản lý"} duyệt — đã gửi yêu cầu`);
      else toast.success(`${res.code}: đã nhận trả, hoàn ${vnd(res.amount)}`);
      afterDone();
    },
    onError: (e) => setErr(errorText(e, "Không nhận trả được.")),
  });

  const exchange = useMutation({
    mutationFn: () => exchangeGoods({
      order_id: order!.order_id,
      reason: reason.trim(),
      return_lines: returnLines,
      items: exItems,
      payments: resolvePayments(payRows, extra),
      offline_ref: exRef.current,
    }),
    onSuccess: (res) => {
      if (res.status === "pending_approval") {
        toast.success(`Đổi hàng hoàn khách ${vnd(res.amount)} cần ${res.required_level === "owner" ? "chủ" : "quản lý"} duyệt — đã gửi yêu cầu`);
      } else {
        toast.success(res.difference >= 0
          ? `${res.code}: đổi xong, hóa đơn mới #${res.new_order_id}, thu thêm ${vnd(res.difference)}`
          : `${res.code}: đổi xong, hóa đơn mới #${res.new_order_id}, hoàn khách ${vnd(-res.difference)}`);
      }
      afterDone();
    },
    onError: (e: any) => {
      setErr(errorText(e, "Không đổi hàng được."));
      if (e?.code) exRef.current = newLocalId("EXC");
    },
  });

  const baseOk = shiftOpen && order && chosen.length > 0 && !over && reason.trim() && !order.pending_request;
  const canReturn = baseOk && !submit.isPending;
  const canExchange = baseOk && newItems.length > 0 && !!ex && !exchange.isPending && paymentReady(payRows, extra, given);

  return (
    <div className="space-y-6">
      <PageHead title="Trả hàng / Đổi hàng" sub="Tìm theo số hóa đơn in trên bill. Tiền hoàn ra từ két của ca đang mở, theo đúng cách khách đã trả." />

      <form onSubmit={(e) => { e.preventDefault(); if (orderNo.trim()) load.mutate(); }} className="flex max-w-md gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input value={orderNo} onChange={(e) => setOrderNo(e.target.value)} inputMode="numeric" placeholder="Số hóa đơn, VD 1024" aria-label="Số hóa đơn" className={`${inputCls} pl-9`} />
        </div>
        <button type="submit" disabled={load.isPending} className="rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500">Tìm</button>
      </form>

      {!shiftOpen && <p className="text-sm text-amber-600">Chưa mở ca — mở ca ở màn Bán hàng trước khi hoàn tiền.</p>}
      {!order && <ErrorLine text={err} />}

      {order && (
        <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <div>
              <p className="font-semibold text-slate-100">Hóa đơn #{order.order_id} · {order.customer_name}</p>
              <p className="text-slate-500">{fmtTime(order.date)} · khách trả {vnd(order.final_amount)}{order.discount_amount > 0 ? ` (giảm ${vnd(order.discount_amount)})` : ""}</p>
            </div>
            {order.refunded > 0 && <p className="text-amber-600">Đã hoàn {vnd(order.refunded)}</p>}
          </div>
          {order.pending_request && <p className="text-sm text-amber-600">Hóa đơn đang có yêu cầu hoàn tiền / trả hàng chờ duyệt.</p>}

          <div className="flex w-fit overflow-hidden rounded-xl border border-slate-800 text-sm" role="tablist" aria-label="Chế độ">
            {([["return", "Trả hàng", Undo2], ["exchange", "Đổi hàng", ArrowLeftRight]] as const).map(([m, label, Icon]) => (
              <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setErr(""); }}
                className={`flex items-center gap-1.5 px-4 py-2 ${mode === m ? "bg-indigo-500/15 font-semibold text-indigo-500" : "text-slate-400"}`}>
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="py-2">Món</th><th className="py-2 text-right">Đã mua</th><th className="py-2 text-right">Còn trả được</th><th className="w-24 px-2 py-2 text-right">Trả</th><th className="px-2 py-2">Tình trạng</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {order.items.map((it) => {
                  const p = picks[it.order_item_id];
                  return (
                    <tr key={it.order_item_id} className={it.returnable > 0 ? "text-slate-200" : "text-slate-500"}>
                      <td className="py-2">{it.name}<span className="block text-xs text-slate-500">{it.is_comp ? "Tặng" : vnd(it.unit_price)}</span></td>
                      <td className="py-2 text-right tabular-nums">{it.quantity}</td>
                      <td className="py-2 text-right tabular-nums">{it.returnable}</td>
                      <td className="px-2 py-2">
                        <NumberInput value={p?.quantity ?? ""} disabled={it.returnable <= 0} aria-label={`Số trả ${it.name}`}
                          onChange={(v) => setPicks((s) => ({ ...s, [it.order_item_id]: { ...s[it.order_item_id], quantity: v } }))}
                          className={p && Number(p.quantity) > it.returnable ? "border-rose-500" : ""} />
                      </td>
                      <td className="px-2 py-2">
                        <select value={p?.condition ?? "resell"} disabled={it.returnable <= 0} aria-label={`Tình trạng ${it.name}`}
                          onChange={(e) => setPicks((s) => ({ ...s, [it.order_item_id]: { ...s[it.order_item_id], condition: e.target.value as ReturnCondition } }))}
                          className={inputCls}>
                          {(Object.keys(CONDITION_LABELS) as ReturnCondition[]).map((c) => <option key={c} value={c}>{CONDITION_LABELS[c]}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {mode === "exchange" && (
            <div className="space-y-3 rounded-xl border border-slate-800 p-4">
              <p className="text-sm font-semibold text-slate-200">Hàng đổi sang (giá bán hiện hành)</p>
              <GoodsPicker catalog={catalog} onPick={addNew} placeholder="Quét mã hoặc gõ tên món khách lấy" />
              {newItems.length > 0 && (
                <ul className="divide-y divide-slate-800">
                  {newItems.map((n) => (
                    <li key={n.goods.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="text-slate-200">{n.goods.name}<span className="ml-2 text-xs text-slate-500">{vnd(n.goods.price)}</span></span>
                      <span className="flex items-center gap-1">
                        <button onClick={() => setNewQty(n.goods.id, n.quantity - 1)} aria-label="Bớt" className="rounded-lg border border-slate-800 p-1 text-slate-300 hover:bg-slate-800"><Minus className="h-3.5 w-3.5" /></button>
                        <span className={`w-8 text-center tabular-nums ${n.quantity > n.goods.stock ? "text-rose-500" : "text-slate-100"}`}>{n.quantity}</span>
                        <button onClick={() => setNewQty(n.goods.id, n.quantity + 1)} aria-label="Thêm" className="rounded-lg border border-slate-800 p-1 text-slate-300 hover:bg-slate-800"><Plus className="h-3.5 w-3.5" /></button>
                        <span className="ml-2 w-24 text-right tabular-nums text-slate-100">{vnd(n.goods.price * n.quantity)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {exErr && <ErrorLine text={errorText(exErr, "Không tính được chênh lệch.")} />}
              {ex && (
                <dl className="space-y-1 border-t border-slate-800 pt-3 text-sm">
                  <div className="flex justify-between text-slate-400"><dt>Giá trị hàng trả</dt><dd className="tabular-nums">−{vnd(ex.return_amount)}</dd></div>
                  <div className="flex justify-between text-slate-400"><dt>Hàng mới</dt><dd className="tabular-nums">{vnd(ex.sale_amount)}</dd></div>
                  <div className="flex justify-between text-lg font-bold text-slate-100">
                    <dt>{ex.difference >= 0 ? "Khách trả thêm" : "Hoàn khách"}</dt><dd className="tabular-nums">{vnd(Math.abs(ex.difference))}</dd>
                  </div>
                  {ex.difference < 0 && ex.decision !== "auto" && ex.decision !== "auto_alert" && (
                    <p className="text-xs text-amber-600">Số hoàn này cần {ex.decision === "pending_owner" ? "chủ" : "quản lý"} duyệt nếu bạn không đủ quyền.</p>
                  )}
                </dl>
              )}
              {ex && extra > 0 && <PaymentBox total={extra} rows={payRows} setRows={setPayRows} given={given} setGiven={setGiven} />}
            </div>
          )}

          <Field label={mode === "exchange" ? "Lý do đổi *" : "Lý do trả *"}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === "exchange" ? "VD: đổi size, đổi màu" : "VD: hàng lỗi, khách đổi ý"} className={inputCls} />
          </Field>
          {mode === "return" ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-300">Hoàn cho khách <span className="text-lg font-bold tabular-nums text-slate-100">{vnd(preview)}</span>
                {ratio > 0 && ratio < 1 && <span className="ml-2 text-xs text-slate-500">đã trừ phần giảm giá của đơn</span>}
              </p>
              <button onClick={() => { setErr(""); submit.mutate(); }} disabled={!canReturn}
                className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500">
                {submit.isPending ? "Đang xử lý…" : "Nhận trả & hoàn tiền"}
              </button>
            </div>
          ) : (
            <div className="flex justify-end">
              <button onClick={() => { setErr(""); exchange.mutate(); }} disabled={!canExchange}
                className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500">
                {exchange.isPending ? "Đang xử lý…" : "Đổi hàng"}
              </button>
            </div>
          )}
          <ErrorLine text={err} />
        </section>
      )}

      <PendingApprovalsPanel />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-300">Phiếu trả gần đây</h2>
        {recent.length === 0 ? <p className="text-sm text-slate-500">Chưa có phiếu trả hàng.</p> : (
          <ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="text-slate-200"><span className="font-mono text-indigo-500">{r.code}</span> · hóa đơn #{r.order_id} · {r.reason}</span>
                <span className="text-slate-400"><span className="tabular-nums text-slate-100">{vnd(r.amount)}</span> · {fmtTime(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
