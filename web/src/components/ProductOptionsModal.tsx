"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, X } from "lucide-react";

import {
  groupRuleLabel,
  groupSelectionError,
  unitPriceOf,
  type OptionGroup,
  type SelectedOption,
} from "@/utils/productOptions";

export interface OptionPickerProduct {
  id: number;
  name: string;
  price: number;
  option_groups: OptionGroup[];
}

/** Chỉ render khi đang mở, kèm key={product.id} để mỗi món bắt đầu từ lựa chọn mặc định. */
interface Props {
  product: OptionPickerProduct;
  onClose: () => void;
  onConfirm: (selection: { options: SelectedOption[]; quantity: number }) => void;
}

const money = (value: number) => `${value.toLocaleString("vi-VN")}đ`;

const defaultSelection = (product: OptionPickerProduct) => {
  const picked: Record<number, number[]> = {};
  for (const group of product.option_groups) {
    picked[group.id] = group.option_items
      .filter((item) => item.is_default)
      .slice(0, group.max_select)
      .map((item) => item.id);
  }
  return picked;
};

export default function ProductOptionsModal({ product, onClose, onConfirm }: Props) {
  const [picked, setPicked] = useState<Record<number, number[]>>(() => defaultSelection(product));
  const [quantity, setQuantity] = useState(1);
  const [showErrors, setShowErrors] = useState(false);

  // onClose thường là arrow inline → giữ qua ref để không gắn lại listener mỗi lần render
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedOptions = useMemo<SelectedOption[]>(() => {
    return product.option_groups.flatMap((group) =>
      group.option_items
        .filter((item) => (picked[group.id] || []).includes(item.id))
        .map((item) => ({
          option_item_id: item.id,
          group_name: group.name,
          option_name: item.name,
          price_delta: Number(item.price_delta || 0),
        }))
    );
  }, [product, picked]);

  const unitPrice = unitPriceOf(product.price, selectedOptions);
  const errors = product.option_groups
    .map((group) => ({ group, error: groupSelectionError(group, (picked[group.id] || []).length) }))
    .filter((row) => row.error);

  const toggle = (group: OptionGroup, itemId: number) => {
    setPicked((prev) => {
      const current = prev[group.id] || [];
      if (current.includes(itemId)) {
        // Nhóm bắt buộc chọn 1: bấm lại mục đang chọn thì giữ nguyên (giống radio)
        if (group.max_select === 1 && group.min_select === 1) return prev;
        return { ...prev, [group.id]: current.filter((id) => id !== itemId) };
      }
      if (group.max_select === 1) return { ...prev, [group.id]: [itemId] };
      if (current.length >= group.max_select) return prev;
      return { ...prev, [group.id]: [...current, itemId] };
    });
  };

  const handleConfirm = () => {
    if (errors.length > 0) {
      setShowErrors(true);
      return;
    }
    onConfirm({ options: selectedOptions, quantity });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="option-modal-title"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-3xl border border-slate-800 bg-slate-950 shadow-2xl sm:max-w-md sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <h2 id="option-modal-title" className="truncate text-lg font-bold text-slate-100">{product.name}</h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">Giá gốc {money(product.price)}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-900 hover:text-slate-100"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {product.option_groups.map((group) => {
            const current = picked[group.id] || [];
            const error = showErrors ? groupSelectionError(group, current.length) : null;
            const isFull = group.max_select > 1 && current.length >= group.max_select;
            return (
              <section key={group.id}>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-bold text-slate-200">{group.name}</h3>
                  <span className={`text-[11px] font-semibold ${error ? "text-rose-400" : "text-slate-500"}`}>
                    {error || groupRuleLabel(group)}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {group.option_items.map((item) => {
                    const isPicked = current.includes(item.id);
                    const isDisabled = !isPicked && isFull;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => toggle(group, item.id)}
                        disabled={isDisabled}
                        aria-pressed={isPicked}
                        className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left text-sm transition-colors disabled:opacity-40 ${
                          isPicked
                            ? "border-indigo-500 bg-indigo-500/10 text-slate-100"
                            : "border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center border ${
                              group.max_select === 1 ? "rounded-full" : "rounded-md"
                            } ${isPicked ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-600"}`}
                          >
                            {isPicked && <Check className="h-3 w-3" strokeWidth={3} />}
                          </span>
                          <span className="truncate font-semibold">{item.name}</span>
                        </span>
                        <span className={`shrink-0 text-xs font-bold ${item.price_delta > 0 ? "text-emerald-400" : "text-slate-500"}`}>
                          {item.price_delta > 0 ? `+${money(item.price_delta)}` : "Miễn phí"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-slate-800 bg-slate-950 px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <div className="flex items-center rounded-xl border border-slate-800 bg-slate-900">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="flex h-11 w-10 items-center justify-center text-slate-400 hover:text-slate-100"
              aria-label="Giảm số lượng"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-7 text-center text-sm font-bold text-slate-100">{quantity}</span>
            <button
              type="button"
              onClick={() => setQuantity((q) => q + 1)}
              className="flex h-11 w-10 items-center justify-center text-slate-400 hover:text-slate-100"
              aria-label="Tăng số lượng"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex h-11 flex-1 items-center justify-between rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white transition-colors hover:bg-indigo-500"
          >
            <span>Thêm vào giỏ</span>
            <span>{money(unitPrice * quantity)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
