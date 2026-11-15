"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getRentalReport, fmtDuration, fmtTime, vnd, type RevenueBreakdown } from "@/utils/rental";
import { errorText } from "@/components/Toaster";

const RANGES = [
  { key: 7, label: "7 ngày" },
  { key: 30, label: "30 ngày" },
  { key: 90, label: "90 ngày" },
  { key: 365, label: "1 năm" },
];

const BUCKET_LABEL = { day: "ngày", week: "tuần", month: "tháng" } as const;

const COLUMNS: { key: keyof RevenueBreakdown; label: string }[] = [
  { key: "rental", label: "Tiền thuê" },
  { key: "late", label: "Phí trễ" },
  { key: "damage", label: "Hư hỏng / mất" },
  { key: "other", label: "Phụ phí khác" },
  { key: "reductions", label: "Giảm / miễn" },
  { key: "forfeited", label: "Cọc bị giữ" },
  { key: "total", label: "Doanh thu" },
];

function periodLabel(iso: string, bucket: "day" | "week" | "month") {
  const [y, m, d] = iso.split("-");
  if (bucket === "month") return `${m}/${y}`;
  if (bucket === "week") return `Tuần từ ${d}/${m}`;
  return `${d}/${m}`;
}

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

  const maxPeriod = Math.max(1, ...(data?.by_period ?? []).map((p) => Math.abs(p.total)));

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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Doanh thu" value={vnd(data.revenue)} note={`${data.contracts_closed} hợp đồng tất toán`} />
            <Stat label="Phí trễ" value={vnd(data.summary.late)} note={`Hư hỏng / mất ${vnd(data.summary.damage)}`} />
            <Stat label="Giảm / miễn" value={vnd(data.summary.reductions)} note="Đã trừ vào doanh thu" good={data.summary.reductions < 0} />
            <Stat label="Đang quá hạn" value={String(data.overdue.length)} note="hợp đồng chưa trả đúng hẹn" danger={data.overdue.length > 0} />
          </div>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Doanh thu theo {BUCKET_LABEL[data.bucket]}
            </h2>
            {data.by_period.length === 0 ? (
              <p className="text-sm text-slate-500">Chưa có hợp đồng tất toán trong kỳ.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Kỳ</th>
                      {COLUMNS.map((c) => <th key={c.key} className="px-2 py-2 text-right">{c.label}</th>)}
                      <th className="w-32 py-2 pl-3" aria-hidden />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {data.by_period.map((p) => (
                      <tr key={p.period}>
                        <td className="py-2 pr-3 text-slate-300">{periodLabel(p.period, data.bucket)}</td>
                        {COLUMNS.map((c) => (
                          <td key={c.key} className={`px-2 py-2 text-right tabular-nums ${c.key === "total" ? "font-semibold text-slate-100" : p[c.key] < 0 ? "text-emerald-500" : "text-slate-300"}`}>
                            {p[c.key] ? vnd(p[c.key]) : "—"}
                          </td>
                        ))}
                        <td className="py-2 pl-3">
                          <div className="h-1.5 rounded-full bg-slate-800">
                            <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${(Math.max(p.total, 0) / maxPeriod) * 100}%` }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-slate-700">
                    <tr>
                      <td className="py-2 pr-3 font-semibold text-slate-200">Cộng</td>
                      {COLUMNS.map((c) => (
                        <td key={c.key} className="px-2 py-2 text-right font-semibold tabular-nums text-slate-100">{vnd(data.summary[c.key])}</td>
                      ))}
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Tiền cọc</h2>
              <dl className="space-y-1.5 text-sm">
                <Row k="Nhận cọc trong kỳ" v={vnd(data.deposits.received)} />
                <Row k="Trừ vào tiền thuê" v={vnd(data.deposits.applied)} />
                <Row k="Hoàn lại khách" v={vnd(data.deposits.refunded)} />
                <Row k="Giữ lại (tính doanh thu)" v={vnd(data.deposits.forfeited)} />
                <div className="flex justify-between border-t border-slate-800 pt-1.5 font-semibold">
                  <dt className="text-slate-200">Cọc đang giữ (hiện tại)</dt>
                  <dd className="tabular-nums text-slate-100">{vnd(data.deposit_liability)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-slate-500">
                Hợp đồng: {data.contracts_created} tạo mới · {data.contracts_closed} tất toán · {data.contracts_cancelled} hủy
              </p>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Công suất cho thuê theo món</h2>
              {data.utilization.length === 0 ? <p className="text-sm text-slate-500">Chưa có món.</p> : (
                <ul className="space-y-3 text-sm">
                  {data.utilization.map((u) => (
                    <li key={u.item_id}>
                      <div className="flex justify-between gap-3 text-slate-300">
                        <span className="truncate">{u.item}</span>
                        <span className="shrink-0 tabular-nums">{u.percent}%</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                        <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${Math.min(100, u.percent)}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {u.rentals} lượt · {Math.round(u.rented_hours).toLocaleString("vi-VN")} giờ thuê / {u.capacity} {u.tracking_mode === "bulk" ? "cái" : "chiếc"} · {vnd(u.revenue)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {data.overdue.length > 0 && (
            <section className="overflow-x-auto rounded-2xl border border-rose-500/30">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="bg-rose-500/10 text-left text-xs uppercase tracking-wider text-rose-500">
                  <tr>
                    <th className="px-4 py-2.5">Hợp đồng</th>
                    <th className="px-4 py-2.5">Khách</th>
                    <th className="px-4 py-2.5">Món</th>
                    <th className="px-4 py-2.5">Hẹn trả</th>
                    <th className="px-4 py-2.5 text-right">Phí trễ đang tính</th>
                    <th className="px-4 py-2.5 text-right">Cọc giữ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {data.overdue.map((o) => (
                    <tr key={o.contract_id}>
                      <td className="px-4 py-2.5"><Link href={`/rental/contracts/${o.contract_id}`} className="font-mono text-indigo-500 hover:underline">{o.code}</Link></td>
                      <td className="px-4 py-2.5 text-slate-200">{o.customer}<span className="block text-xs text-slate-500">{o.phone}</span></td>
                      <td className="px-4 py-2.5 text-slate-300">{o.lines.map((l) => (l.unit_code ? `${l.item} · ${l.unit_code}` : `${l.item} × ${l.quantity}`)).join(", ")}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-semibold text-rose-500">{fmtTime(o.due)}</span>
                        <span className="block text-xs text-slate-500">trễ {fmtDuration(o.overdue_minutes)}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-rose-500">{vnd(o.late_fee)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{vnd(o.deposit_held)}</td>
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

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><dt className="text-slate-400">{k}</dt><dd className="tabular-nums text-slate-200">{v}</dd></div>;
}

function Stat({ label, value, note, danger, good }: { label: string; value: string; note: string; danger?: boolean; good?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${danger ? "text-rose-500" : good ? "text-emerald-500" : "text-slate-100"}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </div>
  );
}
