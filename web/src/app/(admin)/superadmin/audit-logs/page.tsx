"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ScrollText, Search, Filter, ChevronDown,
  Clock, User, Store, GitBranch, RefreshCw
} from "lucide-react";
import api from "@/utils/api";

interface AuditLogItem {
  id: number;
  action: string;
  description: string | null;
  created_at: string | null;
  ip_address: string | null;
  actor: string;
  actor_role: string | null;
  org_id: number | null;
  org_name: string | null;
  branch_id: number | null;
  branch_name: string | null;
}

interface AuditLogResponse {
  total: number;
  items: AuditLogItem[];
}

const ACTION_COLOR: Record<string, string> = {
  OrderCompleted:       "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
  OrderRefundAlert:     "bg-amber-500/10  border-amber-500/20  text-amber-400",
  InventoryImported:    "bg-sky-500/10    border-sky-500/20    text-sky-400",
  OrderRefunded:        "bg-rose-500/10   border-rose-500/20   text-rose-400",
};

function actionColor(action: string) {
  return ACTION_COLOR[action] ?? "bg-slate-800 border-slate-700 text-slate-400";
}

const PAGE_SIZE = 50;

export default function SuperadminAuditLogsPage() {
  const [orgFilter, setOrgFilter] = useState<string>("");
  const [search, setSearch]       = useState<string>("");
  const [page, setPage]           = useState(0);

  const { data: orgs = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["superOrgs"],
    queryFn: async () => (await api.get("/api/v1/auth/super/organizations")).data,
  });

  const { data, isLoading, refetch } = useQuery<AuditLogResponse>({
    queryKey: ["superAuditLogs", orgFilter, page],
    queryFn: async () => {
      let url = `/api/v1/auth/super/audit-logs?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
      if (orgFilter) url += `&org_id=${orgFilter}`;
      return (await api.get(url)).data;
    },
    refetchInterval: 15000,
  });

  const items = (data?.items ?? []).filter((log) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      log.action.toLowerCase().includes(q) ||
      log.actor.toLowerCase().includes(q) ||
      (log.description ?? "").toLowerCase().includes(q) ||
      (log.org_name ?? "").toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight flex items-center gap-3">
            <ScrollText className="w-8 h-8 text-violet-400" />
            Audit Log Hệ Thống
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Nhật ký toàn bộ hoạt động nghiệp vụ — cập nhật mỗi 15 giây
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-sm font-semibold transition-all active:scale-95"
        >
          <RefreshCw className="w-4 h-4" />
          Làm mới
        </button>
      </div>

      {/* Filters bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            id="audit-search"
            type="text"
            placeholder="Tìm theo action, actor, mô tả..."
            className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Org filter */}
        <div className="relative">
          <select
            id="audit-org-filter"
            className="pl-4 pr-10 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-sm text-slate-200 appearance-none cursor-pointer focus:outline-none focus:border-indigo-500"
            value={orgFilter}
            onChange={(e) => { setOrgFilter(e.target.value); setPage(0); }}
          >
            <option value="">Tất cả tổ chức</option>
            {orgs.map((o) => (
              <option key={o.id} value={String(o.id)}>{o.name}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
        </div>
      </div>

      {/* Stats pill */}
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Filter className="w-3.5 h-3.5" />
        <span>
          Hiển thị <strong className="text-slate-300">{items.length}</strong> / <strong className="text-slate-300">{data?.total ?? 0}</strong> bản ghi
        </span>
      </div>

      {/* Log Table */}
      <div className="glass-panel rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">
            Không có bản ghi nào phù hợp.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-900 text-slate-500 font-bold uppercase tracking-wider">
                  <th className="p-4">Thời gian</th>
                  <th className="p-4">Action</th>
                  <th className="p-4">Actor</th>
                  <th className="p-4">Tổ chức / Chi nhánh</th>
                  <th className="p-4">Mô tả</th>
                  <th className="p-4">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/60">
                {items.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-900/30 transition-colors align-top">
                    <td className="p-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Clock className="w-3 h-3 shrink-0" />
                        {log.created_at
                          ? new Date(log.created_at).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "medium" })
                          : "—"}
                      </div>
                    </td>
                    <td className="p-4">
                      <span className={`px-2.5 py-1 rounded-lg border text-[10px] font-bold whitespace-nowrap ${actionColor(log.action)}`}>
                        {log.action}
                      </span>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
                        <User className="w-3 h-3 text-slate-500 shrink-0" />
                        {log.actor}
                      </div>
                      {log.actor_role && (
                        <div className="text-slate-600 text-[10px] mt-0.5 capitalize">{log.actor_role}</div>
                      )}
                    </td>
                    <td className="p-4">
                      {log.org_name && (
                        <div className="flex items-center gap-1 text-slate-400">
                          <Store className="w-3 h-3 shrink-0" />
                          {log.org_name}
                        </div>
                      )}
                      {log.branch_name && (
                        <div className="flex items-center gap-1 text-slate-500 text-[10px] mt-0.5">
                          <GitBranch className="w-2.5 h-2.5 shrink-0" />
                          {log.branch_name}
                        </div>
                      )}
                      {!log.org_name && <span className="text-slate-600">—</span>}
                    </td>
                    <td className="p-4 text-slate-400 max-w-xs truncate" title={log.description ?? ""}>
                      {log.description ?? "—"}
                    </td>
                    <td className="p-4 text-slate-600 font-mono">{log.ip_address ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-bold text-slate-300 disabled:opacity-40 transition-all"
          >
            ← Trước
          </button>
          <span className="text-xs text-slate-500">
            Trang {page + 1} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-bold text-slate-300 disabled:opacity-40 transition-all"
          >
            Tiếp →
          </button>
        </div>
      )}
    </div>
  );
}
