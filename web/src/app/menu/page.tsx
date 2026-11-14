"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronDown, Edit, Layers, Plus, Save, Tag, Trash2, UtensilsCrossed, X } from "lucide-react";

import api from "@/utils/api";
import { toast } from "@/components/Toaster";
import { changeProductPrice, listPriceRequests, resolvePriceRequest } from "@/utils/rpc";
import { groupRuleLabel } from "@/utils/productOptions";

// ---------------------------------------------------------------------------
// Kiểu dữ liệu form
// ---------------------------------------------------------------------------

interface RecipeRow { ingredient_id: number; quantity: number }

interface ItemDraft {
  key: string;
  id: number | null;
  name: string;
  price_delta: number;
  is_default: boolean;
  recipe: RecipeRow[];
}

interface GroupDraft {
  id: number | null;
  name: string;
  min_select: number;
  max_select: number;
  sort_order: number;
  items: ItemDraft[];
  product_ids: number[];
}

type RuleMode = "required_one" | "optional_one" | "multi";

const ruleModeOf = (group: Pick<GroupDraft, "min_select" | "max_select">): RuleMode => {
  if (group.max_select > 1) return "multi";
  return group.min_select >= 1 ? "required_one" : "optional_one";
};

const RULE_MODES: { value: RuleMode; label: string; hint: string }[] = [
  { value: "required_one", label: "Bắt buộc chọn 1", hint: "VD: Size" },
  { value: "optional_one", label: "Chọn 1 hoặc không", hint: "VD: Sốt" },
  { value: "multi", label: "Chọn nhiều", hint: "VD: Topping" },
];

let keySeq = 0;
const newKey = () => `k${++keySeq}`;
const blankItem = (): ItemDraft => ({ key: newKey(), id: null, name: "", price_delta: 0, is_default: false, recipe: [] });

const money = (value: number) => `${Number(value || 0).toLocaleString("vi-VN")}đ`;

const inputClass =
  "w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500";
const labelClass = "text-xs font-semibold text-slate-400 block mb-1.5";

const errorMessage = (err: any, fallback: string) => err?.response?.data?.detail || err?.message || fallback;

// ---------------------------------------------------------------------------

export default function MenuOptionsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<GroupDraft | null>(null);
  const [formError, setFormError] = useState("");
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [newProduct, setNewProduct] = useState({ name: "", price: 0, category: "" });
  const [productError, setProductError] = useState("");
  const [openRecipeKey, setOpenRecipeKey] = useState<string | null>(null);
  const [priceEdit, setPriceEdit] = useState<{ id: number; name: string; oldPrice: number; price: number; reason: string } | null>(null);
  const [priceError, setPriceError] = useState("");

  const { data: me } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => (await api.get("/api/v1/auth/me")).data,
  });
  const isOwner = me?.role === "owner" || me?.role === "superadmin";
  const canManagePrice = isOwner || me?.role === "manager";

  // Yêu cầu đổi giá do quản lý gửi, chờ chủ quán duyệt
  const { data: priceRequests = [] } = useQuery({
    queryKey: ["priceRequests"],
    queryFn: listPriceRequests,
    enabled: canManagePrice,
  });

  const changePriceMutation = useMutation({
    mutationFn: (p: { id: number; price: number; reason: string }) => changeProductPrice(p.id, p.price, p.reason),
    onSuccess: (result) => {
      setPriceEdit(null);
      setPriceError("");
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["priceRequests"] });
      toast.success(result.applied ? "Đã đổi giá món." : "Đã gửi yêu cầu đổi giá, chờ chủ quán duyệt.");
    },
    onError: (err: any) => setPriceError(errorMessage(err, "Đổi giá thất bại.")),
  });

  const resolveMutation = useMutation({
    mutationFn: (p: { id: number; approved: boolean }) => resolvePriceRequest(p.id, p.approved),
    onSuccess: (_d, p) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["priceRequests"] });
      toast.success(p.approved ? "Đã duyệt, giá mới đã áp dụng." : "Đã từ chối yêu cầu đổi giá.");
    },
    onError: (err: any) => toast.error(errorMessage(err, "Xử lý yêu cầu thất bại.")),
  });

  const { data: products = [] } = useQuery({
    queryKey: ["products"],
    queryFn: async () => (await api.get("/api/v1/pos/products")).data,
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ["optionGroups"],
    queryFn: async () => (await api.get("/api/v1/menu/option-groups")).data,
  });

  const { data: ingredients = [] } = useQuery({
    queryKey: ["ingredients"],
    queryFn: async () => (await api.get("/api/v1/inventory/ingredients")).data,
  });

  const refreshMenu = () => {
    queryClient.invalidateQueries({ queryKey: ["optionGroups"] });
    queryClient.invalidateQueries({ queryKey: ["products"] });
  };

  const saveGroupMutation = useMutation({
    mutationFn: async (payload: any) => (await api.post("/api/v1/menu/option-groups", payload)).data,
    onSuccess: () => {
      setEditing(null);
      setFormError("");
      refreshMenu();
    },
    onError: (err: any) => setFormError(errorMessage(err, "Lưu nhóm tùy chọn thất bại.")),
  });

  const createProductMutation = useMutation({
    mutationFn: async (payload: any) => (await api.post("/api/v1/pos/products", payload)).data,
    onSuccess: () => {
      setShowAddProduct(false);
      setNewProduct({ name: "", price: 0, category: "" });
      setProductError("");
      refreshMenu();
    },
    onError: (err: any) => setProductError(errorMessage(err, "Tạo món thất bại.")),
  });

  const categories: string[] = Array.from(new Set<string>(products.map((p: any) => p.category).filter(Boolean)));

  // ---- Mở form ------------------------------------------------------------
  const openNewGroup = () => {
    setFormError("");
    setOpenRecipeKey(null);
    setEditing({
      id: null,
      name: "",
      min_select: 1,
      max_select: 1,
      sort_order: groups.length,
      items: [blankItem(), blankItem()],
      product_ids: [],
    });
  };

  const openEditGroup = (group: any) => {
    setFormError("");
    setOpenRecipeKey(null);
    setEditing({
      id: group.id,
      name: group.name,
      min_select: group.min_select,
      max_select: group.max_select,
      sort_order: group.sort_order,
      product_ids: group.product_ids || [],
      items: (group.option_items || []).map((item: any) => ({
        key: newKey(),
        id: item.id,
        name: item.name,
        price_delta: Number(item.price_delta || 0),
        is_default: Boolean(item.is_default),
        recipe: item.recipe || [],
      })),
    });
  };

  // ---- Sửa form -----------------------------------------------------------
  const patchEditing = (patch: Partial<GroupDraft>) => setEditing((prev) => (prev ? { ...prev, ...patch } : prev));

  const patchItem = (key: string, patch: Partial<ItemDraft>) =>
    setEditing((prev) =>
      prev ? { ...prev, items: prev.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) } : prev
    );

  // Giữ "mặc định" hợp lệ khi giảm số được chọn: chỉ giữ N mục mặc định đầu tiên
  const trimDefaults = (items: ItemDraft[], max: number) => {
    let kept = 0;
    return items.map((item) => {
      if (!item.is_default) return item;
      kept += 1;
      return kept <= max ? item : { ...item, is_default: false };
    });
  };

  const setRuleMode = (mode: RuleMode) => {
    if (!editing) return;
    const range =
      mode === "required_one" ? { min_select: 1, max_select: 1 }
      : mode === "optional_one" ? { min_select: 0, max_select: 1 }
      // Chọn nhiều: mặc định cho chọn tất cả, chủ quán tự hạ "Tối đa" nếu cần
      : { min_select: 0, max_select: Math.max(2, editing.items.length) };
    patchEditing({ ...range, items: trimDefaults(editing.items, range.max_select) });
  };

  // Ô Tối thiểu / Tối đa ở chế độ chọn nhiều: luôn giữ min ≤ max và max ≥ 2
  const setMinSelect = (value: number) => {
    if (!editing) return;
    const min = Math.max(0, Math.floor(value) || 0);
    patchEditing({ min_select: min, max_select: Math.max(editing.max_select, min, 2) });
  };

  const setMaxSelect = (value: number) => {
    if (!editing) return;
    const max = Math.max(2, Math.floor(value) || 2);
    patchEditing({
      max_select: max,
      min_select: Math.min(editing.min_select, max),
      items: trimDefaults(editing.items, max),
    });
  };

  // Ở chế độ chọn nhiều mà "Tối đa" đang = tất cả, thêm lựa chọn thì nới theo
  const addItem = () => {
    if (!editing) return;
    const allowAll = editing.max_select > 1 && editing.max_select >= editing.items.length;
    patchEditing({
      items: [...editing.items, blankItem()],
      ...(allowAll ? { max_select: editing.items.length + 1 } : {}),
    });
  };

  const toggleDefault = (key: string) => {
    if (!editing) return;
    const single = editing.max_select === 1;
    const target = editing.items.find((item) => item.key === key);
    const defaults = editing.items.filter((item) => item.is_default).length;
    if (!single && target && !target.is_default && defaults >= editing.max_select) {
      setFormError(`Chỉ được đặt tối đa ${editing.max_select} lựa chọn mặc định.`);
      return;
    }
    setFormError("");
    setEditing({
      ...editing,
      items: editing.items.map((item) => {
        if (item.key === key) return { ...item, is_default: !item.is_default };
        return single ? { ...item, is_default: false } : item;
      }),
    });
  };

  const toggleProduct = (productId: number) => {
    if (!editing) return;
    const has = editing.product_ids.includes(productId);
    patchEditing({
      product_ids: has ? editing.product_ids.filter((id) => id !== productId) : [...editing.product_ids, productId],
    });
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    if (!editing.name.trim()) return setFormError("Nhập tên nhóm, ví dụ: Size, Sốt, Topping.");
    // Dòng trống hoàn toàn thì bỏ qua; dòng có giá/định lượng mà thiếu tên thì báo
    const isBlank = (item: ItemDraft) => !item.name.trim() && !Number(item.price_delta) && item.recipe.length === 0;
    if (editing.items.some((item) => !item.name.trim() && !isBlank(item))) {
      return setFormError("Có lựa chọn đã nhập giá hoặc định lượng nhưng chưa có tên.");
    }
    const items = editing.items.filter((item) => !isBlank(item));
    if (items.length === 0) return setFormError("Thêm ít nhất 1 lựa chọn.");
    const badRecipe = items.find((item) => item.recipe.some((row) => !(Number(row.quantity) > 0)));
    if (badRecipe) {
      setOpenRecipeKey(badRecipe.key);
      return setFormError(`"${badRecipe.name}": nhập số lượng trừ kho lớn hơn 0 hoặc bỏ nguyên liệu đó.`);
    }
    if (editing.min_select > items.length) {
      return setFormError(`Bắt buộc chọn ${editing.min_select} mục nhưng nhóm chỉ có ${items.length} lựa chọn.`);
    }
    if (items.some((item) => Number(item.price_delta) < 0)) {
      return setFormError("Giá cộng thêm không được âm.");
    }
    setFormError("");
    saveGroupMutation.mutate({
      id: editing.id,
      name: editing.name.trim(),
      min_select: editing.min_select,
      max_select: editing.max_select,
      sort_order: editing.sort_order,
      product_ids: editing.product_ids,
      items: items.map((item, index) => ({
        id: item.id,
        name: item.name.trim(),
        price_delta: Math.round(Number(item.price_delta) || 0),
        is_default: item.is_default,
        sort_order: index,
        recipe: item.recipe,
      })),
    });
  };

  const handleArchive = () => {
    if (!editing?.id) return;
    if (!confirm(`Ngừng dùng nhóm "${editing.name}"? Nhóm sẽ được gỡ khỏi mọi món. Hóa đơn cũ không bị ảnh hưởng.`)) return;
    saveGroupMutation.mutate({ id: editing.id, is_active: false });
  };

  const handleCreateProduct = (event: React.FormEvent) => {
    event.preventDefault();
    if (!newProduct.name.trim()) return setProductError("Nhập tên món.");
    createProductMutation.mutate(newProduct);
  };

  const groupsById = new Map<number, any>(groups.map((group: any) => [group.id, group]));

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Thực đơn &amp; Tùy chọn</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Tạo nhóm tùy chọn như Size, Sốt, Topping — mỗi lựa chọn có giá cộng thêm — rồi gắn vào món.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => { setProductError(""); setShowAddProduct(true); }}
            className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-slate-200 transition-colors hover:border-slate-700"
          >
            <UtensilsCrossed className="h-3.5 w-3.5" />
            <span>Thêm món</span>
          </button>
          <button
            onClick={openNewGroup}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-white shadow transition-colors hover:bg-indigo-500"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Thêm nhóm tùy chọn</span>
          </button>
        </div>
      </div>

      {/* NHÓM TÙY CHỌN */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
          <Layers className="h-4 w-4" /> Nhóm tùy chọn
        </h2>
        {groupsLoading ? (
          <div className="h-24 animate-pulse rounded-2xl bg-slate-900/50" />
        ) : groups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 px-6 py-10 text-center">
            <p className="text-sm font-semibold text-slate-300">Chưa có nhóm tùy chọn nào</p>
            <p className="mt-1 text-xs text-slate-500">
              Ví dụ cho Gà viên: nhóm <b>Size</b> (Vừa +0đ, Lớn +10.000đ) và nhóm <b>Sốt</b> (Phô mai +5.000đ, Tương ớt +0đ).
            </p>
            <button
              onClick={openNewGroup}
              className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              Tạo nhóm đầu tiên
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((group: any) => (
              <div key={group.id} className="glass-panel flex flex-col rounded-2xl p-5">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-bold text-slate-100">{group.name}</h3>
                    <p className="text-[11px] font-semibold text-indigo-400">{groupRuleLabel(group)}</p>
                  </div>
                  <button
                    onClick={() => openEditGroup(group)}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-300 hover:border-slate-700 hover:text-slate-100"
                  >
                    <Edit className="h-3 w-3" /> Sửa
                  </button>
                </div>
                <ul className="mb-4 space-y-1">
                  {group.option_items.map((item: any) => (
                    <li key={item.id} className="flex justify-between gap-3 text-xs">
                      <span className="truncate text-slate-300">
                        {item.name}
                        {item.is_default && <span className="ml-1.5 text-[10px] text-slate-500">(mặc định)</span>}
                        {item.recipe?.length > 0 && <span className="ml-1.5 text-[10px] text-amber-400/80">+ định lượng</span>}
                      </span>
                      <span className={`shrink-0 font-semibold ${item.price_delta > 0 ? "text-emerald-400" : "text-slate-500"}`}>
                        {item.price_delta > 0 ? `+${money(item.price_delta)}` : "+0đ"}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto border-t border-slate-800/80 pt-3 text-[11px] text-slate-500">
                  {group.product_ids.length === 0 ? (
                    <span className="text-amber-400/90">Chưa gắn vào món nào</span>
                  ) : (
                    <>Dùng cho: <span className="text-slate-300">
                      {products.filter((p: any) => group.product_ids.includes(p.id)).map((p: any) => p.name).join(", ")}
                    </span></>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* MÓN */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
          <UtensilsCrossed className="h-4 w-4" /> Món đang bán
        </h2>
        <div className="glass-panel overflow-x-auto rounded-2xl">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-semibold">Món</th>
                <th className="px-5 py-3 font-semibold">Danh mục</th>
                <th className="px-5 py-3 text-right font-semibold">Giá gốc</th>
                <th className="px-5 py-3 font-semibold">Tùy chọn</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {products.length === 0 ? (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-slate-500">Chưa có món nào. Bấm “Thêm món”.</td></tr>
              ) : products.map((product: any) => (
                <tr key={product.id}>
                  <td className="px-5 py-3 font-semibold text-slate-200">{product.name}</td>
                  <td className="px-5 py-3 text-slate-400">{product.category}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{money(product.price)}</span>
                      {canManagePrice && (
                        <button
                          onClick={() => {
                            setPriceError("");
                            setPriceEdit({ id: product.id, name: product.name, oldPrice: Number(product.price), price: Number(product.price), reason: "" });
                          }}
                          className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:border-indigo-500 hover:text-indigo-500"
                          aria-label={`Đổi giá ${product.name}`}
                        >
                          <Tag className="h-3 w-3" /> Đổi giá
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {(product.option_groups || []).length === 0 ? (
                        <span className="text-slate-600">—</span>
                      ) : product.option_groups.map((group: any) => (
                        <button
                          key={group.id}
                          onClick={() => groupsById.get(group.id) && openEditGroup(groupsById.get(group.id))}
                          className="rounded-md border border-indigo-500/25 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-300 hover:border-indigo-500/60"
                        >
                          {group.name}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {isOwner
            ? "Chủ quán đổi giá là áp dụng ngay (có lưu lịch sử giá). Quản lý đổi giá sẽ chờ chủ quán duyệt."
            : "Đổi giá sẽ gửi yêu cầu để chủ quán duyệt."}{" "}
          Định lượng nguyên liệu của món sửa ở trang Kho &amp; Định lượng.
        </p>
      </section>

      {/* YÊU CẦU ĐỔI GIÁ CHỜ DUYỆT */}
      {canManagePrice && priceRequests.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-400">
            <Tag className="h-4 w-4" /> Yêu cầu đổi giá chờ duyệt ({priceRequests.length})
          </h2>
          <div className="space-y-2">
            {priceRequests.map((r) => (
              <div key={r.id} className="glass-panel flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-xs">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-200">
                    {r.product_name}: <span className="text-slate-500 line-through">{money(r.old_price)}</span>{" "}
                    → <span className="text-emerald-600 dark:text-emerald-400">{money(r.new_price)}</span>
                  </p>
                  <p className="mt-0.5 text-slate-500">
                    {r.requested_by || "Quản lý"} · {new Date(r.created_at).toLocaleString("vi-VN")}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </p>
                </div>
                {isOwner ? (
                  <div className="flex gap-2">
                    <button
                      onClick={() => resolveMutation.mutate({ id: r.id, approved: false })}
                      disabled={resolveMutation.isPending}
                      className="rounded-lg border border-slate-800 px-3 py-1.5 font-semibold text-slate-300 hover:border-rose-500 hover:text-rose-500"
                    >
                      Từ chối
                    </button>
                    <button
                      onClick={() => resolveMutation.mutate({ id: r.id, approved: true })}
                      disabled={resolveMutation.isPending}
                      className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
                    >
                      <Check className="h-3.5 w-3.5" /> Duyệt
                    </button>
                  </div>
                ) : (
                  <span className="rounded-lg bg-amber-50 px-2.5 py-1 font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">Chờ chủ quán duyệt</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* MODAL: ĐỔI GIÁ */}
      {priceEdit && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 backdrop-blur-sm sm:items-center sm:p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!(priceEdit.price >= 0) || priceEdit.price === priceEdit.oldPrice) {
                setPriceError("Nhập giá mới khác giá hiện tại.");
                return;
              }
              changePriceMutation.mutate({ id: priceEdit.id, price: priceEdit.price, reason: priceEdit.reason });
            }}
            className="w-full max-w-sm space-y-4 rounded-t-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl sm:rounded-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-100">Đổi giá món</h3>
                <p className="text-xs text-slate-500">{priceEdit.name} · đang bán {money(priceEdit.oldPrice)}</p>
              </div>
              <button type="button" onClick={() => setPriceEdit(null)} className="text-slate-500 hover:text-slate-200" aria-label="Đóng">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="new-price">Giá mới (đ)</label>
              <input
                id="new-price"
                type="number"
                inputMode="numeric"
                min={0}
                step={1000}
                autoFocus
                value={priceEdit.price}
                onChange={(e) => setPriceEdit({ ...priceEdit, price: Number(e.target.value) })}
                className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="price-reason">Lý do (không bắt buộc)</label>
              <input
                id="price-reason"
                type="text"
                value={priceEdit.reason}
                onChange={(e) => setPriceEdit({ ...priceEdit, reason: e.target.value })}
                placeholder="VD: Giá nguyên liệu tăng"
                className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            {priceError && (
              <p className="flex items-start gap-1.5 text-xs text-rose-500"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{priceError}</p>
            )}
            <button
              type="submit"
              disabled={changePriceMutation.isPending}
              className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              {changePriceMutation.isPending ? "Đang lưu…" : isOwner ? "Áp dụng giá mới" : "Gửi yêu cầu đổi giá"}
            </button>
          </form>
        </div>
      )}

      {/* MODAL: NHÓM TÙY CHỌN */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 backdrop-blur-sm sm:items-center sm:p-4">
          <form
            onSubmit={handleSave}
            className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl border border-slate-800 bg-slate-900 shadow-2xl sm:max-w-2xl sm:rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <h3 className="text-lg font-bold text-slate-100">
                {editing.id ? `Sửa nhóm: ${editing.name}` : "Nhóm tùy chọn mới"}
              </h3>
              <button type="button" onClick={() => setEditing(null)} className="text-slate-500 hover:text-slate-100" aria-label="Đóng">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              <div>
                <label className={labelClass} htmlFor="group-name">Tên nhóm</label>
                <input
                  id="group-name"
                  value={editing.name}
                  onChange={(e) => patchEditing({ name: e.target.value })}
                  placeholder="Size, Sốt, Topping, Độ cay…"
                  className={inputClass}
                  autoFocus
                />
              </div>

              <div>
                <span className={labelClass}>Khách được chọn</span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {RULE_MODES.map((mode) => {
                    const active = ruleModeOf(editing) === mode.value;
                    return (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={() => setRuleMode(mode.value)}
                        className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          active ? "border-indigo-500 bg-indigo-500/10" : "border-slate-800 bg-slate-950 hover:border-slate-700"
                        }`}
                      >
                        <span className={`block text-xs font-bold ${active ? "text-slate-100" : "text-slate-300"}`}>{mode.label}</span>
                        <span className="block text-[11px] text-slate-500">{mode.hint}</span>
                      </button>
                    );
                  })}
                </div>
                {ruleModeOf(editing) === "multi" && (
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-xs">
                    <div>
                      <label className={labelClass} htmlFor="min-select">Tối thiểu</label>
                      <input
                        id="min-select"
                        type="number"
                        min={0}
                        value={editing.min_select}
                        onChange={(e) => setMinSelect(Number(e.target.value))}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="max-select">Tối đa</label>
                      <input
                        id="max-select"
                        type="number"
                        min={2}
                        value={editing.max_select}
                        onChange={(e) => setMaxSelect(Number(e.target.value))}
                        className={inputClass}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400">Lựa chọn &amp; giá cộng thêm</span>
                  <span className="text-[11px] text-slate-500">Mặc định = được chọn sẵn trên POS</span>
                </div>
                <div className="space-y-2">
                  {editing.items.map((item) => {
                    const recipeOpen = openRecipeKey === item.key;
                    return (
                      <div key={item.key} className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                        <div className="flex items-center gap-2">
                          <input
                            value={item.name}
                            onChange={(e) => patchItem(item.key, { name: e.target.value })}
                            placeholder="Tên lựa chọn"
                            aria-label="Tên lựa chọn"
                            className={`${inputClass} flex-1`}
                          />
                          <div className="relative w-32 shrink-0">
                            <span className="pointer-events-none absolute left-3 top-2 text-sm text-slate-500">+</span>
                            <input
                              type="number"
                              min={0}
                              step={1000}
                              value={item.price_delta}
                              onChange={(e) => patchItem(item.key, { price_delta: Number(e.target.value) })}
                              aria-label="Giá cộng thêm"
                              className={`${inputClass} pl-6 pr-6 text-right`}
                            />
                            <span className="pointer-events-none absolute right-3 top-2 text-sm text-slate-500">đ</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => editing.items.length > 1 && patchEditing({ items: editing.items.filter((row) => row.key !== item.key) })}
                            disabled={editing.items.length <= 1}
                            className="shrink-0 p-1.5 text-slate-600 hover:text-rose-400 disabled:opacity-30"
                            aria-label="Xóa lựa chọn"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
                          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                            <input
                              type="checkbox"
                              checked={item.is_default}
                              onChange={() => toggleDefault(item.key)}
                              className="accent-indigo-500"
                            />
                            Mặc định
                          </label>
                          <button
                            type="button"
                            onClick={() => setOpenRecipeKey(recipeOpen ? null : item.key)}
                            className="flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-slate-100"
                          >
                            <ChevronDown className={`h-3 w-3 transition-transform ${recipeOpen ? "rotate-180" : ""}`} />
                            Trừ kho thêm{item.recipe.length > 0 ? ` (${item.recipe.length})` : ""}
                          </button>
                        </div>
                        {recipeOpen && (
                          <div className="mt-2 space-y-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
                            <p className="text-[11px] text-slate-500">
                              Nguyên liệu trừ thêm khi khách chọn mục này (VD: Lớn trừ thêm 50g gà). Để trống nếu không cần.
                            </p>
                            {item.recipe.map((row, index) => {
                              const ing = ingredients.find((i: any) => i.id === row.ingredient_id);
                              return (
                                <div key={row.ingredient_id} className="flex items-center gap-2 text-xs">
                                  <span className="flex-1 truncate text-slate-300">{ing?.name || `#${row.ingredient_id}`}</span>
                                  <input
                                    type="number"
                                    min={0}
                                    value={row.quantity}
                                    onChange={(e) => patchItem(item.key, {
                                      recipe: item.recipe.map((r, i) => (i === index ? { ...r, quantity: Number(e.target.value) } : r)),
                                    })}
                                    aria-label={`Định lượng ${ing?.name || ""}`}
                                    className="w-24 shrink-0 rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-right text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                                  />
                                  <span className="w-8 text-slate-500">{ing?.unit}</span>
                                  <button
                                    type="button"
                                    onClick={() => patchItem(item.key, { recipe: item.recipe.filter((_, i) => i !== index) })}
                                    className="p-1 text-slate-600 hover:text-rose-400"
                                    aria-label="Bỏ nguyên liệu"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              );
                            })}
                            <select
                              value=""
                              onChange={(e) => {
                                const id = Number(e.target.value);
                                if (!id || item.recipe.some((r) => r.ingredient_id === id)) return;
                                patchItem(item.key, { recipe: [...item.recipe, { ingredient_id: id, quantity: 0 }] });
                              }}
                              className={`${inputClass} py-1.5 text-xs`}
                              aria-label="Thêm nguyên liệu"
                            >
                              <option value="">+ Thêm nguyên liệu…</option>
                              {ingredients
                                .filter((ing: any) => !item.recipe.some((r) => r.ingredient_id === ing.id))
                                .map((ing: any) => (
                                  <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
                                ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={addItem}
                  className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-indigo-400 hover:text-indigo-300"
                >
                  <Plus className="h-3.5 w-3.5" /> Thêm lựa chọn
                </button>
              </div>

              <div>
                <span className={labelClass}>Áp dụng cho món</span>
                {products.length === 0 ? (
                  <p className="text-xs text-slate-500">Chưa có món nào.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {products.map((product: any) => {
                      const checked = editing.product_ids.includes(product.id);
                      return (
                        <label
                          key={product.id}
                          className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-xs transition-colors ${
                            checked ? "border-indigo-500/60 bg-indigo-500/10 text-slate-100" : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700"
                          }`}
                        >
                          <input type="checkbox" checked={checked} onChange={() => toggleProduct(product.id)} className="accent-indigo-500" />
                          <span className="flex-1 truncate font-semibold">{product.name}</span>
                          <span className="text-[11px] text-slate-500">{product.category}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3 border-t border-slate-800 bg-slate-900 px-6 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              {formError && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-semibold text-rose-500">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}
              <div className="flex gap-2">
                {editing.id && (
                  <button
                    type="button"
                    onClick={handleArchive}
                    disabled={saveGroupMutation.isPending}
                    className="rounded-xl border border-rose-500/30 px-4 py-2.5 text-xs font-semibold text-rose-500 hover:bg-rose-500/10"
                  >
                    Ngừng dùng
                  </button>
                )}
                <button
                  type="submit"
                  disabled={saveGroupMutation.isPending}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 py-2.5 text-xs font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
                >
                  <Save className="h-4 w-4" />
                  {saveGroupMutation.isPending ? "Đang lưu…" : "Lưu nhóm tùy chọn"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* MODAL: THÊM MÓN */}
      {showAddProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <form onSubmit={handleCreateProduct} className="relative w-full max-w-md space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <button type="button" onClick={() => setShowAddProduct(false)} className="absolute right-4 top-4 text-slate-500 hover:text-slate-100" aria-label="Đóng">
              <X className="h-5 w-5" />
            </button>
            <h3 className="text-lg font-bold text-slate-100">Thêm món</h3>
            <div>
              <label className={labelClass} htmlFor="product-name">Tên món</label>
              <input
                id="product-name"
                value={newProduct.name}
                onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                placeholder="VD: Gà viên"
                className={inputClass}
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass} htmlFor="product-price">Giá gốc (đ)</label>
                <input
                  id="product-price"
                  type="number"
                  min={0}
                  step={1000}
                  value={newProduct.price}
                  onChange={(e) => setNewProduct({ ...newProduct, price: Number(e.target.value) })}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="product-category">Danh mục</label>
                <input
                  id="product-category"
                  list="product-categories"
                  value={newProduct.category}
                  onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                  placeholder="VD: Ăn vặt"
                  className={inputClass}
                />
                <datalist id="product-categories">
                  {categories.map((category) => <option key={category} value={category} />)}
                </datalist>
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              Giá gốc là giá món chưa có tùy chọn (VD: size Vừa, không sốt). Phần cộng thêm đặt trong nhóm tùy chọn.
            </p>
            {productError && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-semibold text-rose-500">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{productError}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={createProductMutation.isPending}
              className="w-full rounded-xl bg-indigo-600 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              {createProductMutation.isPending ? "Đang tạo…" : "Tạo món"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
