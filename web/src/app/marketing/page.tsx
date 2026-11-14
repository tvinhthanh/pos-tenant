"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/utils/api";
import { Megaphone, Plus, Percent, Users, Calendar, Target, RefreshCw } from "lucide-react";
import { toast } from "@/components/Toaster";

export default function MarketingPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [targetTier, setTargetTier] = useState("");

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: async () => {
      const res = await api.get("/api/v1/marketing/campaigns");
      return res.data;
    }
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post("/api/v1/marketing/campaigns", {
        name,
        start_date: new Date(startDate).toISOString(),
        end_date: new Date(endDate).toISOString(),
        discount_percent: parseInt(discountPercent),
        target_tier: targetTier || null,
        is_active: true
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      setName("");
      setStartDate("");
      setEndDate("");
      setDiscountPercent("");
      setTargetTier("");
    }
  });

  const recalculateMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post("/api/v1/marketing/customers/recalculate-tiers");
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success(data?.message || "Đã cập nhật hạng khách hàng.");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Không cập nhật được hạng khách hàng.");
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
              <Megaphone className="w-8 h-8 mr-3 text-indigo-400" />
              Chiến dịch Marketing & Loyalty
            </h1>
            <p className="text-slate-400 mt-1">
              Quản lý khuyến mãi theo sự kiện và xếp hạng khách hàng thân thiết.
            </p>
          </div>
          <button 
            onClick={() => recalculateMutation.mutate()}
            disabled={recalculateMutation.isPending}
            className="flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold rounded-xl transition-all shadow"
          >
            <RefreshCw className={`w-5 h-5 mr-2 ${recalculateMutation.isPending ? "animate-spin" : ""}`} />
            Cập nhật lại Hạng Khách Hàng
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Create Form */}
          <div className="lg:col-span-1">
            <form onSubmit={handleSubmit} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <h2 className="text-lg font-bold text-slate-200 mb-4 flex items-center">
                <Plus className="w-5 h-5 mr-2 text-indigo-400" />
                Tạo Chiến Dịch Mới
              </h2>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Tên chiến dịch</label>
                <input 
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Vd: Khuyến mãi sinh nhật 5 năm"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Ngày bắt đầu</label>
                  <input 
                    type="datetime-local"
                    required
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Ngày kết thúc</label>
                  <input 
                    type="datetime-local"
                    required
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Phần trăm giảm (%)</label>
                <div className="relative">
                  <Percent className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                  <input 
                    type="number"
                    min="0"
                    max="100"
                    required
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                    placeholder="20"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Áp dụng cho hạng</label>
                <div className="relative">
                  <Target className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                  <select 
                    value={targetTier}
                    onChange={(e) => setTargetTier(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 focus:outline-none focus:border-indigo-500 appearance-none"
                  >
                    <option value="">Tất cả khách hàng (Public)</option>
                    <option value="Đồng">Từ hạng Đồng trở lên</option>
                    <option value="Bạc">Từ hạng Bạc trở lên</option>
                    <option value="Vàng">Chỉ khách hàng hạng Vàng</option>
                  </select>
                </div>
              </div>

              <button 
                type="submit"
                disabled={createMutation.isPending}
                className="w-full mt-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white font-bold rounded-xl transition-all shadow text-sm"
              >
                Kích hoạt Chiến dịch
              </button>
            </form>
          </div>

          {/* List Area */}
          <div className="lg:col-span-2">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl h-full">
              <h2 className="text-lg font-bold text-slate-200 mb-4 flex items-center">
                <Calendar className="w-5 h-5 mr-2 text-indigo-400" />
                Danh sách Chiến dịch
              </h2>
              
              {isLoading ? (
                <div className="flex justify-center items-center h-48 text-slate-500">Đang tải...</div>
              ) : campaigns.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 border-2 border-dashed border-slate-800 rounded-xl text-slate-500">
                  <Megaphone className="w-8 h-8 mb-2 opacity-50" />
                  <p>Chưa có chiến dịch nào.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {campaigns.map((c: any) => {
                    const isRunning = new Date(c.start_date) <= new Date() && new Date(c.end_date) >= new Date();
                    const isEnded = new Date(c.end_date) < new Date();
                    
                    return (
                      <div key={c.id} className="flex justify-between items-center bg-slate-950 border border-slate-800 p-4 rounded-xl">
                        <div>
                          <div className="flex items-center space-x-3 mb-1">
                            <h3 className="font-bold text-slate-200">{c.name}</h3>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              isRunning ? "bg-emerald-500/20 text-emerald-400" : 
                              isEnded ? "bg-slate-800 text-slate-400" : "bg-amber-500/20 text-amber-400"
                            }`}>
                              {isRunning ? "Đang chạy" : isEnded ? "Đã kết thúc" : "Sắp tới"}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 flex items-center mt-2">
                            <Calendar className="w-3 h-3 mr-1" />
                            {new Date(c.start_date).toLocaleString('vi-VN')} - {new Date(c.end_date).toLocaleString('vi-VN')}
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-xl font-black text-indigo-400">-{c.discount_percent}%</div>
                          <div className="text-xs text-slate-500 font-medium mt-1 flex items-center justify-end">
                            <Users className="w-3 h-3 mr-1" />
                            {c.target_tier ? `Hạng ${c.target_tier}` : "Tất cả KH"}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}
