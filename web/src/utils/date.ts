// Ngày dạng "YYYY-MM-DD" theo giờ máy (giờ VN tại quán). KHÔNG dùng toISOString():
// nó đổi sang UTC nên ở +07 mốc nửa đêm bị lùi 1 ngày.

export const toYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const fromYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/** "2026-11-22" → "22/11/2026" */
export const formatYmd = (s: string) => {
  if (!s) return "";
  const d = fromYmd(s);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

export const todayYmd = () => toYmd(new Date());

export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);

export type DatePreset = { label: string; from: string; to: string };

/**
 * Các khoảng chọn nhanh dùng chung (báo cáo, kỳ lương…).
 * `wholeMonth`: "Tháng này" lấy tới cuối tháng (kỳ lương) thay vì tới hôm nay (báo cáo).
 */
export function quickRanges({ wholeMonth = false }: { wholeMonth?: boolean } = {}): DatePreset[] {
  const today = new Date();
  const shift = (days: number) => { const d = new Date(today); d.setDate(d.getDate() + days); return d; };
  const lastMonth = addMonths(today, -1);
  const ranges: DatePreset[] = [
    { label: "Hôm nay", from: toYmd(today), to: toYmd(today) },
    { label: "Hôm qua", from: toYmd(shift(-1)), to: toYmd(shift(-1)) },
    { label: "7 ngày", from: toYmd(shift(-6)), to: toYmd(today) },
    { label: "Tháng này", from: toYmd(startOfMonth(today)), to: toYmd(wholeMonth ? endOfMonth(today) : today) },
    { label: "Tháng trước", from: toYmd(startOfMonth(lastMonth)), to: toYmd(endOfMonth(lastMonth)) },
  ];
  return wholeMonth ? ranges.filter((r) => r.label !== "Hôm nay" && r.label !== "Hôm qua") : ranges;
}
