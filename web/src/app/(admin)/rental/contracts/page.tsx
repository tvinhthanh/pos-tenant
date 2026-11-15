"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { listContracts, fmtTime, CONTRACT_STATUS_LABELS, type ContractStatus } from "@/utils/rental";
import { errorText } from "@/components/Toaster";
import OverdueAlert from "../_components/OverdueAlert";

type Filter = "open" | ContractStatus | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "open", label: "Đang mở" },
  { key: "reserved", label: "Đặt trước" },
  { key: "active", label: "Đang thuê" },
  { key: "returned", label: "Chờ tất toán" },
  { key: "closed", label: "Đã tất toán" },
  { key: "cancelled", label: "Đã hủy" },
  { key: "all", label: "Tất cả" },
];

export default function ContractsPage() {
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["rentalContracts", filter, search],
    queryFn: () => listContracts(filter, search),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Hợp đồng thuê</h1>
          <p className="text-sm text-slate-400">Đặt trước, đang thuê, chờ tất toán.</p>
        </div>
        <Link href="/rental/new" className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          <Plus className="h-4 w-4" /> Thuê mới
        </Link>
      </div>

      <OverdueAlert />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${filter === f.key ? "border-indigo-500 bg-indigo-500/10 text-indigo-500" : "border-slate-800 text-slate-400 hover:border-slate-700"}`}>
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mã hợp đồng (HD-…)"
            className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
        </div>
      </div>

      {error && <p className="text-sm text-rose-500">{errorText(error, "Không tải được hợp đồng.")}</p>}

      <div className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full min-w-[600px] text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Mã</th>
              <th className="px-4 py-2.5">Khách</th>
              <th className="px-4 py-2.5">Thời gian</th>
              <th className="px-4 py-2.5">Trạng thái</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {isLoading && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">Đang tải…</td></tr>}
            {!isLoading && data.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">Không có hợp đồng.</td></tr>}
            {data.map((c) => {
              const overdue = c.status === "active" && c.planned_end && new Date(c.planned_end) < new Date();
              return (
                <tr key={c.id} className="hover:bg-slate-900">
                  <td className="px-4 py-3"><Link href={`/rental/contracts/${c.id}`} className="font-mono font-semibold text-indigo-500 hover:underline">{c.code}</Link></td>
                  <td className="px-4 py-3 text-slate-200">{c.customers?.name}<span className="block text-xs text-slate-500">{c.customers?.phone}</span></td>
                  <td className="px-4 py-3 text-xs text-slate-400">{fmtTime(c.planned_start)} → {c.planned_end ? fmtTime(c.planned_end) : "tính giờ"}</td>
                  <td className={`px-4 py-3 text-xs font-semibold ${overdue ? "text-rose-500" : "text-slate-300"}`}>
                    {overdue ? "Quá hạn" : CONTRACT_STATUS_LABELS[c.status]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
