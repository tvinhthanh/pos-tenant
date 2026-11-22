"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  addMonths, formatYmd, fromYmd, startOfMonth, toYmd, todayYmd, type DatePreset,
} from "@/utils/date";

/*
 * Bộ chọn ngày dùng chung cho cả app — gọi một trong hai:
 *
 *   <DatePicker value={d} onChange={setD} />                      // 1 ngày
 *   <DateRangePicker from={f} to={t} onChange={(f, t) => …} />    // khoảng ngày (bấm 2 ngày hoặc kéo)
 *
 * Giá trị luôn là chuỗi "YYYY-MM-DD" theo giờ máy ("" = chưa chọn).
 * variant="field" (mặc định): ô nhập như input trong form.
 * variant="inline": ô trong suốt, đặt trong một thanh công cụ có khung sẵn.
 */

type Variant = "field" | "inline";

type CommonProps = {
  /** Ngày sớm/muộn nhất được chọn ("YYYY-MM-DD"). */
  min?: string;
  max?: string;
  /** Mép neo bảng lịch so với ô bấm (desktop). */
  align?: "left" | "right";
  variant?: Variant;
  placeholder?: string;
  /** Bắt buộc chọn trong form (trình duyệt chặn submit khi trống). */
  required?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
};

export type DatePickerProps = CommonProps & {
  value: string;
  onChange: (value: string) => void;
};

export type DateRangePickerProps = CommonProps & {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  presets?: DatePreset[];
};

/** Chọn 1 ngày. */
export function DatePicker({ value, onChange, placeholder = "Chọn ngày", ...rest }: DatePickerProps) {
  return (
    <CalendarPopover
      mode="single"
      from={value}
      to={value}
      onPick={(f) => onChange(f)}
      placeholder={placeholder}
      {...rest}
    />
  );
}

/** Chọn khoảng ngày: bấm ngày đầu rồi ngày cuối, hoặc nhấn giữ và kéo qua các ngày. */
export function DateRangePicker({ from, to, onChange, placeholder = "Chọn khoảng ngày", max = todayYmd(), ...rest }: DateRangePickerProps) {
  return (
    <CalendarPopover mode="range" from={from} to={to} onPick={onChange} placeholder={placeholder} max={max} {...rest} />
  );
}

// ---------------------------------------------------------------------------

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const order = (a: string, b: string): [string, string] => (a <= b ? [a, b] : [b, a]);

const TRIGGER: Record<Variant, string> = {
  field:
    "flex w-full items-center gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-left text-sm text-slate-100 tabular-nums transition-colors hover:border-slate-700 focus:border-indigo-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  inline:
    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-slate-200 tabular-nums hover:bg-slate-850 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50",
};

function CalendarPopover({
  mode, from, to, onPick, presets = [], min = "0000-01-01", max = "9999-12-31",
  align = "left", variant = "field", placeholder, required, disabled, id, className, ...aria
}: CommonProps & {
  mode: "single" | "range";
  from: string;
  to: string;
  onPick: (from: string, to: string) => void;
  presets?: DatePreset[];
}) {
  const single = mode === "single";
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  // Số tháng hiện cùng lúc — quyết định một lần khi mở (desktop 2, mobile/1 ngày 1)
  const [twoMonths, setTwoMonths] = useState(false);
  // Đang chọn dở: đã có ngày đầu, chờ ngày cuối (bấm lần 2 hoặc thả tay khi kéo)
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  // Bản sao để listener trên window (thả tay ngoài lịch) đọc được giá trị mới nhất
  const sel = useRef<{ anchor: string | null; hover: string | null }>({ anchor: null, hover: null });
  sel.current = { anchor, hover };
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Vị trí bảng lịch (desktop): neo theo ô bấm, render qua portal ra <body> để không
  // bị cắt bởi modal có overflow hay Header có backdrop-filter.
  const [pos, setPos] = useState<React.CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = rootRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!t || !pop || window.innerWidth < 640) return setPos(null);
      const h = pop.offsetHeight;
      const below = t.bottom + 8 + h <= window.innerHeight || t.top < h + 8;
      setPos({
        position: "fixed",
        ...(below ? { top: t.bottom + 8 } : { top: t.top - 8 - h }),
        ...(align === "right"
          ? { right: Math.max(8, window.innerWidth - t.right) }
          : { left: Math.max(8, Math.min(t.left, window.innerWidth - pop.offsetWidth - 8)) }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, month]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
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

  const clamp = (ymd: string) => (ymd > max ? max : ymd < min ? min : ymd);
  const allowed = (ymd: string) => ymd >= min && ymd <= max;

  function close() {
    setOpen(false);
    setAnchor(null);
    setHover(null);
    dragging.current = false;
  }

  function toggle() {
    if (open) return close();
    // Khoảng ngày trên desktop hiện 2 tháng: tháng trước + tháng của ngày cuối
    const two = !single && window.matchMedia("(min-width: 768px)").matches;
    const base = to || clamp(todayYmd());
    setTwoMonths(two);
    setMonth(addMonths(startOfMonth(fromYmd(base)), two ? -1 : 0));
    setOpen(true);
  }

  function commit(a: string, b: string) {
    const [f, t] = order(a, b);
    onPick(f, t);
    close();
  }

  const [selFrom, selTo] = anchor ? order(anchor, hover ?? anchor) : [from, to];

  const dateAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-ymd]")?.dataset.ymd ?? null;

  const onDayDown = (e: React.PointerEvent, ymd: string) => {
    if (!allowed(ymd)) return;
    e.preventDefault();
    if (single) return commit(ymd, ymd);
    // Bấm lần 2 khi đang chọn dở → kết thúc khoảng
    if (anchor && !dragging.current) return commit(anchor, ymd);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragging.current = true;
    dragMoved.current = false;
    setAnchor(ymd);
    setHover(ymd);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const ymd = dateAt(e.clientX, e.clientY);
    if (ymd && allowed(ymd) && ymd !== hover) {
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

  const months = twoMonths ? [month, addMonths(month, 1)] : [month];
  const lastShown = months[months.length - 1];
  const canPrev = toYmd(addMonths(month, 0)) > min;
  const canNext = toYmd(addMonths(lastShown, 1)) <= max;
  const label = !from ? placeholder : from === to ? formatYmd(from) : `${formatYmd(from)} – ${formatYmd(to)}`;

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className ?? ""}`}>
      <button
        type="button"
        id={id}
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={aria["aria-label"]}
        className={TRIGGER[variant]}
      >
        <Calendar className="h-4 w-4 shrink-0 text-slate-500" />
        <span className={`truncate ${from ? "" : "text-slate-500"}`}>{label}</span>
      </button>
      {required && (
        // Ô ẩn để kiểm tra required của form vẫn chạy khi chưa chọn ngày
        <input tabIndex={-1} aria-hidden required value={from} onChange={() => undefined}
          className="pointer-events-none absolute bottom-0 left-4 h-px w-px opacity-0" />
      )}

      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label={single ? "Chọn ngày" : "Chọn khoảng ngày"}
          // Mobile: tấm lịch rộng gần hết màn hình; desktop: neo theo ô bấm (pos)
          style={pos ?? undefined}
          className="fixed inset-x-3 top-24 z-[70] rounded-2xl border border-slate-800 bg-slate-950 p-3 shadow-2xl sm:inset-x-auto sm:w-max"
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            {presets.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar sm:w-28 sm:flex-col sm:border-r sm:border-slate-850 sm:pr-3">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => commit(p.from, p.to)}
                    className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold ${
                      p.from === from && p.to === to ? "bg-indigo-600 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div>
              <div
                className="flex touch-none select-none justify-center gap-6"
                onPointerMove={onMove}
                onPointerLeave={() => !dragging.current && anchor && setHover(null)}
              >
                {months.map((m, i) => {
                  const isLast = i === months.length - 1;
                  return (
                    <div key={toYmd(m)}>
                      <div className="mb-2 flex h-8 items-center justify-between">
                        {i === 0 ? (
                          <button type="button" onClick={() => setMonth(addMonths(month, -1))} aria-label="Tháng trước" disabled={!canPrev}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-30">
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                        ) : <span className="w-7" />}
                        <span className="text-xs font-bold text-slate-200">Tháng {m.getMonth() + 1}/{m.getFullYear()}</span>
                        {isLast ? (
                          <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="Tháng sau" disabled={!canNext}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-30">
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        ) : <span className="w-7" />}
                      </div>
                      <MonthGrid
                        month={m} selFrom={selFrom} selTo={selTo} allowed={allowed} today={todayYmd()}
                        onDayDown={onDayDown}
                        onDayHover={(ymd) => { if (anchor && !dragging.current && allowed(ymd)) setHover(ymd); }}
                      />
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-850 pt-2.5 text-[11px] text-slate-500">
                <span>
                  {single
                    ? "Bấm vào ngày để chọn"
                    : anchor
                      ? <>Chọn ngày cuối · <b className="text-slate-300">{formatYmd(selFrom)} – {formatYmd(selTo)}</b></>
                      : "Bấm 2 ngày, hoặc nhấn giữ rồi kéo qua các ngày"}
                </span>
                <span className="flex items-center gap-1">
                  {allowed(todayYmd()) && (
                    <button type="button" onClick={() => commit(todayYmd(), todayYmd())}
                      className="rounded-lg px-2 py-1 font-semibold text-indigo-500 hover:bg-slate-900">
                      Hôm nay
                    </button>
                  )}
                  <button type="button" onClick={close} aria-label="Đóng" className="rounded-lg p-1 text-slate-500 hover:text-slate-100">
                    <X className="h-4 w-4" />
                  </button>
                </span>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function MonthGrid({
  month, selFrom, selTo, allowed, today, onDayDown, onDayHover,
}: {
  month: Date; selFrom: string; selTo: string; today: string;
  allowed: (ymd: string) => boolean;
  onDayDown: (e: React.PointerEvent, ymd: string) => void;
  onDayHover: (ymd: string) => void;
}) {
  const cells = useMemo(() => {
    const lead = (startOfMonth(month).getDay() + 6) % 7; // tuần bắt đầu thứ Hai
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: days }, (_, i) => toYmd(new Date(month.getFullYear(), month.getMonth(), i + 1))),
    ];
  }, [month]);
  const isRange = !!selFrom && selFrom !== selTo;

  return (
    <div className="grid grid-cols-7 gap-y-1 text-center">
      {WEEKDAYS.map((w) => (
        <span key={w} className="pb-1 text-[10px] font-semibold text-slate-500">{w}</span>
      ))}
      {cells.map((ymd, i) => {
        if (!ymd) return <span key={`e${i}`} />;
        const inRange = !!selFrom && ymd >= selFrom && ymd <= selTo;
        const isEdge = ymd === selFrom || ymd === selTo;
        const col = i % 7;
        return (
          <div
            key={ymd}
            className={`h-9 ${isRange && inRange ? "bg-indigo-500/10 dark:bg-indigo-500/20" : ""} ${
              ymd === selFrom || col === 0 ? "rounded-l-lg" : ""} ${ymd === selTo || col === 6 ? "rounded-r-lg" : ""}`}
          >
            <button
              type="button"
              data-ymd={ymd}
              disabled={!allowed(ymd)}
              onPointerDown={(e) => onDayDown(e, ymd)}
              onPointerEnter={() => onDayHover(ymd)}
              aria-pressed={inRange}
              aria-label={formatYmd(ymd)}
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
