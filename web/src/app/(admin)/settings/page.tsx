"use client";

import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Receipt, Save, Store } from "lucide-react";

import api from "@/utils/api";
import { toast, errorText } from "@/components/Toaster";
import {
  BANKS,
  BranchProfile,
  EMPTY_BRANCH_PROFILE,
  getBranchProfile,
  updateBranchProfile,
  vietQrUrl,
} from "@/utils/rpc";
import { buildReceiptHtml, RECEIPT_CSS, receiptStoreInfo } from "@/components/ReceiptModal";

const inputClass =
  "w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none";
const labelClass = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500";

const SAMPLE_ORDER = {
  id: 128,
  date: new Date().toISOString(),
  customer_name: "Khách vãng lai",
  payment_method: "Tiền mặt",
  total_amount: 125000,
  discount_amount: 0,
  final_amount: 125000,
  items: [
    { product_name: "Gà viên (L, Sốt kem mayo)", quantity: 1, price: 60000 },
    { product_name: "Đùi gà rán (Sốt Hàn cay)", quantity: 1, price: 40000 },
    { product_name: "Cá viên rau củ", quantity: 1, price: 10000 },
    { product_name: "Cá viên cốm", quantity: 1, price: 15000 },
  ],
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<BranchProfile>(EMPTY_BRANCH_PROFILE);
  const [customBin, setCustomBin] = useState(false);

  const { data: me } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => (await api.get("/api/v1/auth/me")).data,
  });
  const canEdit = me?.role === "owner" || me?.role === "superadmin";

  const { data: profile, isLoading } = useQuery({ queryKey: ["branchProfile"], queryFn: getBranchProfile });

  useEffect(() => {
    if (!profile) return;
    const { organization_name: _org, ...rest } = profile;
    setForm(rest);
    setCustomBin(Boolean(rest.bank_bin) && !BANKS.some((b) => b.bin === rest.bank_bin));
  }, [profile]);

  const save = useMutation({
    mutationFn: () => updateBranchProfile(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branchProfile"] });
      toast.success("Đã lưu thông tin quán.");
    },
    onError: (err) => toast.error(errorText(err, "Lưu thông tin quán thất bại.")),
  });

  const set = (k: keyof BranchProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const store = receiptStoreInfo({ ...form, organization_name: profile?.organization_name || "" });
  const previewHtml = buildReceiptHtml(SAMPLE_ORDER, store);
  const qr = vietQrUrl(form, 125000, "Thanh toan don 128");

  if (isLoading) {
    return <p className="py-10 text-center text-sm text-slate-500">Đang tải…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Thông tin quán</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            In trên hóa đơn và dùng để tạo mã QR chuyển khoản ở màn hình thanh toán.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white shadow transition-colors hover:bg-indigo-500 disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {save.isPending ? "Đang lưu…" : "Lưu thay đổi"}
          </button>
        )}
      </div>

      {!canEdit && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          Chỉ chủ quán được sửa thông tin này.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <fieldset disabled={!canEdit} className="space-y-6 min-w-0">
          <section className="glass-panel space-y-4 rounded-2xl p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
              <Store className="h-4 w-4" /> Thông tin in trên hóa đơn
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelClass} htmlFor="receipt_name">Tên quán</label>
                <input id="receipt_name" className={inputClass} value={form.receipt_name} onChange={set("receipt_name")}
                  placeholder={profile?.organization_name || "VD: OK, BÉE!"} maxLength={60} />
              </div>
              <div>
                <label className={labelClass} htmlFor="receipt_tagline">Dòng giới thiệu</label>
                <input id="receipt_tagline" className={inputClass} value={form.receipt_tagline} onChange={set("receipt_tagline")}
                  placeholder="VD: GÀ RÁN · ĂN VẶT" maxLength={60} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor="address">Địa chỉ</label>
                <input id="address" className={inputClass} value={form.address} onChange={set("address")}
                  placeholder="VD: 13/4, tổ 8, Ấp Tiền Lân, Bà Điểm, Hóc Môn" maxLength={160} />
              </div>
              <div>
                <label className={labelClass} htmlFor="receipt_landmark">Ghi chú vị trí</label>
                <input id="receipt_landmark" className={inputClass} value={form.receipt_landmark} onChange={set("receipt_landmark")}
                  placeholder="VD: (Ngã 4 Bà Điểm - Hóc Môn)" maxLength={120} />
              </div>
              <div>
                <label className={labelClass} htmlFor="phone">Hotline</label>
                <input id="phone" type="text" inputMode="tel" className={inputClass} value={form.phone} onChange={set("phone")}
                  placeholder="VD: 0793 833 936" maxLength={30} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor="receipt_footer">Lời chào cuối bill (mỗi dòng một câu)</label>
                <textarea id="receipt_footer" rows={2} className={inputClass} value={form.receipt_footer} onChange={set("receipt_footer")}
                  placeholder={"Chúc quý khách ngon miệng\nvà có trải nghiệm tuyệt vời!"} maxLength={300} />
              </div>
              <div>
                <label className={labelClass} htmlFor="receipt_slogan">Slogan</label>
                <input id="receipt_slogan" className={inputClass} value={form.receipt_slogan} onChange={set("receipt_slogan")}
                  placeholder="VD: Ăn là ghiền!" maxLength={60} />
              </div>
              <div>
                <label className={labelClass} htmlFor="logo_url">Logo (đường dẫn ảnh)</label>
                <input id="logo_url" className={inputClass} value={form.logo_url} onChange={set("logo_url")}
                  placeholder="/brand/logo.png hoặc https://…" maxLength={500} />
              </div>
            </div>
          </section>

          <section className="glass-panel space-y-4 rounded-2xl p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
              <Landmark className="h-4 w-4" /> Tài khoản nhận chuyển khoản
            </h2>
            <p className="text-xs text-slate-500">
              Khi khách chọn “Chuyển khoản”, màn hình thanh toán hiện mã VietQR đã điền sẵn số tiền — quét bằng app ngân hàng nào cũng được.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelClass} htmlFor="bank_bin">Ngân hàng</label>
                <select
                  id="bank_bin"
                  className={inputClass}
                  value={customBin ? "__other" : form.bank_bin}
                  onChange={(e) => {
                    if (e.target.value === "__other") { setCustomBin(true); return; }
                    setCustomBin(false);
                    setForm((f) => ({ ...f, bank_bin: e.target.value }));
                  }}
                >
                  <option value="">— Chưa cài —</option>
                  {BANKS.map((b) => <option key={b.bin} value={b.bin}>{b.name}</option>)}
                  <option value="__other">Ngân hàng khác (nhập mã BIN)</option>
                </select>
                {customBin && (
                  <input className={`${inputClass} mt-2`} value={form.bank_bin} onChange={set("bank_bin")}
                    placeholder="Mã BIN 6 số, VD 970436" inputMode="numeric" maxLength={6} />
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor="bank_account_no">Số tài khoản</label>
                <input id="bank_account_no" type="text" inputMode="numeric" className={inputClass} value={form.bank_account_no}
                  onChange={(e) => setForm((f) => ({ ...f, bank_account_no: e.target.value.replace(/\s+/g, "") }))} maxLength={30} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor="bank_account_name">Tên chủ tài khoản</label>
                <input id="bank_account_name" className={inputClass} value={form.bank_account_name} onChange={set("bank_account_name")}
                  placeholder="VD: NGUYEN VAN A" maxLength={60} />
              </div>
            </div>
          </section>
        </fieldset>

        <aside className="space-y-6">
          <section className="glass-panel rounded-2xl p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
              <Receipt className="h-4 w-4" /> Xem trước hóa đơn
            </h2>
            <style>{RECEIPT_CSS}</style>
            <div className="flex justify-center rounded-xl bg-slate-850 p-4">
              <div className="rounded bg-white px-3 py-4 shadow" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </section>
          <section className="glass-panel rounded-2xl p-5">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">QR chuyển khoản (thử 125.000đ)</h2>
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="Mã VietQR thử" className="mx-auto w-56 rounded-xl bg-white p-2" />
            ) : (
              <p className="text-xs text-slate-500">Chọn ngân hàng và nhập số tài khoản để tạo mã QR.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
