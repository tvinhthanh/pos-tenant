"use client";

import React, { useEffect, useRef } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { supabase } from "@/utils/api";
import { countPendingOnline } from "@/utils/website";
import { toast } from "@/components/Toaster";

/** Chuông ở Header: số đơn online đang chờ; đơn mới đến thì báo ngay (Realtime). */
export default function OnlineBell() {
  const qc = useQueryClient();
  const { data: count = 0 } = useQuery({ queryKey: ["onlinePendingCount"], queryFn: countPendingOnline, refetchInterval: 60_000 });
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => {
    const ch = supabase.channel("online-requests-bell")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "online_requests" }, (p: any) => {
        qc.invalidateQueries({ queryKey: ["onlinePendingCount"] });
        qc.invalidateQueries({ queryKey: ["onlineRequests"] });
        toast.success(`Đơn online mới ${p.new?.code ?? ""}`.trim());
        // Tiếng "ting" ngắn, không cần file âm thanh
        try {
          audio.current ??= new AudioContext();
          const ctx = audio.current, o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = 880; g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
          o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
        } catch { /* trình duyệt chặn âm thanh khi chưa tương tác */ }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "online_requests" }, () => {
        qc.invalidateQueries({ queryKey: ["onlinePendingCount"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  return (
    <Link href="/online" aria-label={count ? `${count} đơn online đang chờ` : "Đơn online"}
      className="relative rounded-xl border border-slate-850 p-2.5 text-slate-400 hover:bg-slate-850 hover:text-slate-100">
      <Bell className="h-4 w-4" />
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-slate-950">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
