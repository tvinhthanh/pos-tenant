"use client";

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ChevronRight, Gift, PieChart, UtensilsCrossed, Layers } from "lucide-react";

import api from "@/utils/api";

interface ProductRow { product_name: string; category: string; quantity: number; revenue: number; cost: number; orders: number }
interface CategoryRow { category: string; quantity: number; revenue: number }
interface OptionRow { group_name: string; option_name: string; quantity: number; extra_revenue: number }
interface ProductOptionRow extends OptionRow { product_name: string }
interface DayRow {
  day: string; orders: number; revenue: number; discount: number; quantity: number;
  top_product: string | null; top_quantity: number;
}
interface CompRow {
  sold_at: string; order_id: number; product_name: string; options: string;
  quantity: number; value: number; reason: string; given_by: string;
}
interface Breakdown {
  totals: { orders: number; quantity: number; revenue: number; cost: number; comp_quantity: number; comp_value: number };
  comps: CompRow[];
  products: ProductRow[];
  categories: CategoryRow[];
  options: OptionRow[];
  product_options: ProductOptionRow[];
  days: DayRow[];
}

type Tab = "days" | "products" | "options" | "categories" | "comps";

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
/** "2026-11-09" → { weekday: "T2", date: "09/11" } — không qua Date(UTC) để không lệch ngày. */
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return { weekday: WEEKDAYS[wd], date: `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`, isWeekend: wd === 0 || wd === 6 };
};

const money = (v: number) => `${Math.round(Number(v) || 0).toLocaleString("vi-VN")}đ`;
const num = (v: number) => Math.round(Number(v) || 0).toLocaleString("vi-VN");
const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/** Gom danh sách tùy chọn theo tên nhóm, giữ thứ tự bán nhiều → ít trong nhóm. */
function groupOptions<T extends OptionRow>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.group_name) || [];
    list.push(row);
    map.set(row.group_name, list);
  }
  return Array.from(map, ([group, items]) => ({
    group,
    items: items.sort((a, b) => b.quantity - a.quantity),
    total: items.reduce((s, r) => s + Number(r.quantity), 0),
  }));
}

function Bar({ value, tone = "indigo" }: { value: number; tone?: "indigo" | "emerald" }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-800/70 overflow-hidden">
      <div
        className={`h-full rounded-full ${tone === "emerald" ? "bg-emerald-500" : "bg-indigo-500"}`}
        style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function OptionGroupCard({ group, items, total }: { group: string; items: OptionRow[]; total: number }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h4 className="text-sm font-bold text-slate-200">{group}</h4>
        <span className="text-[11px] text-slate-500">{num(total)} phần</span>
      </div>
      <ul className="space-y-2.5">
        {items.map((it) => (
          <li key={it.option_name}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-slate-300 truncate">{it.option_name}</span>
              <span className="shrink-0 text-slate-400">
                <b className="text-slate-200">{num(it.quantity)}</b>
                <span className="text-slate-500"> · {pct(it.quantity, total).toFixed(0)}%</span>
                {it.extra_revenue > 0 && <span className="ml-2 text-emerald-500">+{money(it.extra_revenue)}</span>}
              </span>
            </div>
            <div className="mt-1"><Bar value={pct(it.quantity, total)} tone="emerald" /></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SalesBreakdown({
  startDate,
  endDate,
  onPickDay,
}: {
  startDate: string;
  endDate: string;
  /** Bấm 1 ngày trong tab "Theo ngày" → trang báo cáo lọc riêng ngày đó. */
  onPickDay?: (day: string) => void;
}) {
  const singleDay = startDate === endDate;
  const [tab, setTab] = useState<Tab>(singleDay ? "products" : "days");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<Breakdown>({
    queryKey: ["salesBreakdown", startDate, endDate],
    queryFn: async () => {
      const res = await api.get(`/api/v1/reports/sales-breakdown?start_date=${startDate}&end_date=${endDate}`);
      return res.data;
    },
  });

  const optionGroups = useMemo(() => groupOptions(data?.options || []), [data]);
  const optionsByProduct = useMemo(() => {
    const map = new Map<string, ReturnType<typeof groupOptions<ProductOptionRow>>>();
    const byProduct = new Map<string, ProductOptionRow[]>();
    for (const row of data?.product_options || []) {
      const list = byProduct.get(row.product_name) || [];
      list.push(row);
      byProduct.set(row.product_name, list);
    }
    byProduct.forEach((rows, name) => map.set(name, groupOptions(rows)));
    return map;
  }, [data]);

  const totals = data?.totals || { orders: 0, quantity: 0, revenue: 0, cost: 0, comp_quantity: 0, comp_value: 0 };
  const noItems = !!data && totals.quantity === 0;
  const comps = data?.comps || [];
  // Gộp theo người tặng để chủ quán đối chiếu nhanh
  const compsByStaff = useMemo(() => {
    const map = new Map<string, { quantity: number; value: number }>();
    for (const c of data?.comps || []) {
      const cur = map.get(c.given_by) || { quantity: 0, value: 0 };
      map.set(c.given_by, { quantity: cur.quantity + c.quantity, value: cur.value + c.value });
    }
    return Array.from(map, ([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value);
  }, [data]);
  const maxProductQty = Math.max(1, ...(data?.products || []).map((p) => Number(p.quantity)));
  const days = data?.days || [];
  const maxDayRevenue = Math.max(1, ...days.map((d) => Number(d.revenue)));
  const daysRevenue = days.reduce((s, d) => s + Number(d.revenue), 0);
  const bestDay = days.reduce<DayRow | null>((best, d) => (!best || d.revenue > best.revenue ? d : best), null);

  // short: nhãn gọn cho điện thoại để các tab vừa một hàng
  const tabs: { key: Tab; label: string; short: string; icon: React.ElementType }[] = [
    { key: "days", label: "Theo ngày", short: "Ngày", icon: CalendarDays },
    { key: "products", label: "Theo món", short: "Món", icon: UtensilsCrossed },
    { key: "options", label: "Theo sốt / size", short: "Sốt/size", icon: Layers },
    { key: "categories", label: "Danh mục", short: "Danh mục", icon: PieChart },
    { key: "comps", label: `Tặng${totals.comp_quantity ? ` (${num(totals.comp_quantity)})` : ""}`, short: "Tặng", icon: Gift },
  ];

  return (
    <section className="glass-panel p-6 rounded-2xl space-y-5">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Thống kê bán hàng</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {singleDay
              ? `Ngày ${dayLabel(startDate).weekday} ${dayLabel(startDate).date}: món nào bán chạy, bao nhiêu phần, sốt và size nào được chọn.`
              : "Doanh thu từng ngày, món bán chạy, sốt và size được chọn nhiều trong kỳ đã chọn."}
          </p>
        </div>
        <div role="tablist" className="flex w-full xl:w-auto gap-1 p-1 bg-slate-900 border border-slate-800 rounded-xl self-start overflow-x-auto no-scrollbar">
          {tabs.map(({ key, label, short, icon: Icon }) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              // Chưa bán món nào thì tab nào cũng trống — khóa lại để không tưởng là bấm hỏng.
              disabled={noItems}
              title={noItems ? "Chưa có món nào được bán trong kỳ này" : undefined}
              onClick={() => setTab(key)}
              className={`flex flex-1 xl:flex-none items-center justify-center gap-1.5 whitespace-nowrap px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                tab === key && !noItems ? "bg-indigo-600 text-white" : "text-slate-400 enabled:hover:text-slate-200"
              }`}
            >
              <Icon className="hidden sm:block w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ["Số đơn", num(totals.orders)],
          ["Số phần bán", num(totals.quantity)],
          ["Doanh thu món", money(totals.revenue)],
          ["Hàng tặng", `${num(totals.comp_quantity)} phần · ${money(totals.comp_value)}`],
        ].map(([label, value]) => (
          <div key={label} className="p-3 bg-slate-900/40 border border-slate-850 rounded-xl">
            <span className="text-[10px] text-slate-500 font-semibold block uppercase">{label}</span>
            <span className="text-sm font-bold text-slate-100 block mt-1">{value}</span>
          </div>
        ))}
      </div>

      {isLoading && <p className="text-xs text-slate-500 py-6 text-center">Đang tải thống kê…</p>}
      {error && (
        <p className="text-xs text-rose-500 py-6 text-center">
          Không tải được thống kê: {(error as any)?.response?.data?.detail || (error as Error).message}
        </p>
      )}
      {data && totals.quantity === 0 && (
        <p className="text-xs text-slate-500 py-6 text-center">Chưa có món nào được bán trong khoảng ngày này.</p>
      )}

      {data && totals.quantity > 0 && tab === "days" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl border border-slate-850 bg-slate-900/40">
              <span className="text-[10px] text-slate-500 font-semibold block uppercase">Trung bình / ngày ({days.length} ngày)</span>
              <span className="text-sm font-bold text-slate-100 block mt-1">{money(days.length ? daysRevenue / days.length : 0)}</span>
            </div>
            <div className="p-3 rounded-xl border border-slate-850 bg-slate-900/40">
              <span className="text-[10px] text-slate-500 font-semibold block uppercase">Ngày cao nhất</span>
              <span className="text-sm font-bold text-slate-100 block mt-1">
                {bestDay ? `${dayLabel(bestDay.day).weekday} ${dayLabel(bestDay.day).date} · ${money(bestDay.revenue)}` : "—"}
              </span>
            </div>
          </div>
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase text-slate-500 border-b border-slate-800">
                  <th className="text-left font-semibold py-2 px-2">Ngày</th>
                  <th className="text-right font-semibold py-2 px-2">Đơn</th>
                  <th className="text-right font-semibold py-2 px-2">Phần</th>
                  <th className="text-right font-semibold py-2 px-2">Doanh thu</th>
                  <th className="text-left font-semibold py-2 px-2 hidden sm:table-cell">Bán chạy nhất</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const label = dayLabel(d.day);
                  const empty = d.orders === 0;
                  return (
                    <tr
                      key={d.day}
                      onClick={() => { if (!empty && onPickDay) { onPickDay(d.day); setTab("products"); } }}
                      className={`border-b border-slate-850 ${empty ? "opacity-45" : onPickDay ? "cursor-pointer hover:bg-slate-850/50" : ""}`}
                      title={empty ? undefined : "Xem chi tiết món bán trong ngày này"}
                    >
                      <td className="py-2.5 px-2 whitespace-nowrap">
                        <span className={`inline-block w-7 font-bold ${label.isWeekend ? "text-rose-500" : "text-slate-400"}`}>{label.weekday}</span>
                        <span className="font-semibold text-slate-200">{label.date}</span>
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-300">{num(d.orders)}</td>
                      <td className="py-2.5 px-2 text-right text-slate-300">{num(d.quantity)}</td>
                      <td className="py-2.5 px-2 text-right">
                        <span className="font-bold text-slate-100 whitespace-nowrap">{money(d.revenue)}</span>
                        <div className="mt-1 ml-auto w-24 max-w-full"><Bar value={(d.revenue / maxDayRevenue) * 100} /></div>
                        {d.top_product && (
                          <span className="sm:hidden mt-1 block text-[10px] text-slate-500 truncate">
                            {d.top_product} ×{num(d.top_quantity)}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 hidden sm:table-cell text-slate-300">
                        {d.top_product ? <><span className="font-semibold">{d.top_product}</span> <span className="text-slate-500">×{num(d.top_quantity)}</span></> : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-slate-500 px-1">
            Doanh thu ngày là số tiền khách trả (sau giảm giá). Bấm vào một ngày để xem món bán trong ngày đó.
          </p>
        </div>
      )}

      {data && totals.quantity > 0 && tab === "comps" && (
        comps.length === 0 ? (
          <p className="text-xs text-slate-500 py-6 text-center">Không có món nào được tặng trong khoảng ngày này.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {compsByStaff.map((p) => (
                <span key={p.name} className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs">
                  <b className="text-slate-200">{p.name}</b>
                  <span className="text-slate-500"> · {num(p.quantity)} phần · {money(p.value)}</span>
                </span>
              ))}
            </div>
            <div className="overflow-x-auto -mx-2">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="text-[10px] uppercase text-slate-500 border-b border-slate-800">
                    <th className="text-left font-semibold py-2 px-2">Lúc</th>
                    <th className="text-left font-semibold py-2 px-2">Món</th>
                    <th className="text-right font-semibold py-2 px-2">SL</th>
                    <th className="text-right font-semibold py-2 px-2">Trị giá</th>
                    <th className="text-left font-semibold py-2 px-2">Lý do</th>
                    <th className="text-left font-semibold py-2 px-2">Người tặng</th>
                  </tr>
                </thead>
                <tbody>
                  {comps.map((c, i) => (
                    <tr key={`${c.order_id}-${i}`} className="border-b border-slate-850">
                      <td className="py-2.5 px-2 whitespace-nowrap text-slate-400">
                        {new Date(c.sold_at).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}
                        <span className="block text-[10px] text-slate-500">Đơn #{c.order_id}</span>
                      </td>
                      <td className="py-2.5 px-2">
                        <span className="font-semibold text-slate-200">{c.product_name}</span>
                        {c.options && <span className="block text-[10px] text-slate-500">{c.options}</span>}
                      </td>
                      <td className="py-2.5 px-2 text-right text-slate-300">{num(c.quantity)}</td>
                      <td className="py-2.5 px-2 text-right font-semibold text-pink-700 dark:text-pink-300 whitespace-nowrap">{money(c.value)}</td>
                      <td className="py-2.5 px-2 text-slate-300">{c.reason}</td>
                      <td className="py-2.5 px-2 text-slate-300 whitespace-nowrap">{c.given_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-slate-500 px-1">
              Món tặng không tính vào doanh thu nhưng vẫn trừ kho và tính giá vốn. Lý do và người tặng không sửa được sau khi lưu.
            </p>
          </div>
        )
      )}

      {data && totals.quantity > 0 && tab === "products" && (
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 border-b border-slate-800">
                <th className="text-left font-semibold py-2 px-2 w-8">#</th>
                <th className="text-left font-semibold py-2 px-2">Món</th>
                <th className="text-right font-semibold py-2 px-2">SL</th>
                <th className="text-right font-semibold py-2 px-2">Doanh thu</th>
                <th className="text-left font-semibold py-2 px-2 w-1/4 hidden md:table-cell">Tỉ trọng doanh thu</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((p, i) => {
                const key = `${p.product_name}|${p.category}`;
                const groups = optionsByProduct.get(p.product_name);
                const open = expanded === key;
                return (
                  <React.Fragment key={key}>
                    <tr
                      className={`border-b border-slate-850 ${groups ? "cursor-pointer hover:bg-slate-850/50" : ""}`}
                      onClick={() => groups && setExpanded(open ? null : key)}
                    >
                      <td className="py-2.5 px-2 text-slate-500">{i + 1}</td>
                      <td className="py-2.5 px-2">
                        <div className="flex items-center gap-1.5">
                          {groups ? (
                            open ? <ChevronDown className="w-3.5 h-3.5 text-indigo-400 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          ) : <span className="w-3.5 shrink-0" />}
                          <div className="min-w-0">
                            <span className="font-semibold text-slate-200 block truncate">{p.product_name}</span>
                            <span className="text-[10px] text-slate-500">{p.category}</span>
                          </div>
                        </div>
                        <div className="mt-1.5 md:hidden"><Bar value={(p.quantity / maxProductQty) * 100} /></div>
                      </td>
                      <td className="py-2.5 px-2 text-right font-bold text-slate-200">{num(p.quantity)}</td>
                      <td className="py-2.5 px-2 text-right text-slate-300 whitespace-nowrap">{money(p.revenue)}</td>
                      <td className="py-2.5 px-2 hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <Bar value={pct(p.revenue, totals.revenue)} />
                          <span className="text-[10px] text-slate-500 w-9 text-right">{pct(p.revenue, totals.revenue).toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                    {open && groups && (
                      <tr className="border-b border-slate-850">
                        <td />
                        <td colSpan={4} className="py-3 px-2">
                          <div className="grid gap-3 sm:grid-cols-2">
                            {groups.map((g) => <OptionGroupCard key={g.group} {...g} />)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="text-[10px] text-slate-500 mt-3 px-2">
            Bấm vào món có mũi tên để xem size / sốt khách chọn. Món cũ trước khi gộp vẫn hiện tên cũ như trên hóa đơn.
          </p>
        </div>
      )}

      {data && totals.quantity > 0 && tab === "options" && (
        optionGroups.length === 0 ? (
          <p className="text-xs text-slate-500 py-6 text-center">Chưa có đơn nào chọn size / sốt trong khoảng ngày này.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {optionGroups.map((g) => <OptionGroupCard key={g.group} {...g} />)}
          </div>
        )
      )}

      {data && totals.quantity > 0 && tab === "categories" && (
        <ul className="space-y-3">
          {data.categories.map((c) => (
            <li key={c.category}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="font-semibold text-slate-200">{c.category}</span>
                <span className="text-slate-400">
                  {num(c.quantity)} phần · <b className="text-slate-200">{money(c.revenue)}</b>
                  <span className="text-slate-500"> · {pct(c.revenue, totals.revenue).toFixed(1)}%</span>
                </span>
              </div>
              <div className="mt-1"><Bar value={pct(c.revenue, totals.revenue)} /></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
