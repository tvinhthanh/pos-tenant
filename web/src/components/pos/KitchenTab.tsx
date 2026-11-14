"use client";

import React from "react";
import { Check, ChefHat } from "lucide-react";

import { optionSummary } from "@/utils/productOptions";
import { pendingKitchenItemCount } from "@/components/pos/helpers";

interface Props {
  orders: any[];
  tables: any[];
  onServe: (itemId: number) => void;
  serving: boolean;
}

/** Tab "Bếp": hàng đợi món cần làm, bấm ✓ khi món xong. */
export default function KitchenTab({ orders, tables, onServe, serving }: Props) {
  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-slate-900/20 border border-slate-850 rounded-2xl p-4 md:p-6">
      <h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center">
        <ChefHat className="w-4.5 h-4.5 text-amber-500 mr-1.5" />
        Hàng đợi bếp
      </h3>
      <div className="flex-1 overflow-y-auto pr-1 space-y-3">
        {orders.length > 0 ? (
          orders.map((order: any) => (
            <div key={order.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-slate-100">Đơn #{order.id}</div>
                  <div className="text-xs font-semibold text-slate-500">
                    {tables.find((table: any) => table.id === order.table_id)?.name || "Mang về"} ·{" "}
                    {new Date(order.date).toLocaleTimeString("vi-VN")}
                  </div>
                </div>
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                  {pendingKitchenItemCount(order)} món chờ
                </span>
              </div>
              <div className="space-y-2">
                {order.items.map((item: any) => {
                  const done = item.status === "served";
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs ${
                        done ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-slate-900"
                      }`}
                    >
                      <div className="min-w-0">
                        <span
                          className={`block truncate font-semibold ${
                            done ? "text-emerald-700 dark:text-emerald-300 line-through" : "text-slate-200"
                          }`}
                        >
                          {item.product_name}
                        </span>
                        {item.options?.length > 0 && (
                          <span className="block text-[11px] font-semibold text-amber-700 dark:text-amber-200/80">
                            {optionSummary(item.options)}
                          </span>
                        )}
                        <span className="text-[10px] font-semibold text-slate-500">x{item.quantity}</span>
                      </div>
                      <button
                        onClick={() => onServe(item.id)}
                        disabled={done || serving}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 transition-colors hover:bg-emerald-500 hover:text-white disabled:opacity-50"
                        title="Món đã xong"
                        aria-label={`Đánh dấu ${item.product_name} đã xong`}
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-slate-600">
            <ChefHat className="w-10 h-10 mb-2 stroke-[1.5]" />
            <span className="text-xs">Chưa có đơn nào trong hàng đợi bếp</span>
          </div>
        )}
      </div>
    </div>
  );
}
