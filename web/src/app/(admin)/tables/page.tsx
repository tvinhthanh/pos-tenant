"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/utils/api";
import { Map, Plus, SquareSquare, Grid, MoreVertical } from "lucide-react";

export default function TablesPage() {
  const queryClient = useQueryClient();
  const [newAreaName, setNewAreaName] = useState("");
  const [newTableName, setNewTableName] = useState("");

  const { data: areas = [] } = useQuery({
    queryKey: ["areas"],
    queryFn: async () => {
      const res = await api.get("/api/v1/tables/areas");
      return res.data;
    }
  });

  // Khu vực đang xem: người dùng chọn, mặc định khu vực đầu tiên (không bắt chọn tay)
  const [pickedAreaId, setSelectedAreaId] = useState<number | null>(null);
  const activeAreaId: number | null =
    pickedAreaId && areas.some((a: any) => a.id === pickedAreaId) ? pickedAreaId : areas[0]?.id ?? null;

  const { data: tables = [] } = useQuery({
    queryKey: ["tables"],
    queryFn: async () => {
      const res = await api.get("/api/v1/tables/tables");
      return res.data;
    }
  });

  const createAreaMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post("/api/v1/tables/areas", { name: newAreaName });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      setNewAreaName("");
    }
  });

  const createTableMutation = useMutation({
    mutationFn: async () => {
      if (!activeAreaId) return;
      const res = await api.post("/api/v1/tables/tables", { name: newTableName, area_id: activeAreaId });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tables"] });
      setNewTableName("");
    }
  });

  return (
    <div className="space-y-8">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-slate-100 flex items-center">
              <Map className="w-8 h-8 mr-3 text-emerald-400" />
              Sơ đồ Khu vực & Bàn
            </h1>
            <p className="text-slate-400 mt-1">
              Quản lý danh sách khu vực và các bàn để phục vụ "Treo đơn / Gọi món".
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Areas Sidebar */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
              <h2 className="text-lg font-bold text-slate-200 mb-4 flex items-center">
                <Grid className="w-5 h-5 mr-2 text-indigo-400" />
                Khu vực
              </h2>
              
              <div className="space-y-2 mb-6">
                {areas.map((area: any) => (
                  <button
                    key={area.id}
                    onClick={() => setSelectedAreaId(area.id)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-semibold transition-all ${
                      activeAreaId === area.id 
                        ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20" 
                        : "bg-slate-950/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-slate-800"
                    }`}
                  >
                    <span>{area.name}</span>
                    <span className="bg-slate-950/50 text-xs px-2 py-0.5 rounded-full text-slate-300">
                      {tables.filter((t: any) => t.area_id === area.id).length} bàn
                    </span>
                  </button>
                ))}
              </div>

              <div className="pt-4 border-t border-slate-800">
                <div className="flex space-x-2">
                  <input
                    type="text"
                    value={newAreaName}
                    onChange={(e) => setNewAreaName(e.target.value)}
                    placeholder="Tên khu vực mới..."
                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                  <button 
                    onClick={() => createAreaMutation.mutate()}
                    disabled={!newAreaName.trim()}
                    aria-label="Thêm khu vực"
                    className="shrink-0 p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl disabled:opacity-40 transition-colors"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Tables Grid */}
          <div className="lg:col-span-3 space-y-6">
            {activeAreaId ? (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl min-h-[500px]">
                <div className="flex justify-between items-center mb-6 pb-4 border-b border-slate-800">
                  <h2 className="text-xl font-bold text-slate-200">
                    Danh sách Bàn - {areas.find((a: any) => a.id === activeAreaId)?.name}
                  </h2>
                  <div className="flex space-x-2">
                    <input
                      type="text"
                      value={newTableName}
                      onChange={(e) => setNewTableName(e.target.value)}
                      placeholder="Tên bàn (VD: Bàn 1)..."
                      className="w-48 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                    <button 
                      onClick={() => createTableMutation.mutate()}
                      disabled={!newTableName.trim()}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl disabled:bg-slate-800 transition-colors flex items-center text-sm"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Thêm bàn
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {tables.filter((t: any) => t.area_id === activeAreaId).map((table: any) => (
                    <div key={table.id} className="relative group bg-slate-950 border border-slate-800 hover:border-indigo-500/50 p-6 rounded-2xl flex flex-col items-center justify-center transition-all cursor-pointer">
                      <SquareSquare className="w-10 h-10 text-slate-600 group-hover:text-indigo-400 mb-3 transition-colors" />
                      <span className="font-bold text-slate-300">{table.name}</span>
                      <button className="absolute top-2 right-2 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity">
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  {tables.filter((t: any) => t.area_id === activeAreaId).length === 0 && (
                    <div className="col-span-full py-12 text-center text-slate-500 border-2 border-dashed border-slate-800 rounded-2xl">
                      Khu vực này chưa có bàn nào.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 shadow-xl flex flex-col items-center justify-center text-center h-[500px]">
                <Map className="w-16 h-16 text-slate-700 mb-4" />
                <h3 className="text-xl font-bold text-slate-300">Chưa chọn khu vực</h3>
                <p className="text-slate-500 max-w-sm mt-2">
                  Vui lòng chọn một khu vực ở menu bên trái để xem danh sách bàn, hoặc tạo khu vực mới nếu chưa có.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
  );
}
