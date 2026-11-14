"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "@/utils/api";
import { Lock, Play, ShieldAlert } from "lucide-react";
import ShiftModal from "./ShiftModal";

interface ShiftGuardProps {
  children: React.ReactNode;
}

export default function ShiftGuard({ children }: ShiftGuardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Fetch current open shift
  const { data: currentShift, isLoading, error } = useQuery({
    queryKey: ["currentShift"],
    queryFn: async () => {
      const res = await api.get("/api/v1/shifts/current");
      return res.data;
    }
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-12rem)] space-y-4">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500"></div>
        <p className="text-sm text-slate-400 font-semibold">Đang kiểm tra ca làm việc...</p>
      </div>
    );
  }

  // If shift is open, allow usage
  if (currentShift && currentShift.status === "open") {
    return <>{children}</>;
  }

  // Otherwise, display the lock screen gating the POS page
  return (
    <div className="relative min-h-[calc(100vh-12rem)] w-full flex items-center justify-center p-4">
      {/* Blurred background preview of POS */}
      <div className="absolute inset-0 select-none pointer-events-none opacity-10 filter blur-md">
        <div className="w-full h-full bg-slate-950 flex flex-col p-8">
          <div className="w-full h-12 bg-slate-800 rounded-xl mb-6"></div>
          <div className="flex flex-1 gap-6">
            <div className="flex-1 grid grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-slate-800 rounded-2xl h-44"></div>
              ))}
            </div>
            <div className="w-80 bg-slate-800 rounded-2xl h-full"></div>
          </div>
        </div>
      </div>

      {/* Lock Guard Box */}
      <div className="relative z-10 w-full max-w-lg glass-panel p-8 rounded-3xl border border-slate-800/80 text-center flex flex-col items-center space-y-6 shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-amber-500 shadow-lg shadow-amber-500/5">
          <Lock className="w-8 h-8" />
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-bold text-slate-100 tracking-tight">Ca làm việc đang khóa</h2>
          <p className="text-sm text-slate-400 max-w-sm mx-auto leading-relaxed">
            Hệ thống yêu cầu nhân viên phải mở ca làm việc và khai báo số tiền két ban đầu trước khi bắt đầu thanh toán đơn hàng.
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="px-6 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl transition-all shadow-lg shadow-indigo-600/20 active:scale-95 text-sm flex items-center space-x-2"
        >
          <Play className="w-4 h-4 fill-white" />
          <span>Mở ca ngay bây giờ</span>
        </button>

        <ShiftModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
      </div>
    </div>
  );
}
