"use client";

import React from "react";
import { Clock, Printer, Undo2 } from "lucide-react";

import { paymentLabel } from "@/components/pos/helpers";

interface Props {
  orders: any[];
  /** Nhân viên chỉ xem đơn hôm nay, không in lại / hủy đơn */
  isStaff: boolean;
  onViewReceipt: (order: any) => void;
  onCancelOrder: (orderId: number) => void;
}

/** Tab "Đơn hàng gần đây" của trang POS. */
export default function OrderHistoryTab({ orders, isStaff, onViewReceipt, onCancelOrder }: Props) {
  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-slate-900/20 border border-slate-850 rounded-2xl p-4 md:p-6">
      <h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center">
        <Clock className="w-4.5 h-4.5 text-indigo-400 mr-1.5" />
        {isStaff ? "Lịch sử đơn hôm nay" : "Tất cả đơn hàng"}
      </h3>

      <div className="flex-1 overflow-auto pr-1">
        {orders.length > 0 ? (
          <table className="w-full min-w-[560px] text-left text-xs border-collapse">
            <thead>
              <tr className="text-slate-500 border-b border-slate-800 font-semibold uppercase tracking-wider">
                <th className="pb-3 w-16">Mã đơn</th>
                <th className="pb-3">Thời gian</th>
                <th className="pb-3">Khách hàng</th>
                <th className="pb-3 text-right">Tổng tiền</th>
                <th className="pb-3">Thanh toán</th>
                <th className="pb-3">Trạng thái</th>
                {!isStaff && <th className="pb-3 text-center">Hành động</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {orders.map((ord: any) => (
                <tr key={ord.id} className="hover:bg-slate-900/30 transition-colors group">
                  <td className="py-3 font-mono font-bold text-indigo-600 dark:text-indigo-400">#{ord.id}</td>
                  <td className="py-3 text-slate-400">
                    {new Date(ord.date).toLocaleTimeString("vi-VN")} - {new Date(ord.date).toLocaleDateString("vi-VN")}
                  </td>
                  <td className="py-3 text-slate-300 font-semibold">{ord.customer_name}</td>
                  <td className="py-3 text-right text-emerald-600 dark:text-emerald-400 font-bold font-mono">
                    {Number(ord.final_amount || 0).toLocaleString("vi-VN")}đ
                  </td>
                  <td className="py-3 text-slate-400">{paymentLabel(ord.payment_method || "")}</td>
                  <td className="py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        ord.status === "completed"
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                          : "bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20"
                      }`}
                    >
                      {ord.status === "completed" ? "Hoàn tất" : "Đã hủy"}
                    </span>
                  </td>
                  {!isStaff && (
                    <td className="py-3 text-center">
                      <div className="flex justify-center space-x-2">
                        <button
                          onClick={() => onViewReceipt(ord)}
                          title="Xem hóa đơn/In bill"
                          aria-label={`Xem hóa đơn #${ord.id}`}
                          className="p-1.5 bg-slate-800 hover:bg-slate-750 hover:text-slate-100 rounded-lg text-slate-400 transition-colors"
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                        {ord.status === "completed" && (
                          <button
                            onClick={() => onCancelOrder(ord.id)}
                            title="Hủy đơn hàng"
                            aria-label={`Hủy đơn #${ord.id}`}
                            className="p-1.5 bg-rose-500/10 hover:bg-rose-500 hover:text-white rounded-lg text-rose-600 dark:text-rose-400 transition-colors"
                          >
                            <Undo2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-slate-600">
            <Clock className="w-10 h-10 mb-2 stroke-[1.5]" />
            <span className="text-xs">Chưa có giao dịch nào được thực hiện</span>
          </div>
        )}
      </div>
    </div>
  );
}
