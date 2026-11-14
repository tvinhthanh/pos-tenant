"use client";

import React, { useState } from "react";
import { AlertTriangle, RotateCcw, Trash2, X } from "lucide-react";

import type { OfflineOrder } from "@/utils/offlineStore";

interface Props {
  orders: OfflineOrder[];
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
}

const money = (value: number) => `${Number(value || 0).toLocaleString("vi-VN")}đ`;

/**
 * Đơn bán lúc offline mà server từ chối khi đồng bộ (tùy chọn đã ngừng dùng,
 * voucher hết hạn, lệch tiền...). Không tự gửi lại — nhân viên xem lý do,
 * sửa nguyên nhân rồi "Thử lại", hoặc nhập lại đơn bằng tay rồi "Bỏ đơn".
 */
export default function OfflineRejectedOrders({ orders, onRetry, onDiscard }: Props) {
  const [open, setOpen] = useState(false);
  if (orders.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-500/20"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>{orders.length} đơn offline bị từ chối</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="rejected-title"
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-3xl border border-slate-800 bg-slate-950 shadow-2xl sm:max-w-lg sm:rounded-3xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
              <div>
                <h2 id="rejected-title" className="text-base font-bold text-slate-100">Đơn offline bị từ chối</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Khách đã trả tiền nhưng đơn chưa vào sổ. Sửa nguyên nhân rồi thử lại, hoặc nhập lại đơn rồi bỏ đơn này.
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-slate-500 hover:text-slate-100" aria-label="Đóng">
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="flex-1 divide-y divide-slate-800 overflow-y-auto">
              {orders.map((order) => (
                <li key={order.local_id} className="space-y-2 px-5 py-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs font-semibold text-slate-400">
                      {new Date(order.created_at).toLocaleString("vi-VN")}
                      {order.customer_name ? ` · ${order.customer_name}` : ""}
                    </span>
                    <span className="text-sm font-bold text-emerald-400">
                      {money(order.final_amount ?? order.total_amount)}
                    </span>
                  </div>
                  <ul className="text-xs text-slate-300">
                    {order.items.map((item, index) => (
                      <li key={index}>{item.quantity} × {item.product_name}</li>
                    ))}
                  </ul>
                  <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-500">
                    {order.error_message || "Server từ chối đơn này."}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onRetry(order.local_id)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 py-2 text-xs font-semibold text-slate-200 hover:border-slate-700"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Thử lại
                    </button>
                    <button
                      onClick={() => {
                        if (confirm("Bỏ đơn này khỏi hàng đợi? Đơn sẽ KHÔNG được ghi vào sổ.")) onDiscard(order.local_id);
                      }}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 py-2 text-xs font-semibold text-rose-400 hover:bg-rose-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Bỏ đơn
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
