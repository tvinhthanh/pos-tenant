"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";

/** Ngày dạng "YYYY-MM-DD" theo giờ máy (không đổi qua UTC — tránh lùi 1 ngày ở +07). */
export const toYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const fmt = (s: string) => {
  const d = fromYmd(s);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const order = (a: string, b: string): [string, string] => (a <= b ? [a, b] : [b, a]);

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

export type DatePreset = { label: string; from: string; to: string };

interface DateRangePickerProps {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  presets?: DatePreset[];
  /** Ngày muộn nhất được chọn (mặc định: hôm nay). */
  max?: string;
}

/**
 * Chọn khoảng ngày: bấm ngày đầu rồi ngày cuối, hoặc nhấn giữ và KÉO qua các ngày
 * (chuột hoặc cảm ứng). Desktop hiện 2 tháng, mobile 1 tháng.
 */
export default function DateRangePicker({ from, to, onChange, presets = [], max = toYmd(new Date()) }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(fromYmd(to)));
  // Đang chọn dở: đã có ngày đầu, chờ ngày cuối (bấm lần 2 hoặc thả tay khi kéo)
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  // Bản sao để listener trên window (thả tay ngoài lịch) đọc được giá trị mới nhất
  const sel = useRef<{ anchor: string | null; hover: string | null }>({ anchor: null, hover: null });
  sel.current = { anchor, hover };
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // Thả tay ở bất kỳ đâu (kể cả ngoài lịch) vẫn kết thúc thao tác kéo
    const onUp = () => finishDrag();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  });

  function close() {
    setOpen(false);
    setAnchor(null);
    setHover(null);
    dragging.current = false;
  }

  function toggle() {
    if (open) return close();
    // Desktop hiện 2 tháng: tháng trước + tháng của ngày cuối; mobile chỉ tháng của ngày cuối
    const twoMonths = typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
    setMonth(addMonths(startOfMonth(fromYmd(to)), twoMonths ? -1 : 0));
    setOpen(true);
  }

  function commit(a: string, b: string) {
    const [f, t] = order(a, b);
    onChange(f, t);
    close();
  }

  // Khoảng đang hiển thị: chọn dở thì anchor→hover, không thì giá trị hiện tại
  const [selFrom, selTo] = anchor ? order(anchor, hover ?? anchor) : [from, to];

  const dateAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-ymd]")?.dataset.ymd ?? null;

  const onPointerDown = (e: React.PointerEvent, ymd: string) => {
    if (ymd > max) return;
    e.preventDefault();
    // Bấm lần 2 khi đang chọn dở → kết thúc khoảng
    if (anchor && !dragging.current) {
      commit(anchor, ymd);
      return;
    }
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragging.current = true;
    dragMoved.current = false;
    setAnchor(ymd);
    setHover(ymd);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const ymd = dateAt(e.clientX, e.clientY);
    if (ymd && ymd <= max && ymd !== hover) {
      dragMoved.current = true;
      setHover(ymd);
    }
  };

  function finishDrag() {
    if (!dragging.current) return;
    dragging.current = false;
    // Kéo qua nhiều ngày → xong luôn; chỉ bấm 1 ngày → chờ bấm ngày cuối
    const { anchor: a, hover: h } = sel.current;
    if (dragMoved.current && a && h) commit(a, h);
  }

  const months = [month, addMonths(month, 1)];
  const canNext = toYmd(addMonths(month, 1)) <= max;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-slate-200 hover:bg-slate-850 tabular-nums"
      >
        <Calendar className="h-4 w-4 shrink-0 text-slate-500" />
        <span className="truncate">
          {from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Chọn khoảng ngày"
          className="fixed inset-x-3 top-24 z-50 rounded-2xl border border-slate-800 bg-slate-950 p-3 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-max"
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            {presets.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar sm:w-28 sm:flex-col sm:border-r sm:border-slate-850 sm:pr-3">
                {presets.map((p) => {
                  const active = p.from === from && p.to === to;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => commit(p.from, p.to)}
                      className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold ${
                        active ? "bg-indigo-600 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div>
              <div
                className="flex touch-none select-none gap-6"
                onPointerMove={onPointerMove}
                onPointerLeave={() => !dragging.current && anchor && setHover(null)}
              >
                {months.map((m, i) => (
                  <div key={toYmd(m)} className={i === 1 ? "hidden md:block" : ""}>
                    <div className="mb-2 flex h-8 items-center justify-between">
                      {i === 0 ? (
                        <button type="button" onClick={() => setMonth(addMonths(month, -1))} aria-label="Tháng trước"
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-100">
                          <ChevronLeft className="h-4 w-4" />
                        </button>
                      ) : <span className="w-7" />}
                      <span className="text-xs font-bold text-slate-200">Tháng {m.getMonth() + 1}/{m.getFullYear()}</span>
                      {/* Mũi tên "sau" ở tháng cuối đang hiện (mobile: tháng 1, desktop: tháng 2) */}
                      <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="Tháng sau" disabled={!canNext}
                        className={`rounded-lg p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-30 ${
                          i === 0 ? "md:invisible" : ""}`}>
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                    <MonthGrid month={m} selFrom={selFrom} selTo={selTo} max={max} today={toYmd(new Date())}
                      onDayPointerDown={onPointerDown}
                      onDayHover={(ymd) => { if (anchor && !dragging.current && ymd <= max) setHover(ymd); }} />
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-850 pt-2.5 text-[11px] text-slate-500">
                <span>
                  {anchor
                    ? <>Chọn ngày cuối · đang chọn <b className="text-slate-300">{fmt(selFrom)} – {fmt(selTo)}</b></>
                    : "Bấm 2 ngày, hoặc nhấn giữ rồi kéo qua các ngày"}
                </span>
                <button type="button" onClick={close} aria-label="Đóng" className="rounded-lg p-1 text-slate-500 hover:text-slate-100">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MonthGrid({
  month, selFrom, selTo, max, today, onDayPointerDown, onDayHover,
}: {
  month: Date; selFrom: string; selTo: string; max: string; today: string;
  onDayPointerDown: (e: React.PointerEvent, ymd: string) => void;
  onDayHover: (ymd: string) => void;
}) {
  const cells = useMemo(() => {
    const first = startOfMonth(month);
    const lead = (first.getDay() + 6) % 7; // tuần bắt đầu thứ Hai
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: days }, (_, i) => toYmd(new Date(month.getFullYear(), month.getMonth(), i + 1))),
    ];
  }, [month]);

  return (
    <div className="grid grid-cols-7 gap-y-1 text-center">
      {WEEKDAYS.map((w) => (
        <span key={w} className="pb-1 text-[10px] font-semibold text-slate-500">{w}</span>
      ))}
      {cells.map((ymd, i) => {
        if (!ymd) return <span key={`e${i}`} />;
        const disabled = ymd > max;
        const inRange = ymd >= selFrom && ymd <= selTo;
        const isEdge = ymd === selFrom || ymd === selTo;
        const col = i % 7;
        return (
          <div
            key={ymd}
            className={`h-9 ${inRange && !(selFrom === selTo) ? "bg-indigo-500/10 dark:bg-indigo-500/20" : ""} ${
              ymd === selFrom || col === 0 ? "rounded-l-lg" : ""} ${ymd === selTo || col === 6 ? "rounded-r-lg" : ""}`}
          >
            <button
              type="button"
              data-ymd={ymd}
              disabled={disabled}
              onPointerDown={(e) => onDayPointerDown(e, ymd)}
              onPointerEnter={() => onDayHover(ymd)}
              aria-pressed={inRange}
              aria-label={fmt(ymd)}
              className={`h-9 w-9 rounded-lg text-xs tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-25 ${
                isEdge
                  ? "bg-indigo-600 font-bold text-white"
                  : inRange
                    ? "font-semibold text-indigo-700 dark:text-indigo-200"
                    : "text-slate-300 enabled:hover:bg-slate-900"
              } ${ymd === today && !isEdge ? "ring-1 ring-inset ring-slate-600" : ""}`}
            >
              {Number(ymd.slice(8))}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
