/**
 * Mã vạch Code 128 (tự mã hóa, không cần thư viện ngoài) + tem in cho hàng bán lẻ.
 *
 * Code 128 đọc được bằng mọi máy quét 1D. Chuỗi toàn số dùng bộ C (2 số / ký tự,
 * tem ngắn hơn), còn lại dùng bộ B (ASCII 32–126 — đủ cho mã vạch / SKU của shop).
 */

// Độ rộng thanh / khoảng trắng của 107 ký tự Code 128 (0–102 dữ liệu, 103–105 Start A/B/C, 106 Stop)
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100; // chuyển sang bộ B khi đang ở bộ C
const STOP = 106;

/** Mã có in được bằng Code 128 B/C không (ASCII in được, không khoảng trắng đầu/cuối). */
export function isEncodable(code: string): boolean {
  return code.length > 0 && code.length <= 64 && /^[\x20-\x7e]+$/.test(code);
}

/** Dãy giá trị ký tự Code 128 (gồm start, checksum, stop). */
export function code128Values(code: string): number[] {
  if (!isEncodable(code)) throw new Error(`Mã "${code}" không in được thành mã vạch.`);
  const values: number[] = [];
  if (/^\d+$/.test(code) && code.length >= 4) {
    values.push(START_C);
    const even = code.length - (code.length % 2);
    for (let i = 0; i < even; i += 2) values.push(Number(code.slice(i, i + 2)));
    if (even < code.length) {
      values.push(CODE_B);
      values.push(code.charCodeAt(even) - 32);
    }
  } else {
    values.push(START_B);
    for (const ch of code) values.push(ch.charCodeAt(0) - 32);
  }
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103, STOP);
  return values;
}

/** SVG mã vạch (thanh đen trên nền trắng, có vùng trống 10 module hai bên). */
export function code128Svg(code: string, opts: { height?: number; module?: number } = {}): string {
  const unit = opts.module ?? 1;
  const height = opts.height ?? 40;
  const quiet = 10;
  let x = quiet;
  const bars: string[] = [];
  for (const v of code128Values(code)) {
    const widths = PATTERNS[v];
    for (let i = 0; i < widths.length; i++) {
      const w = Number(widths[i]);
      if (i % 2 === 0) bars.push(`<rect x="${x * unit}" y="0" width="${w * unit}" height="${height}"/>`);
      x += w;
    }
  }
  const width = (x + quiet) * unit;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="#fff"/><g fill="#000">${bars.join("")}</g></svg>`;
}

// ---------------------------------------------------------------------------
// Tem in
// ---------------------------------------------------------------------------
export type LabelSize = "50x30" | "40x25" | "35x22" | "a4-65";

export const LABEL_SIZES: Record<LabelSize, { label: string; w: number; h: number; sheet?: boolean }> = {
  "50x30": { label: "Tem cuộn 50 × 30 mm", w: 50, h: 30 },
  "40x25": { label: "Tem cuộn 40 × 25 mm", w: 40, h: 25 },
  "35x22": { label: "Tem cuộn 35 × 22 mm", w: 35, h: 22 },
  "a4-65": { label: "Giấy A4 decal 65 tem (38 × 21 mm)", w: 38.1, h: 21.2, sheet: true },
};

export interface LabelItem {
  name: string;
  price: number;
  code: string;
  copies: number;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML in tem: tem cuộn = mỗi tem một trang; A4 = lưới 5 × 13. */
export function labelsHtml(items: LabelItem[], size: LabelSize, opts: { shopName?: string; showPrice?: boolean } = {}): string {
  const s = LABEL_SIZES[size];
  const showPrice = opts.showPrice ?? true;
  const one = (it: LabelItem) => `
    <div class="label">
      ${opts.shopName ? `<div class="shop">${esc(opts.shopName)}</div>` : ""}
      <div class="name">${esc(it.name)}</div>
      ${showPrice ? `<div class="price">${Math.round(it.price).toLocaleString("vi-VN")}đ</div>` : ""}
      <div class="bars">${code128Svg(it.code)}</div>
      <div class="code">${esc(it.code)}</div>
    </div>`;
  const labels = items.flatMap((it) => Array.from({ length: Math.max(0, Math.floor(it.copies)) }, () => one(it))).join("");
  const page = s.sheet
    ? `@page { size: A4; margin: 10.7mm 4.7mm; }
       body { display: grid; grid-template-columns: repeat(5, ${s.w}mm); grid-auto-rows: ${s.h}mm; column-gap: 2.5mm; }`
    : `@page { size: ${s.w}mm ${s.h}mm; margin: 0; }
       .label { page-break-after: always; break-after: page; }`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>In tem mã vạch</title>
<style>
  ${page}
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
  .label { width: ${s.w}mm; height: ${s.h}mm; padding: 1.2mm 2mm; overflow: hidden;
           display: flex; flex-direction: column; align-items: center; justify-content: space-between; text-align: center; }
  .shop { font-size: 6pt; text-transform: uppercase; letter-spacing: .3pt; }
  .name { font-size: ${s.h < 25 ? 6.5 : 7.5}pt; line-height: 1.15; max-height: 2.3em; overflow: hidden; width: 100%; }
  .price { font-size: ${s.h < 25 ? 9 : 11}pt; font-weight: bold; }
  .bars { width: 100%; flex: 1; min-height: 6mm; max-height: ${s.h < 25 ? 8 : 11}mm; }
  .bars svg { width: 100%; height: 100%; display: block; }
  .code { font-family: "Courier New", monospace; font-size: 6.5pt; letter-spacing: .5pt; }
</style></head>
<body>${labels}</body></html>`;
}
