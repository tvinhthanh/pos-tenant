"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus, Store, X } from "lucide-react";
import { createShop } from "@/utils/api";
import { errorText } from "@/components/Toaster";
import {
  BUSINESS_TYPE_LABELS, SHOP_ROLE_LABELS, normalizeSubdomain, switchShop,
  type BusinessType, type MyShop,
} from "@/utils/shop";

interface ShopSwitcherProps {
  shops: MyShop[];
  activeBranchId: number;
  canCreate: boolean;
}

export default function ShopSwitcher({ shops, activeBranchId, canCreate }: ShopSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = shops.find((s) => s.branch_id === activeBranchId);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!active) return null;
  // Một shop và không được tạo thêm → chỉ hiện tên, không cần menu.
  const interactive = shops.length > 1 || canCreate;

  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        type="button"
        onClick={() => interactive && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex max-w-full sm:max-w-[14rem] items-center gap-2 rounded-xl border border-slate-850 px-3 py-1.5 text-left text-xs text-slate-200 ${
          interactive ? "hover:bg-slate-900" : "cursor-default"
        }`}
      >
        <Store className="h-4 w-4 shrink-0 text-indigo-400" />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{active.name}</span>
          <span className="block truncate text-[10px] text-slate-500">
            {BUSINESS_TYPE_LABELS[active.business_type]} · {SHOP_ROLE_LABELS[active.role]}
          </span>
        </span>
        {interactive && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
      </button>

      {open && (
        <div className="absolute left-0 z-40 mt-2 w-72 overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-2xl">
          <ul role="listbox" aria-label="Chọn shop" className="max-h-72 overflow-y-auto py-1">
            {shops.map((shop) => {
              const selected = shop.branch_id === activeBranchId;
              return (
                <li key={shop.branch_id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={!shop.is_active}
                    onClick={() => (selected ? setOpen(false) : switchShop(shop.branch_id))}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-slate-900 disabled:opacity-40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-slate-100">{shop.name}</span>
                      <span className="block truncate text-[10px] text-slate-500">
                        {BUSINESS_TYPE_LABELS[shop.business_type]} · {SHOP_ROLE_LABELS[shop.role]}
                        {!shop.is_active && " · đã khóa"}
                      </span>
                    </span>
                    {selected && <Check className="h-4 w-4 shrink-0 text-emerald-400" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {canCreate && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              className="flex w-full items-center gap-2 border-t border-slate-800 px-3 py-2.5 text-xs font-semibold text-indigo-300 hover:bg-slate-900"
            >
              <Plus className="h-4 w-4" /> Tạo shop mới
            </button>
          )}
        </div>
      )}

      {/* Portal ra body: Header dùng backdrop-filter nên mọi con position:fixed
          bị neo theo Header (bị cắt) thay vì theo màn hình. */}
      {creating && createPortal(<CreateShopDialog onClose={() => setCreating(false)} />, document.body)}
    </div>
  );
}

function CreateShopDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("fnb");
  const [subdomain, setSubdomain] = useState("");
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const effectiveSubdomain = subdomainTouched ? subdomain : normalizeSubdomain(name);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const shop = await createShop({
        name: name.trim(),
        business_type: businessType,
        subdomain: effectiveSubdomain || null,
        address,
        phone,
      });
      switchShop(shop.branch_id);
    } catch (err) {
      setError(errorText(err, "Không tạo được shop."));
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-shop-title"
    >
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 id="create-shop-title" className="text-base font-bold text-slate-100">Tạo shop mới</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="rounded-lg p-1 text-slate-500 hover:text-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">{error}</p>}

        <label className="block text-xs text-slate-400">
          Tên shop
          <input
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>

        <fieldset>
          <legend className="text-xs text-slate-400">Nghiệp vụ</legend>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {(Object.keys(BUSINESS_TYPE_LABELS) as BusinessType[]).map((type) => (
              <label
                key={type}
                className={`cursor-pointer rounded-lg border px-2 py-2 text-center text-xs ${
                  businessType === type
                    ? "border-indigo-500 bg-indigo-500/10 font-semibold text-indigo-500"
                    : "border-slate-800 text-slate-400 hover:border-slate-700"
                }`}
              >
                <input
                  type="radio"
                  name="business_type"
                  value={type}
                  checked={businessType === type}
                  onChange={() => setBusinessType(type)}
                  className="sr-only"
                />
                {BUSINESS_TYPE_LABELS[type]}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Không đổi được sau khi shop đã có giao dịch.</p>
        </fieldset>

        <label className="block text-xs text-slate-400">
          Subdomain website
          <input
            value={effectiveSubdomain}
            onChange={(e) => {
              setSubdomainTouched(true);
              setSubdomain(normalizeSubdomain(e.target.value));
            }}
            placeholder="vd: ga-ran-okbee"
            className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
          <span className="mt-1 block text-[11px] text-slate-500">3–40 ký tự a-z, 0-9, dấu gạch ngang. Để trống nếu chưa cần website.</span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400">
            Địa chỉ
            <input value={address} onChange={(e) => setAddress(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none" />
          </label>
          <label className="block text-xs text-slate-400">
            Số điện thoại
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none" />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-slate-400 hover:text-slate-100">Hủy</button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Đang tạo…" : "Tạo shop"}
          </button>
        </div>
      </form>
    </div>
  );
}
