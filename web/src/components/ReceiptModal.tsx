"use client";

import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Printer, X } from "lucide-react";
import { normalizeVietnameseText } from "@/utils/text";
import { BranchProfile, getBranchProfile } from "@/utils/rpc";

interface ReceiptItem {
  product_name: string;
  quantity: number;
  price: number;
  /** Món tặng: in "Tặng", không tính tiền */
  comp?: boolean;
  comp_value?: number;
}

export interface ReceiptData {
  id: number;
  date: string;
  customer_name?: string;
  total_amount: number;
  discount_amount: number;
  final_amount: number;
  payment_method: string;
  items: ReceiptItem[];
}

interface ReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: ReceiptData | null;
}

/** Thông tin quán in trên bill — lấy từ trang "Thông tin quán" (bảng branches). */
export interface ReceiptStore {
  name: string;
  tagline: string;
  address: string;
  landmark: string;
  phone: string;
  logo: string;
  thanks: string[];
  slogan: string;
}

export function receiptStoreInfo(p?: Partial<BranchProfile> & { organization_name?: string }): ReceiptStore {
  const footer = (p?.receipt_footer || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    name: p?.receipt_name || p?.organization_name || "",
    tagline: p?.receipt_tagline || "",
    address: p?.address || "",
    landmark: p?.receipt_landmark || "",
    phone: p?.phone || "",
    logo: p?.logo_url || "",
    thanks: footer.length ? footer : ["Cảm ơn quý khách. Hẹn gặp lại!"],
    slogan: p?.receipt_slogan || "",
  };
}

const money = (value: number) => `${Math.round(Number(value) || 0).toLocaleString("vi-VN")}đ`;

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const formatDate = (value: string) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * CSS dùng chung cho xem trước và bản in (khổ giấy nhiệt 80mm).
 * Mọi class có tiền tố .rc- và chỉ có hiệu lực trong .rc → không đụng Tailwind.
 */
export const RECEIPT_CSS = `
.rc { width: 72mm; max-width: 100%; margin: 0 auto; background: #fff; color: #000;
  font-family: "Segoe UI", Roboto, Arial, sans-serif; font-size: 12px; line-height: 1.35; }
.rc * { box-sizing: border-box; }
.rc-center { text-align: center; }
.rc-logo { display: block; width: 30mm; height: 30mm; object-fit: contain; margin: 0 auto 4px; }
.rc-name { font-size: 20px; font-weight: 800; letter-spacing: .5px; margin: 0; }
.rc-tag { font-size: 11px; font-weight: 700; letter-spacing: 2px; margin: 1px 0 4px; }
.rc-muted { font-size: 11px; margin: 1px 0; }
.rc-title { font-size: 14px; font-weight: 800; letter-spacing: 1px; margin: 0 0 6px; }
.rc-hr { border: 0; border-top: 1px dashed #000; margin: 8px 0; }
.rc-hr2 { border: 0; border-top: 3px double #000; margin: 8px 0; }
.rc-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.rc-row > :last-child { text-align: right; white-space: nowrap; }
.rc-meta { font-size: 11px; }
.rc-meta .rc-row { padding: 1px 0; }
.rc-item { padding: 4px 0; }
.rc-item + .rc-item { border-top: 1px dotted #999; }
.rc-item-name { font-weight: 700; word-break: break-word; }
.rc-item-sub { font-size: 11px; color: #222; }
.rc-sum .rc-row { padding: 1px 0; }
.rc-total { font-size: 17px; font-weight: 800; padding-top: 2px; }
.rc-thanks { font-size: 11px; font-style: italic; margin: 1px 0; }
.rc-slogan { font-size: 13px; font-weight: 800; margin-top: 6px; }
`;

export function buildReceiptHtml(order: ReceiptData, store: ReceiptStore) {
  const items = order.items
    .map((item) => {
      const name = escapeHtml(normalizeVietnameseText(item.product_name));
      return `
        <div class="rc-item">
          <div class="rc-item-name">${name}</div>
          <div class="rc-row rc-item-sub">
            ${item.comp
              ? `<span>${item.quantity} x ${money(item.comp_value || 0)} · <b>TẶNG</b></span><span>0đ</span>`
              : `<span>${item.quantity} x ${money(item.price)}</span><span>${money(item.price * item.quantity)}</span>`}
          </div>
        </div>`;
    })
    .join("");

  const discount =
    order.discount_amount > 0
      ? `<div class="rc-row"><span>Giảm giá</span><span>-${money(order.discount_amount)}</span></div>`
      : "";

  // Dòng nào để trống trong cài đặt thì bỏ hẳn, không in dòng rỗng
  const line = (cls: string, text: string) => (text ? `<p class="${cls}">${escapeHtml(text)}</p>` : "");
  const logo = /^(https:\/\/|\/)/i.test(store.logo)
    ? `<img class="rc-logo" src="${escapeHtml(store.logo)}" alt="" onerror="this.style.display='none'" />`
    : "";
  const header = `
      <div class="rc-center">
        ${logo}
        ${line("rc-name", store.name)}
        ${line("rc-tag", store.tagline)}
        ${line("rc-muted", store.address)}
        ${line("rc-muted", store.landmark)}
        ${store.phone ? `<p class="rc-muted">Hotline: <b>${escapeHtml(store.phone)}</b></p>` : ""}
      </div>`;

  return `
    <div class="rc">
      ${header}

      <hr class="rc-hr" />
      <p class="rc-title rc-center">HÓA ĐƠN BÁN HÀNG</p>
      <div class="rc-meta">
        <div class="rc-row"><span>Số HĐ</span><b>#${escapeHtml(order.id)}</b></div>
        <div class="rc-row"><span>Thời gian</span><span>${escapeHtml(formatDate(order.date))}</span></div>
        <div class="rc-row"><span>Khách hàng</span><span>${escapeHtml(normalizeVietnameseText(order.customer_name || "Khách vãng lai"))}</span></div>
        <div class="rc-row"><span>Thanh toán</span><span>${escapeHtml(normalizeVietnameseText(order.payment_method || ""))}</span></div>
      </div>

      <hr class="rc-hr" />
      ${items}
      <hr class="rc-hr" />

      <div class="rc-sum">
        <div class="rc-row"><span>Tạm tính</span><span>${money(order.total_amount)}</span></div>
        ${discount}
      </div>
      <hr class="rc-hr2" />
      <div class="rc-row rc-total"><span>TỔNG CỘNG</span><span>${money(order.final_amount)}</span></div>
      <hr class="rc-hr2" />

      <div class="rc-center">
        ${store.thanks.map((line) => `<p class="rc-thanks">${escapeHtml(line)}</p>`).join("")}
        ${store.slogan ? `<p class="rc-slogan">${escapeHtml(store.slogan)} ♥</p>` : ""}
      </div>
    </div>`;
}

export default function ReceiptModal({ isOpen, onClose, order }: ReceiptModalProps) {
  const { data: profile } = useQuery({ queryKey: ["branchProfile"], queryFn: getBranchProfile, enabled: isOpen });
  const html = useMemo(() => (order ? buildReceiptHtml(order, receiptStoreInfo(profile)) : ""), [order, profile]);

  if (!isOpen || !order) return null;

  const handlePrint = () => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("style", "position:absolute;width:0;height:0;left:-1000px;top:-1000px;border:0;");
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) return;

    doc.open();
    doc.write(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Hóa đơn #${escapeHtml(order.id)}</title>
          <base href="${window.location.origin}/" />
          <style>
            @page { size: 80mm auto; margin: 0; }
            html, body { margin: 0; padding: 0; background: #fff; }
            body { padding: 3mm 4mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .rc-logo { filter: grayscale(1) contrast(1.2); }
            ${RECEIPT_CSS}
          </style>
        </head>
        <body>${html}</body>
      </html>`);
    doc.close();

    // Chờ logo tải xong (hoặc lỗi) rồi mới in, để logo không bị trống trên giấy
    const print = () => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => iframe.remove(), 1000);
    };
    const img = doc.querySelector("img");
    if (img && !img.complete) {
      img.addEventListener("load", print, { once: true });
      img.addEventListener("error", print, { once: true });
    } else {
      print();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-950/40 shrink-0">
          <span className="font-bold text-slate-200 flex items-center space-x-2">
            <Printer className="w-5 h-5 text-indigo-400" />
            <span>Xem trước hóa đơn</span>
          </span>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Đóng">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Bill: cùng HTML/CSS với bản in. items-start để tờ bill cao theo nội dung. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-slate-950/20 flex items-start justify-center">
          <style>{RECEIPT_CSS}</style>
          <div
            className="shrink-0 bg-white rounded shadow-lg px-4 py-5"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 grid grid-cols-3 gap-3 shrink-0">
          <button
            onClick={onClose}
            className="py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-300 font-semibold rounded-xl transition-all text-xs"
          >
            Đóng
          </button>
          <button
            onClick={onClose}
            className="py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl transition-all shadow-md shadow-emerald-600/10 text-xs flex items-center justify-center space-x-1.5"
          >
            <Check className="w-4.5 h-4.5" />
            <span>OK</span>
          </button>
          <button
            onClick={handlePrint}
            className="py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-all shadow-md shadow-indigo-600/10 text-xs flex items-center justify-center space-x-1.5"
          >
            <Printer className="w-4.5 h-4.5" />
            <span>In bill</span>
          </button>
        </div>
      </div>
    </div>
  );
}
