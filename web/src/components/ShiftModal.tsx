"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/utils/api";
import { AlertCircle, Calendar, DollarSign, FileText, Lock, Unlock, X } from "lucide-react";

interface ShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function ShiftModal({ isOpen, onClose }: ShiftModalProps) {
  const queryClient = useQueryClient();
  const [openingBalance, setOpeningBalance] = useState<number>(100000);
  const [closingBalance, setClosingBalance] = useState<number>(0);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  // 1. Fetch current open shift
  const { data: currentShift, isLoading } = useQuery({
    queryKey: ["currentShift"],
    queryFn: async () => {
      const res = await api.get("/api/v1/shifts/current");
      return res.data;
    },
    enabled: isOpen
  });

  // 2. Open shift mutation
  const openShiftMutation = useMutation({
    mutationFn: async () => {
      setError("");
      const res = await api.post("/api/v1/shifts/open", {
        opening_balance: openingBalance,
        notes: notes || "Mở ca làm việc"
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["currentShift"] });
      onClose();
      // Reload page state
      window.location.reload();
    },
    onError: (err: any) => {
      setError(err.response?.data?.detail || "Không thể mở ca làm việc.");
    }
  });

  // 3. Close shift mutation
  const closeShiftMutation = useMutation({
    mutationFn: async () => {
      setError("");
      const res = await api.post("/api/v1/shifts/close", {
        closing_balance: closingBalance,
        notes: notes || "Đóng ca làm việc"
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["currentShift"] });
      onClose();
      window.location.reload();
    },
    onError: (err: any) => {
      setError(err.response?.data?.detail || "Không thể đóng ca làm việc.");
    }
  });

  if (!isOpen) return null;

  const handleOpenShiftSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    openShiftMutation.mutate();
  };

  const handleCloseShiftSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    closeShiftMutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center space-x-2">
            {currentShift ? (
              <>
                <Lock className="w-5 h-5 text-amber-500" />
                <span className="font-bold text-slate-200">Đóng ca làm việc</span>
              </>
            ) : (
              <>
                <Unlock className="w-5 h-5 text-emerald-500" />
                <span className="font-bold text-slate-200">Mở ca làm việc mới</span>
              </>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
              <span className="text-xs text-slate-500">Đang tải thông tin ca...</span>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 p-4 bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs rounded-xl flex items-start space-x-2">
                  <AlertCircle className="w-4.5 h-4.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {currentShift ? (
                /* Close Shift Form */
                <form onSubmit={handleCloseShiftSubmit} className="space-y-4">
                  <div className="p-4 bg-slate-950/60 border border-slate-800/80 rounded-xl space-y-3">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Mã ca làm việc:</span>
                      <span className="text-slate-200 font-semibold">#{currentShift.id}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Giờ mở ca:</span>
                      <span className="text-slate-200 font-semibold">
                        {new Date(currentShift.opened_at).toLocaleString("vi-VN")}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Tiền quỹ đầu ca:</span>
                      <span className="text-emerald-400 font-bold">
                        {currentShift.opening_balance.toLocaleString("vi-VN")}đ
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Doanh số bán lẻ:</span>
                      <span className="text-indigo-400 font-bold">
                        {currentShift.total_sales.toLocaleString("vi-VN")}đ
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Số đơn đã bán:</span>
                      <span className="text-indigo-400 font-bold">
                        {currentShift.total_orders} đơn
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-400 flex items-center">
                      <DollarSign className="w-3.5 h-3.5 mr-1 text-slate-500" />
                      Tiền két thực tế đếm được cuối ca (VND)
                    </label>
                    <input
                      type="number"
                      value={closingBalance}
                      onChange={(e) => setClosingBalance(parseInt(e.target.value) || 0)}
                      className="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-700 focus:outline-none focus:border-indigo-500 font-mono"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-400 flex items-center">
                      <FileText className="w-3.5 h-3.5 mr-1 text-slate-500" />
                      Ghi chú đóng ca (chênh lệch két, lý do...)
                    </label>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Nhập ghi chú nếu có chênh lệch..."
                      className="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-700 focus:outline-none focus:border-indigo-500 h-20 resize-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={closeShiftMutation.isPending}
                    className="w-full py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-amber-600/10 hover:shadow-amber-500/20 text-sm flex items-center justify-center"
                  >
                    {closeShiftMutation.isPending ? (
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    ) : (
                      "Chốt sổ & Đóng ca"
                    )}
                  </button>
                </form>
              ) : (
                /* Open Shift Form */
                <form onSubmit={handleOpenShiftSubmit} className="space-y-4">
                  <div className="p-4 bg-slate-950/60 border border-slate-850 rounded-xl flex items-center space-x-3">
                    <div className="p-2.5 bg-indigo-500/10 rounded-lg text-indigo-400">
                      <Calendar className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-xs text-slate-500 block">Thời gian mở ca</span>
                      <span className="text-xs text-slate-200 font-bold">
                        {new Date().toLocaleString("vi-VN")}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-400 flex items-center">
                      <DollarSign className="w-3.5 h-3.5 mr-1 text-slate-500" />
                      Nhập số tiền mặt đầu ca đếm được (VND)
                    </label>
                    <input
                      type="number"
                      value={openingBalance}
                      onChange={(e) => setOpeningBalance(parseInt(e.target.value) || 0)}
                      className="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-700 focus:outline-none focus:border-indigo-500 font-mono"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-400 flex items-center">
                      <FileText className="w-3.5 h-3.5 mr-1 text-slate-500" />
                      Ghi chú ca làm việc
                    </label>
                    <input
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Ví dụ: Ca sáng - Nhân viên A"
                      className="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-700 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={openShiftMutation.isPending}
                    className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-emerald-600/10 hover:shadow-emerald-500/20 text-sm flex items-center justify-center"
                  >
                    {openShiftMutation.isPending ? (
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    ) : (
                      "Bắt đầu ca làm việc"
                    )}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
