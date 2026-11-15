"use client";

/**
 * Khách chuyển khoản bằng VietQR cho đơn online đã được shop xác nhận.
 * Thông tin tài khoản lấy qua RPC my_online_payment (chỉ chủ đơn, chỉ khi đơn chờ thanh toán).
 * Shop đối soát tay theo nội dung CK rồi bấm "đã nhận tiền" — không tự động.
 */
import React, { useCallback, useEffect, useState } from "react";
import { rpc } from "@/utils/customerAuth";
import { vnd } from "@/utils/site";
import { bankName, vietQrImageUrl } from "@/utils/vietqr";

type Payment = {
  state: "awaiting_shop" | "payable" | "paid" | "closed";
  amount: number;
  transfer_code: string;
  paid_by_transfer: boolean;
  bank_bin?: string;
  bank_account_no?: string;
  bank_account_name?: string;
};

export default function TransferQR({ requestId, compact = false }: { requestId: number; compact?: boolean }) {
  const [p, setP] = useState<Payment | null | undefined>(undefined);
  const [open, setOpen] = useState(!compact);
  const [copied, setCopied] = useState("");

  const load = useCallback(() => {
    rpc<Payment | null>("my_online_payment", { p_request_id: requestId }).then(setP).catch(() => setP(null));
  }, [requestId]);
  useEffect(() => { load(); }, [load]);

  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(""), 1500); } catch { /* trình duyệt chặn */ }
  };

  if (!p) return null;
  if (p.state === "paid") {
    return <p className="mt-2 text-sm text-emerald-700">{p.paid_by_transfer ? "Shop đã nhận tiền chuyển khoản." : "Đơn đã thanh toán."}</p>;
  }
  if (p.state === "awaiting_shop") {
    return compact ? null : <p className="mt-3 text-sm text-[var(--c-muted)]">Shop nhận chuyển khoản — mã QR hiện ở trang Tài khoản sau khi shop xác nhận đơn.</p>;
  }
  if (p.state !== "payable" || !p.bank_bin || !p.bank_account_no || !p.bank_account_name) return null;

  const info = { bank_bin: p.bank_bin, bank_account_no: p.bank_account_no, bank_account_name: p.bank_account_name,
                 amount: p.amount, transfer_code: p.transfer_code };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 text-sm font-medium text-[var(--c-primary)] hover:underline">
        Chuyển khoản {vnd(p.amount)} bằng mã QR
      </button>
    );
  }
  const row = (label: string, value: string, mono = false) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="text-[var(--c-muted)]">{label}</dt>
      <dd className="flex items-center gap-2 text-right">
        <span className={mono ? "font-mono font-semibold" : "font-medium"}>{value}</span>
        <button onClick={() => copy(label, value)} className="text-xs text-[var(--c-primary)] hover:underline">
          {copied === label ? "Đã chép" : "Chép"}
        </button>
      </dd>
    </div>
  );
  return (
    <div className="mt-4 rounded-[var(--radius)] border border-black/10 bg-white p-4 text-left text-sm text-[var(--c-text)]">
      <div className="grid items-center gap-4 sm:grid-cols-[180px_1fr]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={vietQrImageUrl(info)} alt={`Mã VietQR chuyển ${vnd(p.amount)} tới ${bankName(p.bank_bin)}`}
          width={180} height={180} className="mx-auto h-[180px] w-[180px] object-contain" loading="lazy" />
        <dl className="divide-y divide-black/10">
          {row("Ngân hàng", bankName(p.bank_bin))}
          {row("Số tài khoản", p.bank_account_no, true)}
          {row("Chủ tài khoản", p.bank_account_name)}
          {row("Số tiền", String(p.amount))}
          {row("Nội dung", p.transfer_code, true)}
        </dl>
      </div>
      <p className="mt-3 text-xs text-[var(--c-muted)]">
        Quét mã bằng app ngân hàng, giữ nguyên số tiền và nội dung <b>{p.transfer_code}</b> để shop đối chiếu.
        Shop xác nhận khi thấy tiền về; trang này tự cập nhật.
      </p>
      <button onClick={load} className="mt-2 text-xs text-[var(--c-primary)] hover:underline">Kiểm tra lại</button>
    </div>
  );
}
