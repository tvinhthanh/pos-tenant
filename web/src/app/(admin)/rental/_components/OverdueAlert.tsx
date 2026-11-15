"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Phone } from "lucide-react";
import { fmtDuration, fmtTime, getOverdue, vnd } from "@/utils/rental";

/**
 * Cảnh báo hợp đồng quá hạn (đồ chưa trả sau giờ hẹn). Quá hạn không lưu trong DB
 * mà tính từ rental_lines, nên làm mới mỗi phút. Không có gì quá hạn → không hiện.
 */
export default function OverdueAlert({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { data } = useQuery({
    queryKey: ["rentalOverdue"],
    queryFn: getOverdue,
    refetchInterval: 60_000,
  });
  const list = data?.contracts ?? [];
  if (list.length === 0) return null;
  const totalLate = list.reduce((s, c) => s + c.late_fee, 0);

  return (
    <section role="alert" className="rounded-2xl border border-rose-500/40 bg-rose-500/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <AlertTriangle className="h-5 w-5 shrink-0 text-rose-500" />
        <span className="text-sm font-semibold text-rose-600 dark:text-rose-400">
          {list.length} hợp đồng quá hạn trả
        </span>
        <span className="hidden text-xs text-rose-600/80 sm:inline dark:text-rose-300/80">
          · phí trễ đang tính {vnd(totalLate)}
        </span>
        <ChevronDown className={`ml-auto h-4 w-4 text-rose-500 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="divide-y divide-rose-500/20 border-t border-rose-500/20">
          {list.map((c) => (
            <li key={c.contract_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
              <Link href={`/rental/contracts/${c.contract_id}`} className="font-mono font-semibold text-indigo-500 hover:underline">
                {c.code}
              </Link>
              <span className="text-slate-200">{c.customer}</span>
              {c.phone && (
                <a href={`tel:${c.phone}`} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
                  <Phone className="h-3.5 w-3.5" /> {c.phone}
                </a>
              )}
              <span className="text-xs text-slate-400">
                {c.lines.map((l) => (l.unit_code ? `${l.item} · ${l.unit_code}` : `${l.item} × ${l.quantity}`)).join(", ")}
              </span>
              <span className="ml-auto text-right text-xs">
                <span className="font-semibold text-rose-500">Trễ {fmtDuration(c.overdue_minutes)}</span>
                <span className="block text-slate-400">hẹn {fmtTime(c.due)} · phí trễ {vnd(c.late_fee)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
