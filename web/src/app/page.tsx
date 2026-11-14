"use client";

import React, { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import api from "@/utils/api";
import { getSalesSummary } from "@/utils/rpc";
import { 
  TrendingUp, TrendingDown, DollarSign, Package, 
  AlertTriangle, CheckCircle2, ChevronRight, Award
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, 
  Tooltip, CartesianGrid
} from "recharts";

const money = (value: unknown) => Number(value || 0).toLocaleString("vi-VN");

const toDateInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export default function Dashboard() {
  const [user, setUser] = useState<{ role: string } | null>(null);
  const [checkingRole, setCheckingRole] = useState(true);

  const now = new Date();
  const monthStart = toDateInput(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = toDateInput(now);

  useEffect(() => {
    api.get("/api/v1/auth/me")
      .then((res) => {
        setUser(res.data);
        setCheckingRole(false);
      })
      .catch(() => {
        setCheckingRole(false);
      });
  }, []);

  const isEnabled = !checkingRole && user !== null;

  // 1. Fetch dữ liệu báo cáo tài chính — thẻ KPI ghi "tháng" nên phải lọc theo
  // tháng hiện tại, không lấy toàn bộ lịch sử.
  const { data: report, isLoading: loadingReport } = useQuery({
    queryKey: ["financialReport", monthStart, monthEnd],
    queryFn: async () => {
      const res = await api.get(`/api/v1/reports/financial?start_date=${monthStart}&end_date=${monthEnd}`);
      return res.data;
    },
    enabled: isEnabled
  });

  // 2. Fetch số dư sổ quỹ
  const { data: balanceData } = useQuery({
    queryKey: ["cashbookBalance"],
    queryFn: async () => {
      const res = await api.get("/api/v1/cashbook/balance");
      return res.data;
    },
    enabled: isEnabled
  });

  // 3. Fetch nguyên liệu để cảnh báo kho
  const { data: ingredients } = useQuery({
    queryKey: ["ingredients"],
    queryFn: async () => {
      const res = await api.get("/api/v1/inventory/ingredients");
      return res.data;
    },
    enabled: isEnabled
  });

  // 4. Doanh thu 7 ngày + món bán chạy: tính ở DB (get_sales_breakdown) trên
  // TOÀN BỘ đơn trong kỳ. Trước đây tính trên 50 đơn gần nhất nên sai khi quán
  // bán nhiều hơn 50 đơn/tuần.
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const weekStartKey = toDateInput(weekStart);
  const { data: sales } = useQuery({
    queryKey: ["dashboardSales", weekStartKey],
    queryFn: () => getSalesSummary(
      new Date(`${weekStartKey}T00:00:00`).toISOString(),
      new Date(`${toDateInput(now)}T23:59:59.999`).toISOString(),
    ),
    enabled: isEnabled
  });

  if (checkingRole) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  // Biểu đồ 7 ngày: DB trả đủ từng ngày (kể cả ngày không bán), cũ → mới
  const getChartData = () =>
    [...(sales?.days || [])].reverse().map((d) => {
      const [y, m, day] = d.day.split("-").map(Number);
      return {
        name: new Date(y, m - 1, day).toLocaleDateString("vi-VN", { weekday: "short", day: "numeric" }),
        DoanhThu: d.revenue,
      };
    });

  // Top 4 món bán chạy 7 ngày (theo số phần)
  const getTopProducts = () =>
    (sales?.products || []).slice(0, 4).map((p) => ({ name: p.product_name, qty: p.quantity, revenue: p.revenue }));

  const chartData = getChartData();
  const topProducts = getTopProducts();
  
  // Cảnh báo nguyên liệu sắp hết (low stock)
  const lowStockItems = ingredients?.filter((ing: any) => ing.stock <= ing.min_stock) || [];

  return (
    <div className="space-y-8">
            
            {/* Header section */}
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight">Bảng Điều Khiển</h1>
                <p className="text-slate-400 text-sm mt-1">Thông tin kết quả hoạt động kinh doanh hôm nay và tháng này</p>
              </div>
              <div className="text-right">
                <span className="text-xs text-slate-500 font-semibold block uppercase tracking-wider">Hôm nay</span>
                <span className="text-sm text-indigo-400 font-bold block mt-0.5">
                  {new Date().toLocaleDateString("vi-VN", { dateStyle: "full" })}
                </span>
              </div>
            </div>

            {/* Metric KPI cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {/* Card Doanh thu */}
              <div className="glass-card p-6 rounded-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl"></div>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-slate-400 text-xs font-semibold block uppercase tracking-wider">Doanh thu tháng</span>
                    <span className="text-2xl font-bold text-slate-100 block mt-2">
                      {money(report?.revenue)}đ
                    </span>
                  </div>
                  <div className="bg-indigo-500/10 p-2.5 rounded-xl text-indigo-400">
                    <TrendingUp className="w-5 h-5" />
                  </div>
                </div>
                <span className="text-[10px] text-indigo-400/80 font-medium block mt-4">
                  Tổng thu dựa trên {report?.orders_count || 0} đơn hàng bán ra
                </span>
              </div>

              {/* Card Giá vốn */}
              <div className="glass-card p-6 rounded-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl"></div>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-slate-400 text-xs font-semibold block uppercase tracking-wider">Giá vốn hàng bán</span>
                    <span className="text-2xl font-bold text-slate-100 block mt-2">
                      {money(report?.cogs)}đ
                    </span>
                  </div>
                  <div className="bg-amber-500/10 p-2.5 rounded-xl text-amber-400">
                    <Package className="w-5 h-5" />
                  </div>
                </div>
                <span className="text-[10px] text-amber-400/80 font-medium block mt-4">
                  Định lượng hao hụt theo công thức
                </span>
              </div>

              {/* Card Chi phí */}
              <div className="glass-card p-6 rounded-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-rose-500/5 rounded-full blur-2xl"></div>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-slate-400 text-xs font-semibold block uppercase tracking-wider">Chi phí vận hành</span>
                    <span className="text-2xl font-bold text-slate-100 block mt-2">
                      {money(report?.total_expenses)}đ
                    </span>
                  </div>
                  <div className="bg-rose-500/10 p-2.5 rounded-xl text-rose-400">
                    <TrendingDown className="w-5 h-5" />
                  </div>
                </div>
                <span className="text-[10px] text-rose-400/80 font-medium block mt-4">
                  Mkt ads, lương, mặt bằng, điện nước
                </span>
              </div>

              {/* Card Lợi nhuận */}
              <div className="glass-card p-6 rounded-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl"></div>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-slate-400 text-xs font-semibold block uppercase tracking-wider">Lợi nhuận ròng</span>
                    <span className="text-2xl font-bold text-emerald-400 block mt-2">
                      {money(report?.net_profit)}đ
                    </span>
                  </div>
                  <div className="bg-emerald-500/10 p-2.5 rounded-xl text-emerald-400">
                    <DollarSign className="w-5 h-5" />
                  </div>
                </div>
                <span className="text-[10px] text-emerald-400/80 font-medium block mt-4">
                  Lợi nhuận thực nhận đã trừ hết chi phí
                </span>
              </div>
            </div>

            {/* Main Stats Graph and Side Panels */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              
              {/* Sales Chart Panel */}
              <div className="lg:col-span-2 glass-panel p-6 rounded-2xl">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-100">Xu hướng Doanh thu</h3>
                    <p className="text-slate-500 text-xs mt-0.5">Biểu đồ doanh số bán hàng trong 7 ngày gần nhất</p>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 px-3.5 py-1.5 rounded-xl text-xs text-indigo-400 font-semibold">
                    Biên quỹ quỹ: {money(balanceData?.balance)}đ
                  </div>
                </div>

                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorDoanhThu" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="name" stroke="#64748b" fontSize={11} tickLine={false} />
                      <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} tickFormatter={v => `${v/1000}k`} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", color: "#f8fafc", borderRadius: "12px", fontSize: "12px" }}
                        formatter={(val: number) => [`${money(val)}đ`, "Doanh thu"]}
                      />
                      <Area type="monotone" dataKey="DoanhThu" stroke="#6366f1" strokeWidth={2.5} fillOpacity={1} fill="url(#colorDoanhThu)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Side Panels: Low Stock & Top Products */}
              <div className="space-y-8">
                {/* Low Stock Panel */}
                <div className="glass-panel p-6 rounded-2xl">
                  <h3 className="text-lg font-bold text-slate-100 flex items-center space-x-2">
                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                    <span>Cảnh Báo Hết Kho</span>
                  </h3>
                  <div className="mt-4 space-y-3 max-h-[160px] overflow-y-auto pr-1">
                    {lowStockItems.length === 0 ? (
                      <div className="flex items-center space-x-2.5 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-emerald-400 text-xs">
                        <CheckCircle2 className="w-4.5 h-4.5" />
                        <span>Kho nguyên liệu đầy đủ, hoạt động tốt!</span>
                      </div>
                    ) : (
                      lowStockItems.map((ing: any) => (
                        <div key={ing.id} className="flex justify-between items-center p-3 bg-slate-900/50 border border-slate-800/80 rounded-xl">
                          <div>
                            <span className="text-sm font-semibold text-slate-200 block">{ing.name}</span>
                            <span className="text-[10px] text-slate-500 mt-0.5">Tối thiểu: {ing.min_stock}{ing.unit}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-xs font-bold text-rose-400 block">{ing.stock}{ing.unit}</span>
                            <span className="text-[9px] bg-rose-500/10 border border-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded mt-1 block w-fit ml-auto">Thiếu hụt</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Top Products Panel */}
                <div className="glass-panel p-6 rounded-2xl">
                  <h3 className="text-lg font-bold text-slate-100 flex items-center space-x-2">
                    <Award className="w-5 h-5 text-indigo-400" />
                    <span>Top bán chạy 7 ngày</span>
                  </h3>
                  <div className="mt-4 space-y-3">
                    {topProducts.length === 0 ? (
                      <div className="text-center py-4 text-xs text-slate-500">Chưa có dữ liệu đơn hàng</div>
                    ) : (
                      topProducts.map((prod: any, idx) => (
                        <div key={prod.name} className="flex items-center justify-between p-2.5 hover:bg-slate-900/40 rounded-xl transition-all">
                          <div className="flex items-center space-x-3">
                            <div className="w-6 h-6 rounded-full bg-indigo-500/10 flex items-center justify-center text-xs font-bold text-indigo-400 shrink-0">
                              {idx + 1}
                            </div>
                            <span className="text-sm font-semibold text-slate-300 truncate max-w-[150px]">{prod.name}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-xs font-bold text-slate-200 block">{prod.qty} phần</span>
                            <span className="text-[10px] text-slate-500 mt-0.5">{money(prod.revenue)}đ</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

            </div>
    </div>
  );
}
