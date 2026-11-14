"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3, TrendingUp, Users, Store, ShoppingCart,
  DollarSign, Activity, ChevronDown, ArrowUpRight
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  Tooltip, CartesianGrid, BarChart, Bar, Cell
} from "recharts";
import api from "@/utils/api";

interface OrgStat {
  id: number;
  name: string;
  is_active: boolean;
  plan: string;
  users: number;
  orders: number;
  revenue: number;
}

interface SystemStats {
  scope: string;
  total_orgs: number;
  total_orgs_active: number;
  total_branches: number;
  total_users: number;
  total_orders: number;
  total_revenue: number;
  active_subscriptions: number;
  monthly_revenue: { label: string; revenue: number }[];
  org_stats: OrgStat[];
}

interface SaasMetrics {
  mrr: number;
  total_organizations: number;
  active_organizations: number;
  churn_rate_percent: number;
  ltv: number;
}

const VND = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

const PLAN_COLORS: Record<string, string> = {
  Starter: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  Pro:     "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
  Enterprise: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "—":     "bg-slate-800 text-slate-500 border-slate-700",
};

export default function SuperadminStatsPage() {
  const [selectedOrg, setSelectedOrg] = useState<number | null>(null);

  const { data: stats, isLoading } = useQuery<SystemStats>({
    queryKey: ["superStats", selectedOrg],
    queryFn: async () => {
      const url = selectedOrg
        ? `/api/v1/auth/super/stats?org_id=${selectedOrg}`
        : "/api/v1/auth/super/stats";
      const res = await api.get(url);
      return res.data;
    },
    refetchInterval: 30000,
  });

  const { data: orgs = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["superOrgs"],
    queryFn: async () => {
      const res = await api.get("/api/v1/auth/super/organizations");
      return res.data;
    },
  });

  const { data: saasMetrics } = useQuery<SaasMetrics>({
    queryKey: ["saasMetrics"],
    queryFn: async () => {
      const res = await api.get("/api/v1/reports/saas-metrics");
      return res.data;
    },
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
      </div>
    );
  }

  const kpiCards = [
    { label: "Tổ chức",     value: stats?.total_orgs ?? 0,           sub: `${stats?.total_orgs_active ?? 0} đang hoạt động`, icon: Store,        color: "indigo" },
    { label: "Chi nhánh",   value: stats?.total_branches ?? 0,        sub: "Toàn hệ thống",  icon: Activity,     color: "violet" },
    { label: "Người dùng",  value: stats?.total_users ?? 0,           sub: "Không kể SA",    icon: Users,        color: "sky" },
    { label: "Đơn hàng",    value: stats?.total_orders ?? 0,          sub: "Tổng lịch sử",   icon: ShoppingCart, color: "emerald" },
    { label: "Doanh thu",   value: VND(stats?.total_revenue ?? 0),    sub: "Đã hoàn thành",  icon: DollarSign,   color: "amber" },
    { label: "Thuê bao",    value: stats?.active_subscriptions ?? 0,  sub: "Đang active",    icon: TrendingUp,   color: "rose" },
  ];

  const colorMap: Record<string, string> = {
    indigo: "text-indigo-400 bg-indigo-500/10",
    violet: "text-violet-400 bg-violet-500/10",
    sky: "text-sky-400 bg-sky-500/10",
    emerald: "text-emerald-400 bg-emerald-500/10",
    amber: "text-amber-400 bg-amber-500/10",
    rose: "text-rose-400 bg-rose-500/10",
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-indigo-400" />
            Thống Kê Hệ Thống
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Tổng quan hiệu suất toàn nền tảng SaaS theo thời gian thực
          </p>
        </div>

        {/* Org filter */}
        <div className="relative">
          <select
            id="stats-org-filter"
            className="pl-4 pr-10 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-sm text-slate-200 appearance-none cursor-pointer focus:outline-none focus:border-indigo-500"
            value={selectedOrg ?? ""}
            onChange={(e) => setSelectedOrg(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Toàn hệ thống</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
        </div>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          const cls = colorMap[card.color];
          return (
            <div key={card.label} className="glass-card p-5 rounded-2xl">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${cls}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="text-2xl font-bold text-slate-100 leading-tight mb-1 truncate">
                {card.value}
              </div>
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                {card.label}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">{card.sub}</div>
            </div>
          );
        })}
      </div>

      {/* SaaS Metrics */}
      {saasMetrics && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 p-6 rounded-2xl">
            <h3 className="text-sm font-semibold text-indigo-300 mb-2 uppercase tracking-wider">Doanh thu định kỳ (MRR)</h3>
            <div className="text-3xl font-black text-white">{VND(saasMetrics.mrr)}</div>
            <p className="text-xs text-indigo-200 mt-2">Dựa trên các gói đăng ký đang hoạt động</p>
          </div>
          <div className="bg-gradient-to-br from-rose-500/20 to-pink-500/20 border border-rose-500/30 p-6 rounded-2xl">
            <h3 className="text-sm font-semibold text-rose-300 mb-2 uppercase tracking-wider">Tỷ lệ rời bỏ (Churn Rate)</h3>
            <div className="text-3xl font-black text-white">{saasMetrics.churn_rate_percent}%</div>
            <p className="text-xs text-rose-200 mt-2">Khách hàng ngưng sử dụng dịch vụ</p>
          </div>
          <div className="bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 p-6 rounded-2xl">
            <h3 className="text-sm font-semibold text-emerald-300 mb-2 uppercase tracking-wider">Giá trị trọn đời (LTV)</h3>
            <div className="text-3xl font-black text-white">{VND(saasMetrics.ltv)}</div>
            <p className="text-xs text-emerald-200 mt-2">Ước tính doanh thu trên mỗi KH</p>
          </div>
        </div>
      )}

      {/* Monthly revenue chart */}
      {stats?.monthly_revenue && stats.monthly_revenue.length > 0 && (
        <div className="glass-panel p-6 rounded-2xl">
          <h3 className="text-base font-bold text-slate-100 mb-5">
            Doanh thu 6 tháng gần nhất (toàn hệ thống)
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={stats.monthly_revenue}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip
                contentStyle={{ background: "#0a0f1d", border: "1px solid #1e293b", borderRadius: 12 }}
                labelStyle={{ color: "#cbd5e1" }}
                formatter={(v: number) => [VND(v), "Doanh thu"]}
              />
              <Area type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2.5}
                fill="url(#revGrad)" dot={{ fill: "#6366f1", r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Per-org breakdown */}
      {stats?.org_stats && stats.org_stats.length > 0 && (
        <div className="glass-panel p-6 rounded-2xl">
          <h3 className="text-base font-bold text-slate-100 mb-5">Hiệu suất theo từng Tổ chức</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-900 text-slate-500 font-bold uppercase tracking-wider">
                  <th className="p-3">Tổ chức</th>
                  <th className="p-3">Gói</th>
                  <th className="p-3 text-right">Users</th>
                  <th className="p-3 text-right">Đơn hàng</th>
                  <th className="p-3 text-right">Doanh thu</th>
                  <th className="p-3 text-center">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/60">
                {stats.org_stats.map((org) => (
                  <tr key={org.id} className="hover:bg-slate-900/30 transition-colors">
                    <td className="p-3 font-semibold text-slate-200 flex items-center gap-2">
                      <Store className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      {org.name}
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-bold ${PLAN_COLORS[org.plan] ?? PLAN_COLORS["—"]}`}>
                        {org.plan}
                      </span>
                    </td>
                    <td className="p-3 text-right text-slate-300 font-mono">{org.users}</td>
                    <td className="p-3 text-right text-slate-300 font-mono">{org.orders}</td>
                    <td className="p-3 text-right text-emerald-400 font-bold font-mono">{VND(org.revenue)}</td>
                    <td className="p-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                        org.is_active
                          ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                          : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                      }`}>
                        {org.is_active ? "Hoạt động" : "Đã khóa"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
