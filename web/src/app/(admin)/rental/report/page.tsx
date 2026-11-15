"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getRentalReport, fmtTime, vnd, CHARGE_LABELS, type ChargeType } from "@/utils/rental";
import { errorText } from "@/components/Toaster";

const RANGES = [
  { key: 7, label: "7 ngày" },
  { key: 30, label: "30 ngày" },
  { key: 90, label: "90 ngày" },
];

export default function RentalReportPage() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useQuery({
    queryKey: ["rentalReport", days],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
      return getRentalReport(from.toISOString(), to.toISOString());
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Báo cáo cho thuê</h1>
          <p className="text-sm text-slate-400">Doanh thu tính khi tất toán; tiền cọc đang giữ là nợ phải trả khách, không phải doanh thu.</p>
        </div>
        <div className="inline-flex rounded-xl border border-slate-800 p-1">
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setDays(r.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${days === r.key ? "bg-indigo-600 text-white" : "text-slate-400"}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-rose-500">{errorText(error, "Không tải được báo cáo.")}</p>}
      {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Doanh thu" value={vnd(data.revenue)} note={`${data.contracts_closed} hợp đồng tất toán`} />
            <Stat label="Cọc đang giữ" value={vnd(data.deposit_liability)} note="Phải hoàn khách khi tất toán" />
            <Stat label="Đang quá hạn" value={String(data.overdue.length)} note="món chưa trả đúng hẹn" danger={data.overdue.length > 0} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Doanh thu theo loại phí</h2>
              {Object.keys(data.revenue_by_type).length === 0 ? (
                <p className="text-sm text-slate-500">Chưa có hợp đồng tất toán trong kỳ.</p>
              ) : (
                <ul className="divide-y divide-slate-800 text-sm">
                  {(Object.entries(data.revenue_by_type) as [ChargeType, number][]).map(([type, total]) => (
                    <li key={type} className="flex justify-between py-2">
                      <span className="text-slate-300">{CHARGE_LABELS[type]}</span>
                      <span className={`tabular-nums ${total < 0 ? "text-emerald-500" : "text-slate-100"}`}>{vnd(total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Công suất cho thuê theo món</h2>
              {data.utilization.length === 0 ? <p className="text-sm text-slate-500">Chưa có món.</p> : (
                <ul className="space-y-2.5 text-sm">
                  {data.utilization.map((u) => (
                    <li key={u.item_id}>
                      <div className="flex justify-between text-slate-300"><span>{u.item}</span><span className="tabular-nums">{u.percent}%</span></div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                        <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${Math.min(100, u.percent)}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {data.overdue.length > 0 && (
            <section className="overflow-x-auto rounded-2xl border border-rose-500/30">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-rose-500/10 text-left text-xs uppercase tracking-wider text-rose-500">
                  <tr><th className="px-4 py-2.5">Hợp đồng</th><th className="px-4 py-2.5">Khách</th><th className="px-4 py-2.5">Món</th><th className="px-4 py-2.5">Hẹn trả</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {data.overdue.map((o, i) => (
                    <tr key={`${o.contract_id}-${i}`}>
                      <td className="px-4 py-2.5"><Link href={`/rental/contracts/${o.contract_id}`} className="font-mono text-indigo-500 hover:underline">{o.code}</Link></td>
                      <td className="px-4 py-2.5 text-slate-200">{o.customer}<span className="block text-xs text-slate-500">{o.phone}</span></td>
                      <td className="px-4 py-2.5 text-slate-300">{o.item}</td>
                      <td className="px-4 py-2.5 font-semibold text-rose-500">{fmtTime(o.due)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
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
