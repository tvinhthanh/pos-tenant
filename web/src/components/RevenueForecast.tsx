"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Info } from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";

import { getRevenueForecast } from "@/utils/fnb";

const money = (v: number) => Math.round(Number(v) || 0).toLocaleString("vi-VN");
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** "2026-11-09" → "T2 09/11" — không qua Date(UTC) để không lệch ngày. */
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return `${WEEKDAYS[wd]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
};

type Point = { name: string; ThucTe?: number; DuBao?: number };

/** Dự báo doanh thu (RPC forecast_revenue): 14 ngày gần nhất + N ngày tới. */
export default function RevenueForecast() {
  const [days, setDays] = useState(7);
  const { data, isLoading, error } = useQuery({
    queryKey: ["revenueForecast", days],
    queryFn: () => getRevenueForecast(days),
  });

  const history = (data?.history || []).slice(-14);
  const forecast = data?.forecast || [];
  const chartData: Point[] = [
    ...history.map((p) => ({ name: dayLabel(p.day), ThucTe: p.revenue })),
    ...forecast.map((p) => ({ name: dayLabel(p.day), DuBao: p.revenue })),
  ];
  // Nối đường dự báo vào điểm thực tế cuối cùng cho liền mạch
  if (history.length && forecast.length) {
    chartData[history.length - 1].DuBao = history[history.length - 1].revenue;
  }
  const total = forecast.reduce((s, p) => s + p.revenue, 0);
  const trendUp = (data?.slope || 0) >= 0;

  return (
    <div className="glass-panel p-6 rounded-2xl space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Dự báo doanh thu</h3>
          <p className="text-slate-500 text-xs mt-0.5">
            Xu hướng tuyến tính theo doanh thu từng ngày, điều chỉnh theo thứ trong tuần.
          </p>
        </div>
        <div className="flex gap-1.5">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                days === d
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              {d} ngày
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
        </div>
      ) : error ? (
        <p className="text-xs text-rose-400">
          {(error as any)?.response?.data?.detail || "Không tải được dự báo doanh thu."}
        </p>
      ) : !data || data.days_used === 0 ? (
        <p className="text-xs text-slate-500">Chưa có dữ liệu bán hàng để dự báo.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-center">
            <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
              <span className="text-[10px] text-slate-500 font-semibold block uppercase">Dự báo {days} ngày tới</span>
              <span className="text-sm font-bold text-indigo-400 block mt-1.5">{money(total)}đ</span>
            </div>
            <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
              <span className="text-[10px] text-slate-500 font-semibold block uppercase">Trung bình / ngày</span>
              <span className="text-sm font-bold text-slate-100 block mt-1.5">
                {money(forecast.length ? total / forecast.length : 0)}đ
              </span>
            </div>
            <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl col-span-2 md:col-span-1">
              <span className="text-[10px] text-slate-500 font-semibold block uppercase">Xu hướng</span>
              <span className={`text-sm font-bold mt-1.5 inline-flex items-center gap-1 ${trendUp ? "text-emerald-400" : "text-rose-400"}`}>
                {trendUp ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {trendUp ? "+" : ""}{money(data.slope)}đ / ngày
              </span>
            </div>
          </div>

          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorThucTe" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorDuBao" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="name" stroke="#64748b" fontSize={11} tickLine={false} />
                <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v / 1000}k`} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", color: "#f8fafc", borderRadius: "12px", fontSize: "12px" }}
                  formatter={(val: number, key: string) => [`${money(val)}đ`, key === "DuBao" ? "Dự báo" : "Thực tế"]}
                />
                {history.length > 0 && forecast.length > 0 && (
                  <ReferenceLine x={chartData[history.length].name} stroke="#334155" strokeDasharray="4 4" />
                )}
                <Area type="monotone" dataKey="ThucTe" stroke="#6366f1" strokeWidth={2.5} fillOpacity={1} fill="url(#colorThucTe)" connectNulls={false} />
                <Area type="monotone" dataKey="DuBao" stroke="#10b981" strokeWidth={2.5} strokeDasharray="6 4" fillOpacity={1} fill="url(#colorDuBao)" connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="flex items-start gap-2 text-[11px] text-slate-500">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Dựa trên {data.days_used} ngày gần nhất (đến hết hôm qua). Đường liền: thực tế · đường đứt: dự báo từ hôm nay.
              {!data.enough_data && " Dữ liệu còn ít (dưới 14 ngày) nên dự báo chỉ mang tính tham khảo."}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
