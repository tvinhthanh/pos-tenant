"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getCatalog, submitStocktake, qty, vnd, type Goods } from "@/utils/retail";
import { errorText, toast } from "@/components/Toaster";
import { ErrorLine, Field, GoodsPicker, NumberInput, PageHead, inputCls } from "@/components/RetailUi";

type Line = { goods: Goods; counted: number | "" };

export default function RetailStocktakePage() {
  const qc = useQueryClient();
  const { data: catalog = [], refetch } = useQuery({ queryKey: ["retailCatalog"], queryFn: () => getCatalog() });
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  // Quét một món = đếm thêm 1 (đếm bằng máy quét); sửa tay ở ô số đếm
  const add = (g: Goods) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.goods.id === g.id);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, counted: Number(l.counted || 0) + 1 } : l));
      return [{ goods: g, counted: 1 }, ...ls];
    });
  const stockOf = (id: number) => catalog.find((g) => g.id === id)?.stock ?? 0;
  const costOf = (id: number) => catalog.find((g) => g.id === id)?.cost_price ?? null;

  const m = useMutation({
    mutationFn: () => submitStocktake(note.trim(), lines.map((l) => ({ product_id: l.goods.id, counted: Number(l.counted) }))),
    onSuccess: (res) => {
      if (res.changed === 0) toast.success(`${res.code}: khớp sổ, không có chênh lệch`);
      else if (res.applied) toast.success(`${res.code}: đã điều chỉnh ${res.changed} sản phẩm`);
      else toast.success(`${res.code}: lệch ${vnd(res.value)}, đã gửi quản lý duyệt`);
      setLines([]); setNote(""); setErr("");
      qc.invalidateQueries({ queryKey: ["retailCatalog"] });
    },
    onError: (e) => setErr(errorText(e, "Không ghi được phiếu kiểm kê.")),
  });

  const valid = lines.length > 0 && lines.every((l) => l.counted !== "");

  return (
    <div className="space-y-6">
      <PageHead title="Kiểm kê" sub="Đếm một phần hay cả kho đều được. Tồn hệ thống chốt lúc gửi phiếu; lệch lớn cần quản lý duyệt.">
        <button onClick={() => refetch()} className="rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-900">Tải lại tồn</button>
      </PageHead>

      <p className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-400">
        Nên đếm lúc vắng khách. Nếu vẫn bán trong lúc đếm, hàng đã bán sau khi bạn đếm sẽ làm lệch kết quả — hãy đếm lại món đó.
      </p>

      <GoodsPicker catalog={catalog} onPick={add} placeholder="Quét từng món để đếm, hoặc gõ tên" />

      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr><th className="px-4 py-2.5">Sản phẩm</th><th className="px-4 py-2.5 text-right">Hệ thống</th><th className="w-32 px-2 py-2.5 text-right">Đếm được</th><th className="px-4 py-2.5 text-right">Chênh lệch</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {lines.map((l) => {
                const sys = stockOf(l.goods.id);
                const delta = l.counted === "" ? null : Number(l.counted) - sys;
                const cost = costOf(l.goods.id);
                return (
                  <tr key={l.goods.id} className="text-slate-200">
                    <td className="px-4 py-2">{l.goods.name}<span className="ml-2 font-mono text-xs text-slate-500">{l.goods.barcode ?? ""}</span></td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">{qty(sys)} {l.goods.unit}</td>
                    <td className="px-2 py-2">
                      <NumberInput value={l.counted} onChange={(v) => setLines((ls) => ls.map((x) => (x.goods.id === l.goods.id ? { ...x, counted: v } : x)))}
                        aria-label={`Số đếm ${l.goods.name}`} />
                    </td>
                    <td className={`px-4 py-2 text-right font-semibold tabular-nums ${delta == null || delta === 0 ? "text-slate-500" : delta < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                      {delta == null ? "—" : delta === 0 ? "khớp" : `${delta > 0 ? "+" : ""}${qty(delta)}`}
                      {delta ? cost != null && <span className="block text-[11px] font-normal text-slate-500">{vnd(Math.abs(delta) * cost)}</span> : null}
                    </td>
                    <td className="px-2 py-2">
                      <button onClick={() => setLines((ls) => ls.filter((x) => x.goods.id !== l.goods.id))} aria-label={`Bỏ ${l.goods.name}`} className="text-slate-500 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1"><Field label="Ghi chú"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: Kệ đồ uống" className={inputCls} /></Field></div>
        <button onClick={() => { setErr(""); m.mutate(); }} disabled={!valid || m.isPending}
          className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500">
          {m.isPending ? "Đang ghi…" : `Gửi phiếu kiểm kê (${lines.length})`}
        </button>
      </div>
      <ErrorLine text={err} />
    </div>
  );
}
