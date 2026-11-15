/**
 * In hợp đồng thuê (A4) và phiếu tất toán (K80) — docs/rental-design.md §6.
 * Dữ liệu lấy từ rental_contract_detail + thông tin quán (getBranchProfile).
 * In qua printHtmlSilent (iFrame ngầm, cùng cơ chế in hóa đơn K80).
 */
import { printHtmlSilent } from "@/utils/printer";
import type { BranchProfile } from "@/utils/rpc";
import {
  CHARGE_LABELS, PAY_METHOD_LABELS, RATE_UNIT_LABELS,
  type ContractDetail,
} from "@/utils/rental";

export type ShopInfo = BranchProfile & { organization_name: string };

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (n: number | null | undefined) => `${Math.round(Number(n || 0)).toLocaleString("vi-VN")} đ`;

const dt = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("vi-VN", {
        hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric",
      })
    : "—";

const shopName = (s: ShopInfo) => s.receipt_name || s.organization_name || "Cửa hàng cho thuê";

/** Điều khoản mặc định in trên hợp đồng. */
export const DEFAULT_RENTAL_TERMS = [
  "Bên thuê kiểm tra tình trạng đồ khi nhận. Sau khi ký, đồ được xem là nhận đủ và nguyên vẹn như mô tả.",
  "Tiền thuê tính theo thời gian thực tế từ lúc nhận đến lúc trả. Trả sau giờ hẹn bị tính thêm phí trả trễ theo bảng giá.",
  "Muốn gia hạn, bên thuê báo cửa hàng trước giờ hẹn trả; gia hạn chỉ được khi đồ chưa có người đặt.",
  "Đồ hư hỏng bồi thường theo mức thiệt hại thực tế; đồ bị mất bồi thường theo giá trị món ghi trong hợp đồng.",
  "Tiền cọc được trừ vào tiền thuê và các khoản phí khi tất toán; phần còn lại hoàn trả bên thuê.",
  "Giấy tờ giữ lại được trả cho bên thuê khi tất toán hợp đồng.",
];

const BASE_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: "Times New Roman", Times, serif; color: #000; margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  .right { text-align: right; } .center { text-align: center; } .bold { font-weight: bold; }
`;

// ---------------------------------------------------------------------------
// Hợp đồng thuê — A4
// ---------------------------------------------------------------------------
export function buildRentalContractHTML(d: ContractDetail, shop: ShopInfo, terms: string[] = DEFAULT_RENTAL_TERMS): string {
  const c = d.contract;
  const cu = d.customer;
  const lines = d.lines.filter((l) => l.status !== "cancelled");
  const depositReceived = d.balance.deposit_received;
  const depositExpected = lines.reduce((s, l) => s + l.deposit * l.quantity, 0);

  const rows = lines.map((l, i) => `
    <tr>
      <td class="center">${i + 1}</td>
      <td>${esc(l.item_name)}</td>
      <td class="center">${l.unit_code ? esc(l.unit_code) : `SL ${l.quantity}`}</td>
      <td class="center">${dt(l.checked_out_at ?? l.start)}</td>
      <td class="center">${l.end ? dt(l.end) : "Tính giờ"}</td>
      <td class="right">${money(l.rate_price)}/${esc(RATE_UNIT_LABELS[l.rate_unit])}</td>
      <td class="right">${money(l.replacement_value)}</td>
    </tr>`).join("");

  const collateral = d.collateral.length
    ? `<ul>${d.collateral.map((g) => `<li>${esc(g.kind)}${g.description ? ` — ${esc(g.description)}` : ""}${g.returned_at ? ` (đã trả ${dt(g.returned_at)})` : ""}</li>`).join("")}</ul>`
    : `<p>Không giữ giấy tờ.</p>`;

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><title>Hợp đồng ${esc(c.code)}</title>
<style>
  ${BASE_STYLE}
  @page { size: A4; margin: 15mm 15mm 18mm; }
  body { font-size: 13px; line-height: 1.45; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #000; padding-bottom: 6px; }
  .head h2 { margin: 0; font-size: 16px; text-transform: uppercase; }
  .head p { margin: 1px 0; font-size: 12px; }
  h1 { text-align: center; font-size: 19px; margin: 14px 0 2px; text-transform: uppercase; }
  .sub { text-align: center; margin: 0 0 12px; font-size: 12px; }
  h3 { font-size: 13px; margin: 12px 0 4px; text-transform: uppercase; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .parties p { margin: 1px 0; }
  .items th, .items td { border: 1px solid #000; padding: 4px 5px; font-size: 12px; vertical-align: top; }
  .items th { background: #eee; }
  ul, ol { margin: 4px 0; padding-left: 20px; }
  .money p { margin: 2px 0; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; text-align: center; margin-top: 28px; }
  .sign p { margin: 0; } .sign .hint { font-style: italic; font-size: 11px; }
  .sign .space { height: 70px; }
</style></head>
<body>
  <div class="head">
    <div>
      <h2>${esc(shopName(shop))}</h2>
      ${shop.receipt_tagline ? `<p>${esc(shop.receipt_tagline)}</p>` : ""}
      ${shop.address ? `<p>Địa chỉ: ${esc(shop.address)}</p>` : ""}
      ${shop.phone ? `<p>Điện thoại: ${esc(shop.phone)}</p>` : ""}
    </div>
    <div class="right"><p>Số: <b>${esc(c.code)}</b></p><p>Ngày lập: ${dt(c.created_at)}</p></div>
  </div>

  <h1>Hợp đồng thuê đồ</h1>
  <p class="sub">${c.status === "reserved" ? "Đặt trước" : "Giao đồ"} · Thời gian thuê dự kiến: ${dt(c.planned_start)} → ${c.planned_end ? dt(c.planned_end) : "tính giờ"}</p>

  <div class="parties">
    <div>
      <h3>Bên cho thuê (Bên A)</h3>
      <p><b>${esc(shopName(shop))}</b></p>
      ${shop.address ? `<p>Địa chỉ: ${esc(shop.address)}</p>` : ""}
      ${shop.phone ? `<p>Điện thoại: ${esc(shop.phone)}</p>` : ""}
    </div>
    <div>
      <h3>Bên thuê (Bên B)</h3>
      <p><b>${esc(cu.name)}</b></p>
      <p>Điện thoại: ${esc(cu.phone)}</p>
      ${cu.id_number ? `<p>${esc(cu.id_type || "Giấy tờ")}: ${esc(cu.id_number)}</p>` : ""}
      ${cu.address ? `<p>Địa chỉ: ${esc(cu.address)}</p>` : ""}
    </div>
  </div>

  <h3>1. Đồ cho thuê</h3>
  <table class="items">
    <thead><tr>
      <th style="width:28px">STT</th><th>Tên món</th><th>Mã / SL</th><th>Nhận</th><th>Hẹn trả</th><th>Đơn giá</th><th>Giá trị món</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h3>2. Tiền cọc và giấy tờ giữ lại</h3>
  <div class="money">
    <p>Tiền cọc theo món: <b>${money(depositExpected)}</b></p>
    <p>Bên B đã đặt cọc: <b>${money(depositReceived)}</b>${d.deposits.filter((x) => x.type === "received").map((x) => x.method ? ` (${esc(PAY_METHOD_LABELS[x.method])})` : "").join("")}</p>
  </div>
  ${collateral}

  <h3>3. Điều khoản</h3>
  <ol>${terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
  ${c.notes ? `<p><b>Ghi chú:</b> ${esc(c.notes)}</p>` : ""}

  <div class="sign">
    <div><p class="bold">BÊN CHO THUÊ</p><p class="hint">(Ký, ghi rõ họ tên)</p><div class="space"></div></div>
    <div><p class="bold">BÊN THUÊ</p><p class="hint">(Ký, ghi rõ họ tên)</p><div class="space"></div><p>${esc(cu.name)}</p></div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Phiếu tất toán — K80
// ---------------------------------------------------------------------------
export function buildSettlementReceiptHTML(d: ContractDetail, shop: ShopInfo): string {
  const c = d.contract;
  const b = d.balance;
  const lines = d.lines.filter((l) => l.status !== "cancelled");

  const lineRows = lines.map((l) => `
    <div class="line">
      <div class="bold">${esc(l.item_name)} ${l.unit_code ? `· ${esc(l.unit_code)}` : `× ${l.quantity}`}</div>
      <div class="small">${dt(l.checked_out_at ?? l.start)} → ${dt(l.returned_at)}${l.return_condition && !l.return_condition.startsWith("ok") ? ` · ${esc(l.return_condition)}` : ""}</div>
    </div>`).join("");

  const chargeRows = d.charges.map((ch) => `
    <tr><td>${esc(CHARGE_LABELS[ch.type])}${ch.reason ? `<div class="small">${esc(ch.reason)}</div>` : ""}</td>
        <td class="right">${money(ch.amount)}</td></tr>`).join("");

  const paymentRows = d.payments.map((p) => `
    <div class="row"><span>Khách trả (${esc(PAY_METHOD_LABELS[p.method])})</span><span>${money(p.amount)}</span></div>`).join("");

  const collateral = d.collateral.length
    ? `<div class="divider"></div><div class="small">Đã trả giấy tờ: ${d.collateral.map((g) => esc(g.kind)).join(", ")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><title>Tất toán ${esc(c.code)}</title>
<style>
  ${BASE_STYLE}
  @page { size: 80mm auto; margin: 0; }
  body { font-family: 'Courier New', Courier, monospace; width: 76mm; margin: 0 auto; padding: 5px; font-size: 12px; }
  .header { text-align: center; }
  .header h2 { margin: 0; font-size: 16px; text-transform: uppercase; }
  .header p { margin: 2px 0; font-size: 11px; }
  .divider { border-top: 1px dashed #000; margin: 6px 0; }
  .small { font-size: 10.5px; }
  .line { padding: 2px 0; }
  td { padding: 2px 0; font-size: 11px; vertical-align: top; }
  .row { display: flex; justify-content: space-between; padding: 1px 0; }
  .total { font-size: 14px; font-weight: bold; }
  .footer { text-align: center; margin-top: 10px; font-size: 11px; font-style: italic; }
</style></head>
<body>
  <div class="header">
    <h2>${esc(shopName(shop))}</h2>
    ${shop.address ? `<p>${esc(shop.address)}</p>` : ""}
    ${shop.phone ? `<p>SĐT: ${esc(shop.phone)}</p>` : ""}
    <div class="divider"></div>
    <p class="bold">PHIẾU TẤT TOÁN HỢP ĐỒNG THUÊ</p>
    <p>Số HĐ: ${esc(c.code)}</p>
    <p>Ngày: ${dt(c.closed_at ?? c.returned_at)}</p>
    <p>Khách: ${esc(d.customer.name)} · ${esc(d.customer.phone)}</p>
  </div>
  <div class="divider"></div>
  ${lineRows}
  <div class="divider"></div>
  <table>${chargeRows}</table>
  <div class="divider"></div>
  <div class="row total"><span>TỔNG PHÍ:</span><span>${money(b.charges)}</span></div>
  <div class="row"><span>Cọc đã nhận</span><span>${money(b.deposit_received)}</span></div>
  ${b.deposit_applied ? `<div class="row"><span>Cọc trừ vào phí</span><span>-${money(b.deposit_applied)}</span></div>` : ""}
  ${paymentRows}
  ${b.deposit_refunded ? `<div class="row bold"><span>Hoàn cọc cho khách</span><span>${money(b.deposit_refunded)}</span></div>` : ""}
  ${b.deposit_forfeited ? `<div class="row"><span>Cọc bị giữ</span><span>${money(b.deposit_forfeited)}</span></div>` : ""}
  ${b.due > 0 ? `<div class="row bold"><span>Còn phải trả</span><span>${money(b.due)}</span></div>` : ""}
  ${collateral}
  <div class="divider"></div>
  <div class="footer"><p>${esc(shop.receipt_footer || "Cảm ơn quý khách!")}</p></div>
</body></html>`;
}

export function printRentalContract(d: ContractDetail, shop: ShopInfo) {
  printHtmlSilent(buildRentalContractHTML(d, shop));
}

export function printSettlementReceipt(d: ContractDetail, shop: ShopInfo) {
  printHtmlSilent(buildSettlementReceiptHTML(d, shop));
}
