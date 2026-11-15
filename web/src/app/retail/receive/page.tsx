"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getCatalog, listSuppliers, receiveGoods, vnd, qty, PAY_METHOD_LABELS, type Goods, type PayMethod } from "@/utils/retail";
import { errorText, toast } from "@/components/Toaster";
import { ErrorLine, Field, GoodsPicker, NumberInput, PageHead, inputCls } from "@/components/RetailUi";

type Line = { goods: Goods; quantity: number | ""; unit_cost: number | "" };

export default function RetailReceivePage() {
  const qc = useQueryClient();
  const { data: catalog = [] } = useQuery({ queryKey: ["retailCatalog"], queryFn: () => getCatalog() });
  const { data: suppliers = [] } = useQuery({ queryKey: ["retailSuppliers"], queryFn: listSuppliers });
  const [lines, setLines] = useState<Line[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [paid, setPaid] = useState<number | "">("");
  const [method, setMethod] = useState<PayMethod>("cash");
  const [err, setErr] = useState("");

  const add = (g: Goods) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.goods.id === g.id);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, quantity: Number(l.quantity || 0) + 1 } : l));
      return [...ls, { goods: g, quantity: 1, unit_cost: g.cost_price ?? "" }];
    });
  const patch = (id: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.goods.id === id ? { ...l, ...p } : l)));

  const total = lines.reduce((s, l) => s + Math.round(Number(l.quantity || 0) * Number(l.unit_cost || 0)), 0);
  const paidNum = paid === "" ? total : Number(paid);
  const debt = total - paidNum;
  const valid = lines.length > 0 && lines.every((l) => Number(l.quantity) > 0 && l.unit_cost !== "")
    && paidNum >= 0 && paidNum <= total && (debt === 0 || supplierId !== "");

  const m = useMutation({
    mutationFn: () => receiveGoods({
      supplier_id: supplierId === "" ? null : supplierId,
      items: lines.map((l) => ({ stock_item_id: l.goods.stock_item_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost) })),
      paid_amount: paidNum,
      payment_method: method,
    }),
    onSuccess: (res) => {
      toast.success(`Đã nhập phiếu #${res.import_id} · ${vnd(res.total_amount)}`);
      setLines([]); setPaid(""); setErr("");
      qc.invalidateQueries({ queryKey: ["retailCatalog"] });
      qc.invalidateQueries({ queryKey: ["retailSuppliers"] });
    },
    onError: (e) => setErr(errorText(e, "Không nhập được hàng.")),
  });

  return (
    <div className="space-y-6">
      <PageHead title="Nhập hàng" sub="Tồn kho cộng ngay; giá vốn bình quân tính lại theo giá nhập. Trả thiếu thì ghi công nợ nhà cung cấp." />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="space-y-4">
          <GoodsPicker catalog={catalog} onPick={add} />
          {lines.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
              Quét từng mã trên phiếu giao hàng. Quét lại cùng mã để cộng số lượng.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-800">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
                  <tr><th className="px-4 py-2.5">Sản phẩm</th><th className="w-28 px-2 py-2.5 text-right">Số lượng</th><th className="w-36 px-2 py-2.5 text-right">Giá nhập</th><th className="px-4 py-2.5 text-right">Thành tiền</th><th /></tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {lines.map((l) => (
                    <tr key={l.goods.id} className="text-slate-200">
                      <td className="px-4 py-2">
                        {l.goods.name}
                        <span className="block text-xs text-slate-500">tồn {qty(l.goods.stock)} {l.goods.unit}{l.goods.cost_price != null ? ` · vốn ${vnd(l.goods.cost_price)}` : ""}</span>
                      </td>
                      <td className="px-2 py-2"><NumberInput value={l.quantity} onChange={(v) => patch(l.goods.id, { quantity: v })} aria-label={`Số lượng ${l.goods.name}`} /></td>
                      <td className="px-2 py-2"><NumberInput value={l.unit_cost} onChange={(v) => patch(l.goods.id, { unit_cost: v })} aria-label={`Giá nhập ${l.goods.name}`} /></td>
                      <td className="px-4 py-2 text-right tabular-nums">{vnd(Number(l.quantity || 0) * Number(l.unit_cost || 0))}</td>
                      <td className="px-2 py-2">
                        <button onClick={() => setLines((ls) => ls.filter((x) => x.goods.id !== l.goods.id))} aria-label={`Bỏ ${l.goods.name}`} className="text-slate-500 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <Field label="Nhà cung cấp" hint={suppliers.length === 0 ? "Thêm nhà cung cấp ở màn Công nợ & NCC" : undefined}>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value === "" ? "" : Number(e.target.value))} className={inputCls}>
              <option value="">— Không ghi nhà cung cấp —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.total_debt > 0 ? ` (nợ ${vnd(s.total_debt)})` : ""}</option>)}
            </select>
          </Field>
          <div className="flex justify-between text-lg font-bold text-slate-100"><span>Tổng phiếu</span><span className="tabular-nums">{vnd(total)}</span></div>
          <Field label="Đã trả" hint="Để trống = trả đủ">
            <NumberInput value={paid} onChange={setPaid} placeholder={String(total)} />
          </Field>
          {paidNum > 0 && (
            <Field label="Trả bằng">
              <select value={method} onChange={(e) => setMethod(e.target.value as PayMethod)} className={inputCls}>
                {(["cash", "bank_transfer", "card"] as PayMethod[]).map((m) => <option key={m} value={m}>{PAY_METHOD_LABELS[m]}</option>)}
              </select>
            </Field>
          )}
          {debt > 0 && (
            <p className={`text-sm ${supplierId === "" ? "text-rose-500" : "text-amber-600"}`}>
              {supplierId === "" ? "Trả thiếu phải chọn nhà cung cấp để ghi công nợ." : `Ghi nợ nhà cung cấp ${vnd(debt)}`}
            </p>
          )}
          {paidNum > total && <p className="text-sm text-rose-500">Số đã trả lớn hơn tổng phiếu.</p>}
          <ErrorLine text={err} />
          <button onClick={() => { setErr(""); m.mutate(); }} disabled={!valid || m.isPending}
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500">
            {m.isPending ? "Đang nhập…" : "Nhập kho"}
          </button>
        </aside>
      </div>
    </div>
  );
}
