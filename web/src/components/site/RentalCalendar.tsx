"use client";

/**
 * Lịch trống cho đồ thuê trên website (RPC công khai get_public_rental_calendar):
 * chỉ biết ngày trống / kín, không có dữ liệu khách. Ngày "trống" khi MỌI món trong giỏ
 * còn ít nhất một chiếc rảnh cả ngày. Shop vẫn kiểm trùng lịch lúc xác nhận.
 */
import React, { useEffect, useState } from "react";
import { rpc } from "@/utils/customerAuth";

type Day = { date: string; free: boolean };
const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const SPAN = 35;
const MAX_AHEAD = 180;

/** Ngày hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD */
function todayVN(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function RentalCalendar({ shop, itemIds, start, end, onChange }: {
  shop: string;
  itemIds: number[];
  /** "YYYY-MM-DDTHH:mm" */
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}) {
  const [today] = useState(todayVN);
  const [offset, setOffset] = useState(0);
  const [days, setDays] = useState<Map<string, boolean> | null>(null);
  const [picking, setPicking] = useState<"start" | "end">("start");
  const from = addDays(today, offset);
  const key = itemIds.join(",");

  useEffect(() => {
    if (!itemIds.length) { setDays(new Map()); return; }
    let alive = true;
    setDays(null);
    Promise.all(itemIds.map((id) =>
      rpc<{ days: Day[] } | null>("get_public_rental_calendar", { p_shop: shop, p_item_id: id, p_from: from, p_days: SPAN })))
      .then((rs) => {
        if (!alive) return;
        const m = new Map<string, boolean>();
        for (const r of rs) for (const d of r?.days ?? []) m.set(d.date, (m.get(d.date) ?? true) && d.free);
        setDays(m);
      })
      .catch(() => alive && setDays(new Map()));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, key, from]);

  const startDate = start.slice(0, 10);
  const endDate = end.slice(0, 10);
  const busyInRange = days ? [...days.entries()].some(([d, free]) => !free && d >= startDate && d <= endDate) : false;

  // Lưới bắt đầu từ thứ Hai của tuần chứa ngày đầu
  const first = new Date(`${from}T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: SPAN }, (_, i) => addDays(from, i))];

  const pick = (d: string) => {
    const t1 = start.slice(10) || "T09:00";
    const t2 = end.slice(10) || "T09:00";
    if (picking === "start" || d < startDate) {
      onChange(`${d}${t1}`, endDate > d ? end : `${addDays(d, 1)}${t2}`);
      setPicking("end");
    } else {
      onChange(start, `${d}${t2}`);
      setPicking("start");
    }
  };

  const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("vi-VN", { day: "numeric", month: "numeric", timeZone: "UTC" });
  return (
    <div className="space-y-2 rounded-[var(--radius)] border border-black/10 bg-white p-3 text-[var(--c-text)]">
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={() => setOffset((o) => Math.max(0, o - SPAN))} disabled={offset === 0}
          className="rounded px-2 py-1 disabled:opacity-30" aria-label="Các ngày trước">‹</button>
        <span className="font-medium">{label(from)} – {label(addDays(from, SPAN - 1))}</span>
        <button type="button" onClick={() => setOffset((o) => Math.min(MAX_AHEAD - SPAN, o + SPAN))} disabled={offset + SPAN >= MAX_AHEAD}
          className="rounded px-2 py-1 disabled:opacity-30" aria-label="Các ngày sau">›</button>
      </div>
      <p className="text-xs text-[var(--c-muted)]">{picking === "start" ? "Chọn ngày nhận đồ" : "Chọn ngày trả đồ"}</p>
      <div className="grid grid-cols-7 gap-1 text-center text-xs" role="grid" aria-busy={days === null}>
        {WEEKDAYS.map((w) => <span key={w} className="py-1 font-medium text-[var(--c-muted)]">{w}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`x${i}`} />;
          const free = days?.get(d);
          const inRange = d >= startDate && d <= endDate;
          const edge = d === startDate || d === endDate;
          return (
            <button key={d} type="button" onClick={() => pick(d)} disabled={days === null || free === false}
              aria-pressed={inRange} aria-label={`${label(d)}${free === false ? " — đã kín" : ""}`}
              className={`rounded py-1.5 tabular-nums transition ${
                edge ? "bg-[var(--c-primary)] font-semibold text-white"
                : inRange ? "ring-1 ring-inset ring-[var(--c-primary)]"
                : free === false ? "cursor-not-allowed bg-black/5 text-black/30 line-through"
                : "hover:bg-black/5"}`}>
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
      <p className="flex flex-wrap gap-3 text-[11px] text-[var(--c-muted)]">
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-black/10 align-middle" />Đã kín</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[var(--c-primary)] align-middle" />Đang chọn</span>
      </p>
      {busyInRange && (
        <p role="alert" className="text-xs text-amber-700">Khoảng ngày đã chọn có ngày kín lịch — shop có thể không nhận được. Chọn ngày khác cho chắc.</p>
      )}
    </div>
  );
}
