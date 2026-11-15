"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/utils/api";
import { Scale, Plus, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { toast } from "@/components/Toaster";

export default function AdjustmentsPage() {
  const queryClient = useQueryClient();
  const [ingredientId, setIngredientId] = useState("");
  const [quantityDelta, setQuantityDelta] = useState("");
  const [type, setType] = useState("DAMAGED");
  const [reason, setReason] = useState("");

  const { data: adjustments = [] } = useQuery({
    queryKey: ["adjustments"],
    queryFn: async () => {
      const res = await api.get("/api/v1/adjustments");
      return res.data;
    }
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ["ingredients"],
    queryFn: async () => {
      const res = await api.get("/api/v1/inventory/ingredients");
      return res.data;
    }
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post("/api/v1/adjustments", {
        ingredient_id: parseInt(ingredientId),
        quantity_delta: parseFloat(quantityDelta) || 0,
        type,
        reason
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adjustments"] });
      setIngredientId("");
      setQuantityDelta("");
      setReason("");
    }
  });

  const approveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await api.post(`/api/v1/adjustments/${id}/approve`);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["ingredients"] });
      toast.success("Đã duyệt phiếu điều chỉnh kho!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Duyệt thất bại");
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate();
  };

  return (
    <div className="space-y-6">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-slate-100 flex items-center">
              <Scale className="w-8 h-8 mr-3 text-indigo-400" />
              Phiếu điều chỉnh kho (Hao hụt)
            </h1>
            <p className="text-slate-400 mt-1">
              Báo cáo hỏng, mất mát nguyên liệu và yêu cầu quản lý duyệt để khớp tồn kho thực tế.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Create Form */}
          <div className="lg:col-span-1">
            <form onSubmit={handleSubmit} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <h2 className="text-lg font-bold text-slate-200 mb-4 flex items-center">
                <Plus className="w-5 h-5 mr-2 text-indigo-400" />
                Tạo phiếu mới
              </h2>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Nguyên liệu</label>
                <select 
                  value={ingredientId}
                  onChange={(e) => setIngredientId(e.target.value)}
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- Chọn nguyên liệu --</option>
                  {ingredients.map((ing: any) => (
                    <option key={ing.id} value={ing.id}>{ing.name} (Tồn: {ing.stock} {ing.unit})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Thay đổi số lượng (Âm/Dương)</label>
                <input 
                  type="number"
                  step="0.01"
                  required
                  value={quantityDelta}
                  onChange={(e) => setQuantityDelta(e.target.value)}
                  placeholder="-100 hoặc +50"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Loại điều chỉnh</label>
                <select 
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="DAMAGED">Hư hỏng (DAMAGED)</option>
                  <option value="EXPIRED">Hết hạn (EXPIRED)</option>
                  <option value="LOSS">Thất thoát (LOSS)</option>
                  <option value="FOUND">Kiểm dư (FOUND)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Lý do chi tiết</label>
                <textarea 
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500 h-24"
                  placeholder="Ví dụ: Rơi vỡ ly, chuột cắn bao bì..."
                />
              </div>

              <button 
                type="submit"
                disabled={createMutation.isPending}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white font-bold rounded-xl transition-all shadow text-sm"
              >
                Gửi yêu cầu duyệt
              </button>
            </form>
          </div>

          {/* List Area */}
          <div className="lg:col-span-2">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-950/50 border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                      <th className="px-6 py-4 font-semibold">Mã phiếu</th>
                      <th className="px-6 py-4 font-semibold">Ngày tạo</th>
                      <th className="px-6 py-4 font-semibold">Nguyên liệu</th>
                      <th className="px-6 py-4 font-semibold">Số lượng +/-</th>
                      <th className="px-6 py-4 font-semibold">Trạng thái</th>
                      <th className="px-6 py-4 font-semibold text-center">Hành động</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {adjustments.map((adj: any) => {
                      const ing = ingredients.find((i: any) => i.id === adj.ingredient_id);
                      return (
                        <tr key={adj.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-6 py-4 font-mono font-semibold text-slate-300">#{adj.id}</td>
                          <td className="px-6 py-4 text-slate-400">{new Date(adj.created_at).toLocaleString('vi-VN')}</td>
                          <td className="px-6 py-4 font-semibold text-indigo-400">{ing?.name || `ID: ${adj.ingredient_id}`}</td>
                          <td className="px-6 py-4 font-bold">
                            <span className={adj.quantity_delta > 0 ? "text-emerald-400" : "text-rose-400"}>
                              {adj.quantity_delta > 0 ? "+" : ""}{adj.quantity_delta} {ing?.unit}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              adj.status === "APPROVED" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"
                            }`}>
                              {adj.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-center">
                            {adj.status === "PENDING" ? (
                              <button
                                onClick={() => approveMutation.mutate(adj.id)}
                                className="px-3 py-1 bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600 hover:text-white rounded-lg text-xs font-bold transition-colors"
                              >
                                Duyệt ngay
                              </button>
                            ) : (
                              <CheckCircle className="w-5 h-5 text-emerald-500 mx-auto" />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {adjustments.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                          Chưa có phiếu điều chỉnh nào.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
  );
}
