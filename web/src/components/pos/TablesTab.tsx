"use client";

import React from "react";
import { Ticket } from "lucide-react";

import { orderItemCount } from "@/components/pos/helpers";

interface Props {
  tables: any[];
  areas: any[];
  selectedTableId: number | null;
  /** table_id → đơn nháp đang mở của bàn đó */
  openOrdersByTable: Map<number, any>;
  onSelect: (table: any) => void;
}

/** Tab "Tại bàn": sơ đồ bàn, bàn có đơn đang mở hiện số món. */
export default function TablesTab({ tables, areas, selectedTableId, openOrdersByTable, onSelect }: Props) {
  const showAreaName = areas.length > 1;
  return (
    <div className="flex-1 overflow-hidden flex flex-col bg-slate-900/20 border border-slate-850 rounded-2xl p-4 md:p-6">
      <h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center">
        <Ticket className="w-4.5 h-4.5 text-indigo-400 mr-1.5" />
        Sơ đồ bàn (Gọi món tại bàn)
      </h3>
      <div className="flex-1 overflow-y-auto pr-1 grid auto-rows-max content-start grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {tables.map((table: any) => (
          <button
            type="button"
            key={table.id}
            onClick={() => onSelect(table)}
            className={`relative group bg-slate-950 border ${
              selectedTableId === table.id
                ? "border-indigo-500 shadow-lg shadow-indigo-500/20"
                : "border-slate-800 hover:border-indigo-500/50"
            } p-6 rounded-2xl flex flex-col items-center justify-center transition-all`}
          >
            {openOrdersByTable.has(table.id) && (
              <span className="absolute right-2 top-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-slate-950">
                {orderItemCount(openOrdersByTable.get(table.id))} món
              </span>
            )}
            <span className="font-bold text-slate-300">{table.name}</span>
            {showAreaName && (
              <span className="text-xs text-slate-500 mt-1">{areas.find((a: any) => a.id === table.area_id)?.name}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
