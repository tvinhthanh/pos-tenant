"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  getRentalCalendar, fmtTime, LINE_STATUS_LABELS, UNIT_STATUS_LABELS,
  type CalendarBooking, type CalendarItem,
} from "@/utils/rental";
import { errorText } from "@/components/Toaster";
import OverdueAlert from "../_components/OverdueAlert";

type View = "day" | "week";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const LANE_H = 30; // px mỗi làn
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfWeek(d: Date) {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // thứ Hai = 0
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const ddmm = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;

/** Thời điểm kết thúc để vẽ: đang thuê quá hạn / tính giờ kéo tới hiện tại. */
function visualEnd(b: CalendarBooking, now: number): number {
  const start = new Date(b.start).getTime();
  const end = b.end ? new Date(b.end).getTime() : null;
  if (b.status === "out") return Math.max(end ?? now, now);
  if (end != null) return end;
  return start + 2 * HOUR; // đặt trước tính giờ chưa có giờ trả
}

interface Bar { b: CalendarBooking; start: number; end: number; lane: number }

/** Xếp các dòng thuê chồng thời gian vào nhiều làn để không đè nhau. */
function layout(bookings: CalendarBooking[], now: number): { bars: Bar[]; lanes: number } {
  const sorted = bookings
    .map((b) => ({ b, start: new Date(b.start).getTime(), end: visualEnd(b, now) }))
    .sort((x, y) => x.start - y.start || x.end - y.end);
  const laneEnds: number[] = [];
  const bars: Bar[] = sorted.map((x) => {
    let lane = laneEnds.findIndex((e) => e <= x.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(x.end); } else laneEnds[lane] = x.end;
    return { ...x, lane };
  });
  return { bars, lanes: Math.max(laneEnds.length, 1) };
}

/** Số lượng đặt / thuê cao nhất cùng lúc trong khoảng (hàng theo số lượng). */
function peakQuantity(bookings: CalendarBooking[], from: number, to: number, now: number) {
  const ev: [number, number][] = [];
  for (const b of bookings) {
    if (b.status !== "reserved" && b.status !== "out") continue;
    const s = Math.max(new Date(b.start).getTime(), from);
    const e = Math.min(visualEnd(b, now), to);
    if (e <= s) continue;
    ev.push([s, b.quantity], [e, -b.quantity]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, q] of ev) { cur += q; peak = Math.max(peak, cur); }
  return peak;
}

function barStyle(b: CalendarBooking) {
  if (b.overdue) return "bg-rose-500/25 border-rose-500 text-rose-700 dark:text-rose-200";
  switch (b.status) {
    case "reserved": return "bg-amber-400/25 border-amber-500 text-amber-800 dark:text-amber-200";
    case "out": return "bg-indigo-500/25 border-indigo-500 text-indigo-700 dark:text-indigo-200";
    case "lost": return "bg-rose-500/10 border-rose-400/50 text-slate-400 line-through";
    default: return "bg-slate-500/10 border-slate-500/40 text-slate-400";
  }
}

export default function RentalCalendarPage() {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [itemFilter, setItemFilter] = useState<number | "all">("all");

  const from = view === "day" ? startOfDay(anchor) : startOfWeek(anchor);
  const to = addDays(from, view === "day" ? 1 : 7);
  const fromMs = from.getTime();
  const span = to.getTime() - fromMs;

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["rentalCalendar", view, fromMs],
    queryFn: () => getRentalCalendar(from.toISOString(), to.toISOString()),
    refetchInterval: 60_000,
  });
  // Giờ máy chủ của lần tải gần nhất (lịch chỉ vẽ khi đã có dữ liệu)
  const now = data ? new Date(data.now).getTime() : 0;

  const columns = useMemo(() => {
    if (view === "day") {
      return Array.from({ length: 24 }, (_, h) => ({ key: h, label: `${String(h).padStart(2, "0")}h`, today: false }));
    }
    const today = startOfDay(new Date()).getTime();
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(from, i);
      return { key: i, label: `${WEEKDAYS[d.getDay()]} ${ddmm(d)}`, today: d.getTime() === today };
    });
  }, [view, fromMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const byRow = useMemo(() => {
    const unit = new Map<number, CalendarBooking[]>();
    const item = new Map<number, CalendarBooking[]>();
    for (const b of data?.bookings ?? []) {
      if (b.unit_id != null) unit.set(b.unit_id, [...(unit.get(b.unit_id) ?? []), b]);
      else item.set(b.item_id, [...(item.get(b.item_id) ?? []), b]);
    }
    return { unit, item };
  }, [data]);

  const items = (data?.items ?? []).filter((i) => itemFilter === "all" || i.item_id === itemFilter);
  const step = (dir: number) => setAnchor((a) => addDays(a, dir * (view === "day" ? 1 : 7)));
  const rangeLabel = view === "day"
    ? `${WEEKDAYS[from.getDay()]}, ${ddmm(from)}/${from.getFullYear()}`
    : `${ddmm(from)} – ${ddmm(addDays(to, -1))}/${addDays(to, -1).getFullYear()}`;
  const minWidth = view === "day" ? 24 * 52 : 7 * 128;
  const nowPct = now >= fromMs && now < to.getTime() ? ((now - fromMs) / span) * 100 : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Lịch cho thuê</h1>
          <p className="text-sm text-slate-400">Đặt trước và đang thuê theo từng chiếc / từng món. Lịch trống tính từ hợp đồng, không từ trạng thái hiện tại.</p>
        </div>
        <Link href="/rental/new" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          Thuê mới
        </Link>
      </div>

      <OverdueAlert />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-slate-800 p-1">
          {(["day", "week"] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${view === v ? "bg-indigo-600 text-white" : "text-slate-400"}`}>
              {v === "day" ? "Ngày" : "Tuần"}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center rounded-xl border border-slate-800">
          <button onClick={() => step(-1)} aria-label="Trước" className="p-2 text-slate-400 hover:text-slate-100"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => setAnchor(new Date())} className="px-2 text-xs font-medium text-slate-300 hover:text-slate-100">Hôm nay</button>
          <button onClick={() => step(1)} aria-label="Sau" className="p-2 text-slate-400 hover:text-slate-100"><ChevronRight className="h-4 w-4" /></button>
        </div>
        <input
          type="date"
          aria-label="Chọn ngày"
          value={`${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}-${String(anchor.getDate()).padStart(2, "0")}`}
          onChange={(e) => e.target.value && setAnchor(new Date(`${e.target.value}T00:00`))}
          className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
        />
        <span className="text-sm font-semibold text-slate-200">{rangeLabel}</span>
        <select
          value={itemFilter}
          onChange={(e) => setItemFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          aria-label="Lọc theo món"
          className="ml-auto rounded-xl border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
        >
          <option value="all">Tất cả món</option>
          {(data?.items ?? []).map((i) => <option key={i.item_id} value={i.item_id}>{i.name}</option>)}
        </select>
        <button onClick={() => refetch()} aria-label="Làm mới" className="rounded-xl border border-slate-800 p-2 text-slate-400 hover:bg-slate-900">
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      <Legend />

      {error && <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-500">{errorText(error, "Không tải được lịch.")}</p>}
      {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}
      {data && items.length === 0 && (
        <p className="rounded-2xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-400">Chưa có món cho thuê nào.</p>
      )}

      {data && items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <div style={{ minWidth: minWidth + 176 }}>
            {/* Đầu cột */}
            <div className="sticky top-0 z-20 flex border-b border-slate-800 bg-slate-900">
              <div className="sticky left-0 z-30 w-44 shrink-0 border-r border-slate-800 bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Món / chiếc
              </div>
              <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
                {columns.map((c) => (
                  <div key={c.key} className={`border-l border-slate-800 px-1.5 py-2 text-[11px] font-medium first:border-l-0 ${c.today ? "text-indigo-500" : "text-slate-400"}`}>
                    {c.label}
                  </div>
                ))}
              </div>
            </div>

            {items.map((item) => (
              <ItemRows
                key={item.item_id}
                item={item}
                byRow={byRow}
                fromMs={fromMs}
                toMs={to.getTime()}
                span={span}
                now={now}
                columns={columns.length}
                nowPct={nowPct}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Legend() {
  const rows: [string, string][] = [
    ["bg-amber-400/40 border-amber-500", "Đặt trước"],
    ["bg-indigo-500/40 border-indigo-500", "Đang thuê"],
    ["bg-rose-500/40 border-rose-500", "Quá hạn"],
    ["bg-slate-500/20 border-slate-500/40", "Đã trả"],
  ];
  return (
    <div className="flex flex-wrap gap-4 text-xs text-slate-400">
      {rows.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1.5"><span className={`h-3 w-5 rounded border ${c}`} />{l}</span>
      ))}
    </div>
  );
}

function ItemRows({
  item, byRow, fromMs, toMs, span, now, columns, nowPct,
}: {
  item: CalendarItem;
  byRow: { unit: Map<number, CalendarBooking[]>; item: Map<number, CalendarBooking[]> };
  fromMs: number; toMs: number; span: number; now: number; columns: number; nowPct: number | null;
}) {
  const bulk = item.tracking_mode === "bulk";
  const bulkBookings = byRow.item.get(item.item_id) ?? [];
  const peak = bulk ? peakQuantity(bulkBookings, fromMs, toMs, now) : 0;

  return (
    <div className="border-b border-slate-800 last:border-b-0">
      <div className="sticky left-0 flex items-center gap-2 bg-slate-950/60 px-3 py-1.5 text-xs font-semibold text-slate-300">
        {item.name}
        <span className="font-normal text-slate-500">
          {bulk ? `· tổng ${item.total}` : `· ${item.units.length} chiếc`}
        </span>
        {bulk && (
          <span className={`font-normal ${peak >= item.total && item.total > 0 ? "text-rose-500" : "text-slate-500"}`}>
            · cao nhất cùng lúc {peak}/{item.total}
          </span>
        )}
      </div>
      {bulk ? (
        <Row label="Theo số lượng" bookings={bulkBookings} showQty fromMs={fromMs} span={span} now={now} columns={columns} nowPct={nowPct} />
      ) : item.units.length === 0 ? (
        <p className="px-3 py-2 text-xs text-slate-500">Chưa có chiếc nào.</p>
      ) : (
        item.units.map((u) => (
          <Row
            key={u.unit_id}
            label={u.code}
            note={u.status === "maintenance" || u.status === "lost" ? UNIT_STATUS_LABELS[u.status] : undefined}
            bookings={byRow.unit.get(u.unit_id) ?? []}
            fromMs={fromMs} span={span} now={now} columns={columns} nowPct={nowPct}
          />
        ))
      )}
    </div>
  );
}

function Row({
  label, note, bookings, showQty, fromMs, span, now, columns, nowPct,
}: {
  label: string; note?: string; bookings: CalendarBooking[]; showQty?: boolean;
  fromMs: number; span: number; now: number; columns: number; nowPct: number | null;
}) {
  const { bars, lanes } = layout(bookings, now);
  const height = lanes * LANE_H + 6;
  return (
    <div className="flex border-t border-slate-800/60">
      <div className="sticky left-0 z-10 flex w-44 shrink-0 flex-col justify-center border-r border-slate-800 bg-slate-900 px-3 py-1" style={{ minHeight: height }}>
        <span className="font-mono text-xs text-slate-200">{label}</span>
        {note && <span className="text-[10px] font-semibold text-amber-600">{note}</span>}
      </div>
      <div className="relative flex-1" style={{ height }}>
        {/* Vạch cột */}
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} aria-hidden>
          {Array.from({ length: columns }, (_, i) => <div key={i} className="border-l border-slate-800/60 first:border-l-0" />)}
        </div>
        {nowPct != null && <div className="absolute inset-y-0 z-10 w-px bg-rose-500" style={{ left: `${nowPct}%` }} aria-hidden />}
        {bars.map(({ b, start, end, lane }) => {
          const left = Math.max(0, ((start - fromMs) / span) * 100);
          const right = Math.min(100, ((end - fromMs) / span) * 100);
          if (right <= 0 || left >= 100) return null;
          const clipL = start < fromMs, clipR = end > fromMs + span;
          const title = [
            `${b.code} · ${b.customer}${b.phone ? ` (${b.phone})` : ""}`,
            `${LINE_STATUS_LABELS[b.status]}${b.overdue ? " — QUÁ HẠN" : ""}${showQty ? ` · SL ${b.quantity}` : ""}`,
            `${fmtTime(b.checked_out_at ?? b.start)} → ${b.returned_at ? fmtTime(b.returned_at) : b.end ? fmtTime(b.end) : "tính giờ"}`,
          ].join("\n");
          return (
            <Link
              key={b.line_id}
              href={`/rental/contracts/${b.contract_id}`}
              title={title}
              className={`absolute z-20 flex items-center overflow-hidden whitespace-nowrap border px-1.5 text-[11px] font-medium hover:brightness-110 ${barStyle(b)} ${clipL ? "rounded-l-none border-l-0" : "rounded-l-md"} ${clipR ? "rounded-r-none border-r-0" : "rounded-r-md"}`}
              style={{ left: `${left}%`, width: `max(${right - left}%, 4px)`, top: 3 + lane * LANE_H, height: LANE_H - 4 }}
            >
              {showQty && <span className="mr-1 font-bold">×{b.quantity}</span>}
              <span className="truncate">{b.customer} · {b.code}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
