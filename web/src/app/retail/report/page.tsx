"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRetailReport, vnd, qty } from "@/utils/retail";
import { errorText } from "@/components/Toaster";
import { PageHead } from "@/components/RetailUi";

const RANGES = [
  { key: 1, label: "Hôm nay" },
  { key: 7, label: "7 ngày" },
  { key: 30, label: "30 ngày" },
];

export default function RetailReportPage() {
  const [days, setDays] = useState(7);
  const { data, isLoading, error } = useQuery({
    queryKey: ["retailReport", days],
    queryFn: () => {
      const to = new Date();
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - (days - 1));
      return getRetailReport(from.toISOString(), to.toISOString());
    },
  });
  const margin = data && data.net_revenue > 0 ? Math.round((data.gross_profit / data.net_revenue) * 100) : null;

  return (
    <div className="space-y-6">
      <PageHead title="Báo cáo bán lẻ" sub="Doanh thu thuần đã trừ tiền hoàn; giá vốn đã trừ phần hàng khách trả về kho.">
        <div className="inline-flex rounded-xl border border-slate-800 p-1">
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setDays(r.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${days === r.key ? "bg-indigo-600 text-white" : "text-slate-400"}`}>
              {r.label}
            </button>
          ))}
        </div>
      </PageHead>

      {error && <p className="text-sm text-rose-500">{errorText(error, "Không tải được báo cáo.")}</p>}
      {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Doanh thu thuần" value={vnd(data.net_revenue)} note={`${data.orders} hóa đơn · TB ${vnd(data.avg_basket)}/đơn`} />
            <Stat label="Lãi gộp" value={vnd(data.gross_profit)} note={margin == null ? "—" : `Biên lãi ${margin}%`} danger={data.gross_profit < 0} />
            <Stat label="Tiền hoàn / trả hàng" value={vnd(data.refunds)} note={`${data.returns} phiếu trả hàng`} />
            <Stat label="Giá trị tồn kho" value={vnd(data.stock_value)} note="Theo giá vốn bình quân" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Bán chạy theo doanh thu</h2>
              {data.top_products.length === 0 ? <p className="text-sm text-slate-500">Chưa có hóa đơn trong kỳ.</p> : (
                <ol className="divide-y divide-slate-800 text-sm">
                  {data.top_products.map((p, i) => (
                    <li key={p.product_id ?? i} className="flex justify-between gap-3 py-2">
                      <span className="text-slate-300"><span className="mr-2 tabular-nums text-slate-500">{i + 1}.</span>{p.name}</span>
                      <span className="shrink-0 tabular-nums text-slate-100">{vnd(p.revenue)} <span className="text-xs text-slate-500">· {qty(p.quantity)}</span></span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Sắp hết hàng</h2>
              {data.low_stock.length === 0 ? <p className="text-sm text-slate-500">Không có sản phẩm dưới mức cảnh báo.</p> : (
                <ul className="divide-y divide-slate-800 text-sm">
                  {data.low_stock.map((p) => (
                    <li key={p.product_id} className="flex justify-between py-2">
                      <span className="text-slate-300">{p.name}</span>
                      <span className={`tabular-nums ${Number(p.stock) <= 0 ? "font-semibold text-rose-500" : "text-amber-600"}`}>
                        {qty(p.stock)} / {qty(p.min_stock)} {p.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, note, danger }: { label: string; value: string; note: string; danger?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${danger ? "text-rose-500" : "text-slate-100"}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </div>
  );
}
