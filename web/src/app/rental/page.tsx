"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Lock, Plus, RefreshCw, Search, Unlock } from "lucide-react";
import api from "@/utils/api";
import ShiftModal from "@/components/ShiftModal";
import { getRentalBoard, fmtTime, UNIT_STATUS_LABELS, type BoardUnit, type UnitStatus } from "@/utils/rental";
import { errorText } from "@/components/Toaster";

const STATUS_STYLE: Record<UnitStatus, string> = {
  available: "border-emerald-500/30 bg-emerald-500/5",
  out: "border-indigo-500/40 bg-indigo-500/10",
  maintenance: "border-amber-500/40 bg-amber-500/10",
  lost: "border-rose-500/40 bg-rose-500/10",
  retired: "border-slate-700 bg-slate-900 opacity-60",
};
const STATUS_DOT: Record<UnitStatus, string> = {
  available: "bg-emerald-500", out: "bg-indigo-500", maintenance: "bg-amber-500", lost: "bg-rose-500", retired: "bg-slate-500",
};

type Filter = "all" | "available" | "out" | "overdue" | "maintenance";

export default function RentalBoardPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["rentalBoard"],
    queryFn: getRentalBoard,
    refetchInterval: 60_000, // quá hạn đổi theo giờ thực
  });

  const units = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.units ?? []).filter((u) => {
      if (filter === "overdue" && !u.current?.overdue) return false;
      if (filter !== "all" && filter !== "overdue" && u.status !== filter) return false;
      if (!term) return true;
      return [u.code, u.item_name, u.current?.customer, u.current?.phone, u.current?.code]
        .some((v) => v?.toLowerCase().includes(term));
    });
  }, [data, filter, search]);

  const counts = useMemo(() => {
    const all = data?.units ?? [];
    return {
      all: all.length,
      available: all.filter((u) => u.status === "available").length,
      out: all.filter((u) => u.status === "out").length,
      overdue: all.filter((u) => u.current?.overdue).length,
      maintenance: all.filter((u) => u.status === "maintenance").length,
    };
  }, [data]);

  const groups = useMemo(() => {
    const map = new Map<string, BoardUnit[]>();
    for (const u of units) {
      const key = u.item_name;
      map.set(key, [...(map.get(key) ?? []), u]);
    }
    return [...map.entries()];
  }, [units]);

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "Tất cả" },
    { key: "available", label: "Sẵn sàng" },
    { key: "out", label: "Đang thuê" },
    { key: "overdue", label: "Quá hạn" },
    { key: "maintenance", label: "Bảo trì" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Bảng cho thuê</h1>
          <p className="text-sm text-slate-400">Trạng thái từng chiếc, ai đang giữ, khi nào phải trả.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ShiftButton />
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-900"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Làm mới
          </button>
          <Link
            href="/rental/new"
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" /> Thuê mới
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
              filter === f.key
                ? f.key === "overdue"
                  ? "border-rose-500 bg-rose-500/10 text-rose-500"
                  : "border-indigo-500 bg-indigo-500/10 text-indigo-500"
                : "border-slate-800 text-slate-400 hover:border-slate-700"
            }`}
          >
            {f.label} <span className="tabular-nums opacity-70">{counts[f.key]}</span>
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Mã, món, khách, SĐT…"
            className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {error && <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-500">{errorText(error, "Không tải được bảng cho thuê.")}</p>}
      {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}

      {!isLoading && !error && (data?.units.length ?? 0) === 0 && (data?.bulk.length ?? 0) === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center">
          <p className="text-sm text-slate-400">Chưa có món cho thuê nào.</p>
          <Link href="/rental/catalog" className="mt-3 inline-block text-sm font-semibold text-indigo-500 hover:underline">
            Thêm món cho thuê →
          </Link>
        </div>
      )}

      {groups.map(([itemName, list]) => (
        <section key={itemName} className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300">
            {itemName} <span className="font-normal text-slate-500">· {list.length} chiếc</span>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {list.map((u) => (
              <UnitCard key={u.unit_id} unit={u} />
            ))}
          </div>
        </section>
      ))}

      {(data?.bulk.length ?? 0) > 0 && (filter === "all" || filter === "overdue") && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300">Hàng theo số lượng</h2>
          <div className="overflow-x-auto rounded-2xl border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Món</th>
                  <th className="px-4 py-2.5 text-right">Tổng</th>
                  <th className="px-4 py-2.5 text-right">Đang thuê</th>
                  <th className="px-4 py-2.5 text-right">Còn lại</th>
                  <th className="px-4 py-2.5 text-right">Quá hạn</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {data!.bulk.map((b) => (
                  <tr key={b.item_id} className="text-slate-200">
                    <td className="px-4 py-2.5">{b.item_name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{b.total}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{b.out}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{Math.max(b.total - b.out, 0)}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${b.overdue > 0 ? "font-semibold text-rose-500" : "text-slate-500"}`}>
                      {b.overdue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// Giao đồ, nhận cọc, tất toán đều cần ca đang mở (tiền vào két của ca).
function ShiftButton() {
  const [open, setOpen] = useState(false);
  const { data: shift, isLoading } = useQuery({
    queryKey: ["currentShift"],
    queryFn: async () => (await api.get("/api/v1/shifts/current")).data as { status?: string; opened_at?: string } | null,
  });
  if (isLoading) return null;
  const isOpen = shift?.status === "open";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold ${
          isOpen ? "border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10" : "border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20"
        }`}
      >
        {isOpen ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
        {isOpen ? "Ca đang mở · Chốt ca" : "Chưa mở ca · Mở ca"}
      </button>
      <ShiftModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

function UnitCard({ unit }: { unit: BoardUnit }) {
  const overdue = unit.current?.overdue;
  const body = (
    <div className={`h-full rounded-2xl border p-4 transition ${overdue ? "border-rose-500/60 bg-rose-500/10" : STATUS_STYLE[unit.status]}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-semibold text-slate-100">{unit.code}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className={`h-2 w-2 rounded-full ${overdue ? "bg-rose-500" : STATUS_DOT[unit.status]}`} />
          {overdue ? "Quá hạn" : UNIT_STATUS_LABELS[unit.status]}
        </span>
      </div>

      {unit.current ? (
        <div className="mt-3 space-y-1 text-xs">
          <p className="truncate font-semibold text-slate-200">{unit.current.customer}</p>
          <p className="text-slate-500">{unit.current.phone} · {unit.current.code}</p>
          <p className={overdue ? "flex items-center gap-1 font-semibold text-rose-500" : "text-slate-400"}>
            {overdue && <AlertTriangle className="h-3.5 w-3.5" />}
            {unit.current.due ? `Hẹn trả ${fmtTime(unit.current.due)}` : `Tính giờ từ ${fmtTime(unit.current.since)}`}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">{unit.status === "available" ? "Sẵn sàng cho thuê" : "Không cho thuê lúc này"}</p>
      )}

      {unit.next && (
        <p className="mt-3 flex items-center gap-1 border-t border-slate-800 pt-2 text-[11px] text-slate-400">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Đặt: {unit.next.customer} · {fmtTime(unit.next.start)}</span>
        </p>
      )}
    </div>
  );

  const contractId = unit.current?.contract_id ?? unit.next?.contract_id;
  return contractId ? (
    <Link href={`/rental/contracts/${contractId}`} className="block hover:-translate-y-0.5">{body}</Link>
  ) : (
    body
  );
}
