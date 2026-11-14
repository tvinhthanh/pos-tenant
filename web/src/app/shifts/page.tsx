"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "@/utils/api";
import { paymentMethodLabel } from "@/utils/enums";
import { History, Search, ArrowRight, DollarSign, Calendar, Eye, X } from "lucide-react";

export default function ShiftsPage() {
  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ["shifts"],
    queryFn: async () => {
      const res = await api.get("/api/v1/shifts");
      return res.data;
    }
  });

  const [selectedShift, setSelectedShift] = useState<number | null>(null);
  
  const { data: reconciliation, isLoading: isLoadingReconciliation } = useQuery({
    queryKey: ["reconciliation", selectedShift],
    queryFn: async () => {
      if (!selectedShift) return null;
      const res = await api.get(`/api/v1/shifts/${selectedShift}/reconciliation`);
      return res.data;
    },
    enabled: !!selectedShift
  });

  return (
    <>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-slate-100 flex items-center">
              <History className="w-8 h-8 mr-3 text-indigo-400" />
              Lịch sử Ca làm việc
            </h1>
            <p className="text-slate-400 mt-1">
              Xem lại danh sách 30 ca làm việc gần nhất của chi nhánh.
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-950/50 border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-6 py-4 font-semibold">Ca ID / Trạng thái</th>
                  <th className="px-6 py-4 font-semibold">Thời gian (Mở - Đóng)</th>
                  <th className="px-6 py-4 font-semibold">Doanh số (VNĐ)</th>
                  <th className="px-6 py-4 font-semibold">Tiền Đóng Ca (VNĐ)</th>
                  <th className="px-6 py-4 font-semibold">Chênh lệch</th>
                  <th className="px-6 py-4 font-semibold">Ghi chú</th>
                  <th className="px-6 py-4 font-semibold text-center">Hành động</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      <div className="flex justify-center mb-2">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
                      </div>
                      Đang tải dữ liệu...
                    </td>
                  </tr>
                ) : shifts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      Chưa có ca làm việc nào.
                    </td>
                  </tr>
                ) : (
                  shifts.map((s: any) => {
                    const discrepancy = (s.closing_balance || 0) - (s.expected_balance || 0);
                    const isClosed = s.status === "closed";
                    
                    return (
                      <tr key={s.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-semibold text-slate-200">#{s.id}</div>
                          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold mt-1 uppercase ${
                            isClosed ? "bg-slate-800 text-slate-400" : "bg-emerald-500/20 text-emerald-400"
                          }`}>
                            {isClosed ? "Đã đóng" : "Đang mở"}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-300">
                          <div className="flex items-center space-x-2">
                            <span className="text-slate-400 text-xs">Mở:</span>
                            <span>{new Date(s.opened_at).toLocaleString('vi-VN')}</span>
                          </div>
                          {isClosed && (
                            <div className="flex items-center space-x-2 mt-1">
                              <span className="text-slate-400 text-xs">Đóng:</span>
                              <span>{new Date(s.closed_at).toLocaleString('vi-VN')}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-indigo-400 font-bold">
                          {s.total_sales?.toLocaleString('vi-VN')}
                        </td>
                        <td className="px-6 py-4 text-sm text-emerald-400 font-bold">
                          {isClosed ? s.closing_balance?.toLocaleString('vi-VN') : "---"}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          {isClosed ? (
                            <span className={`font-bold ${
                              discrepancy > 0 ? "text-emerald-500" : discrepancy < 0 ? "text-rose-500" : "text-slate-400"
                            }`}>
                              {discrepancy > 0 ? "+" : ""}{discrepancy.toLocaleString('vi-VN')}
                            </span>
                          ) : (
                            <span className="text-slate-600">---</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-400 max-w-xs truncate">
                          {s.notes || "-"}
                        </td>
                        <td className="px-6 py-4 text-sm text-center">
                          {isClosed && (
                            <button
                              onClick={() => setSelectedShift(s.id)}
                              className="text-indigo-400 hover:text-indigo-300 flex items-center justify-center mx-auto"
                            >
                              <Eye className="w-5 h-5 mr-1" />
                              Chi tiết
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Modal Đối chiếu quỹ */}
      {selectedShift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-2xl shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-100 flex items-center">
                <DollarSign className="w-6 h-6 mr-2 text-emerald-400" />
                Đối chiếu dòng tiền - Ca #{selectedShift}
              </h2>
              <button onClick={() => setSelectedShift(null)} className="text-slate-400 hover:text-slate-200">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            {isLoadingReconciliation ? (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
              </div>
            ) : reconciliation ? (
              <div className="space-y-6">
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                    <p className="text-sm text-slate-400 mb-1">Hệ thống ghi nhận</p>
                    <p className="text-xl font-bold text-indigo-400">{Number(reconciliation.total_expected || 0).toLocaleString('vi-VN')} đ</p>
                  </div>
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                    <p className="text-sm text-slate-400 mb-1">Thực tế kết ca</p>
                    <p className="text-xl font-bold text-emerald-400">{Number(reconciliation.total_actual || 0).toLocaleString('vi-VN')} đ</p>
                  </div>
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                    <p className="text-sm text-slate-400 mb-1">Chênh lệch</p>
                    <p className={`text-xl font-bold ${Number(reconciliation.total_discrepancy || 0) >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                      {Number(reconciliation.total_discrepancy) > 0 ? "+" : ""}{Number(reconciliation.total_discrepancy || 0).toLocaleString('vi-VN')} đ
                    </p>
                  </div>
                </div>
                
                <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-2">Chi tiết theo phương thức thanh toán</h3>
                <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="bg-slate-900 border-b border-slate-800 text-slate-400">
                        <th className="px-4 py-3 font-medium">Phương thức</th>
                        <th className="px-4 py-3 font-medium text-right">Hệ thống (đ)</th>
                        <th className="px-4 py-3 font-medium text-right">Thực tế (đ)</th>
                        <th className="px-4 py-3 font-medium text-right">Chênh lệch (đ)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {(reconciliation.details || []).map((d: any, idx: number) => (
                        <tr key={idx} className="text-slate-300">
                          <td className="px-4 py-3 font-medium">
                            {paymentMethodLabel(d.method)}
                            {!d.counted && (
                              <span className="ml-2 text-[10px] text-slate-500 font-normal">(không đếm được)</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">{Number(d.expected_amount || 0).toLocaleString('vi-VN')}</td>
                          <td className="px-4 py-3 text-right">
                            {d.counted ? Number(d.actual_amount || 0).toLocaleString('vi-VN') : "—"}
                          </td>
                          <td className={`px-4 py-3 text-right font-bold ${Number(d.discrepancy || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {d.counted
                              ? `${Number(d.discrepancy) > 0 ? "+" : ""}${Number(d.discrepancy || 0).toLocaleString('vi-VN')}`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="text-center text-slate-400 py-12">Không thể tải dữ liệu đối chiếu.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
