"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, Unlock } from "lucide-react";
import api from "@/utils/api";
import ShiftModal from "@/components/ShiftModal";

/** Nút mở / chốt ca: mọi khoản thu chi tại quầy cần ca đang mở (tiền vào két của ca). */
export default function ShiftButton() {
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

/** Ca đang mở hay chưa (dùng chung query với ShiftButton). */
export function useShiftOpen() {
  const { data } = useQuery({
    queryKey: ["currentShift"],
    queryFn: async () => (await api.get("/api/v1/shifts/current")).data as { status?: string } | null,
  });
  return data?.status === "open";
}
