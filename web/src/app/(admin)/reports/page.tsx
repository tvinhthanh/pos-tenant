"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import api from "@/utils/api";
import SalesBreakdown from "@/components/SalesBreakdown";
import RevenueForecast from "@/components/RevenueForecast";
import { toast } from "@/components/Toaster";
import { exportReportExcel } from "@/utils/fnb";
import { Calendar, ArrowRight, ShieldCheck, FileSpreadsheet } from "lucide-react";


// toISOString() đổi sang UTC nên ở múi giờ +07 sẽ lùi 1 ngày với mốc nửa đêm.
// Ngày mặc định của bộ lọc phải là ngày địa phương.
const toDateInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Các khoảng ngày chọn nhanh (theo giờ máy, tức giờ VN tại quán). */
function quickRanges() {
  const today = new Date();
  const shift = (days: number) => { const d = new Date(today); d.setDate(d.getDate() + days); return d; };
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
  return [
    { label: "Hôm nay", from: toDateInput(today), to: toDateInput(today) },
    { label: "Hôm qua", from: toDateInput(shift(-1)), to: toDateInput(shift(-1)) },
    { label: "7 ngày", from: toDateInput(shift(-6)), to: toDateInput(today) },
    { label: "Tháng này", from: toDateInput(firstOfMonth), to: toDateInput(today) },
    { label: "Tháng trước", from: toDateInput(firstOfLastMonth), to: toDateInput(lastOfLastMonth) },
  ];
}

export default function Reports() {
  const [startDate, setStartDate] = useState(
    toDateInput(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  );
  const [endDate, setEndDate] = useState(toDateInput(new Date()));
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportReportExcel(startDate, endDate);
      toast.success("Đã xuất báo cáo Excel.");
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || "Xuất Excel thất bại.");
    } finally {
      setExporting(false);
    }
  };

  // 1. Fetch financial report data
  const { data: report, refetch: refetchReport } = useQuery({
    queryKey: ["financialReport", startDate, endDate],
    queryFn: async () => {
      const res = await api.get(`/api/v1/reports/financial?start_date=${startDate}&end_date=${endDate}`);
      return res.data;
    }
  });

  // 2. Fetch cashbook for general journal
  const { data: journal } = useQuery({
    queryKey: ["journal"],
    queryFn: async () => {
      const res = await api.get("/api/v1/cashbook");
      return res.data;
    }
  });

  return (
    <div className="space-y-8">
            
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Báo cáo thuế & tài chính</h1>
                <p className="text-slate-500 text-xs mt-0.5">Theo dõi kết quả kinh doanh, thuế ước tính và nhật ký kế toán chung.</p>
              </div>

              {/* Date Filters */}
              <div className="flex flex-col items-stretch md:items-end gap-2 w-full md:w-auto">
              <div className="flex flex-wrap gap-1.5 md:justify-end">
                {quickRanges().map((r) => {
                  const active = startDate === r.from && endDate === r.to;
                  return (
                    <button
                      key={r.label}
                      onClick={() => { setStartDate(r.from); setEndDate(r.to); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        active
                          ? "bg-indigo-600 border-indigo-600 text-white"
                          : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center space-x-2 bg-slate-900 border border-slate-800 p-2 rounded-xl text-xs">
                <Calendar className="w-4 h-4 text-slate-500" />
                <input 
                  type="date" 
                  value={startDate} 
                  onChange={(e) => setStartDate(e.target.value)}
                  className="bg-transparent text-slate-300 focus:outline-none" 
                />
                <ArrowRight className="w-3.5 h-3.5 text-slate-650" />
                <input 
                  type="date" 
                  value={endDate} 
                  onChange={(e) => setEndDate(e.target.value)}
                  className="bg-transparent text-slate-300 focus:outline-none" 
                />
                <button
                  onClick={() => refetchReport()}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-semibold transition-all shrink-0 ml-2"
                >
                  Lọc
                </button>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white px-3 py-1.5 rounded-lg font-semibold transition-all shrink-0"
                  title="Xuất Excel 5 sheet: tổng quan, bán hàng, kết ca, chi phí, tồn kho"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  {exporting ? "Đang xuất..." : "Xuất Excel"}
                </button>
              </div>
              </div>
            </div>

            {/* Financial P&L indicators */}
            {report && (
              <div className="glass-panel p-6 rounded-2xl space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Kết quả kinh doanh trong kỳ chọn</h3>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 text-center">
                  <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
                    <span className="text-[10px] text-slate-500 font-semibold block uppercase">1. Doanh thu POS</span>
                    <span className="text-sm font-bold text-slate-100 block mt-1.5">{report.revenue.toLocaleString("vi-VN")}đ</span>
                  </div>
                  <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
                    <span className="text-[10px] text-slate-500 font-semibold block uppercase">2. Giá vốn (COGS)</span>
                    <span className="text-sm font-bold text-slate-350 block mt-1.5">{report.cogs.toLocaleString("vi-VN")}đ</span>
                  </div>
                  <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
                    <span className="text-[10px] text-slate-500 font-semibold block uppercase">3. Lãi gộp (1 - 2)</span>
                    <span className="text-sm font-bold text-indigo-400 block mt-1.5">{report.gross_profit.toLocaleString("vi-VN")}đ</span>
                  </div>
                  <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
                    <span className="text-[10px] text-slate-500 font-semibold block uppercase">4. Phí vận hành</span>
                    <span className="text-sm font-bold text-rose-400 block mt-1.5">{report.total_expenses.toLocaleString("vi-VN")}đ</span>
                  </div>
                  <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
                    <span className="text-[10px] text-slate-500 font-semibold block uppercase">5. Lãi ròng (3 - 4)</span>
                    <span className="text-sm font-bold text-emerald-400 block mt-1.5">{report.net_profit.toLocaleString("vi-VN")}đ</span>
                  </div>
                  <div className="p-4 bg-slate-900/40 border border-slate-850 rounded-xl">
                    <span className="text-[10px] text-slate-500 font-semibold block uppercase">6. Thuế khoán HKD</span>
                    <span className="text-sm font-bold text-amber-500 block mt-1.5">{report.estimated_tax.toLocaleString("vi-VN")}đ</span>
                  </div>
                </div>

                <div className="p-4 bg-indigo-500/5 border border-indigo-500/15 rounded-xl text-xs text-slate-400 flex items-start space-x-2.5">
                  <ShieldCheck className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Hỗ trợ chuẩn bị Thuế:</strong> Chỉ tiêu số 6 (Thuế khoán HKD) được ước tính bằng <strong>1.5% doanh thu</strong> đối với mô hình kinh doanh ăn uống & thương mại bán lẻ tại Việt Nam (gồm 1% Thuế GTGT và 0.5% Thuế TNCN). Số liệu này giúp bạn kê khai tờ khai thuế hộ kinh doanh cực kỳ dễ dàng.
                  </span>
                </div>
              </div>
            )}

            {/* Dự báo doanh thu (forecast_revenue) */}
            <RevenueForecast />

            {/* Thống kê món / sốt / size / danh mục */}
            <div id="sales-breakdown" className="scroll-mt-20">
              <SalesBreakdown
                key={startDate === endDate ? "single-day" : "range"}
                startDate={startDate}
                endDate={endDate}
                onPickDay={(day) => {
                  setStartDate(day);
                  setEndDate(day);
                  document.getElementById("sales-breakdown")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            </div>

            {/* TAB 3: NHẬT KÝ KẾ TOÁN CHUNG (SIMPLE GENERAL JOURNAL) */}
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-slate-100">Nhật ký kế toán chung đơn giản</h2>
              <p className="text-slate-500 text-xs">Danh sách các nghiệp vụ kinh tế được định khoản tự động thu/chi. Rất dễ cho kế toán thuế đối chiếu.</p>
              
              <div className="glass-panel rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-900/60 text-slate-400 font-semibold text-xs border-b border-slate-800">
                      <th className="p-4 pl-6">Thời gian</th>
                      <th className="p-4">Nghiệp vụ</th>
                      <th className="p-4">Định khoản Gốc</th>
                      <th className="p-4 text-right">Thu (Nợ quỹ)</th>
                      <th className="p-4 text-right pr-6">Chi (Có quỹ)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-sm text-slate-300">
                    {journal?.slice(0, 15).map((j: any) => {
                      const isThu = j.type === "thu";
                      return (
                        <tr key={j.id} className="hover:bg-slate-900/20 transition-colors">
                          <td className="p-4 pl-6 text-xs text-slate-500">{new Date(j.date).toLocaleDateString("vi-VN")}</td>
                          <td className="p-4">
                            <span className="font-semibold text-slate-200 block">{j.category}</span>
                            <span className="text-[10px] text-slate-500 mt-0.5">{j.description}</span>
                          </td>
                          <td className="p-4 text-xs font-semibold">
                            {isThu ? (
                              <span className="text-indigo-400">Nợ TK 111 (Tiền) / Có TK 511 (Doanh thu)</span>
                            ) : (
                              <span className="text-rose-400">Nợ TK 642 (Chi phí) / Có TK 111 (Tiền)</span>
                            )}
                          </td>
                          <td className="p-4 text-right font-bold text-emerald-400">
                            {isThu ? `${j.amount.toLocaleString("vi-VN")}đ` : "-"}
                          </td>
                          <td className="p-4 text-right font-bold text-rose-400 pr-6">
                            {!isThu ? `${j.amount.toLocaleString("vi-VN")}đ` : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

    </div>
  );
}
