"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import api from "@/utils/api";
import { CASH_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/utils/enums";
import {
  Package, Import, Settings, Plus, ClipboardList,
  Coins, User, AlertCircle, Save, X, Edit, Trash2
} from "lucide-react";
import { toast } from "@/components/Toaster";

export default function Inventory() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"stock" | "import" | "recipe">("stock");
  
  // Modals UI States
  const [showAddIngModal, setShowAddIngModal] = useState(false);
  const [ingName, setIngName] = useState("");
  const [ingUnit, setIngUnit] = useState("g");
  const [ingMinStock, setIngMinStock] = useState(1000);
  const [ingStock, setIngStock] = useState(0);
  const [ingCost, setIngCost] = useState(0);

  // Import Goods States
  const [importSupplierId, setImportSupplierId] = useState<number | "">("");
  const [importItems, setImportItems] = useState<{ ingredient_id: number; quantity: number; unit_price: number }[]>([]);
  const [importPaidAmount, setImportPaidAmount] = useState(0);
  const [importPaymentMethod, setImportPaymentMethod] = useState<PaymentMethod>("bank_transfer");

  // Recipe edit states
  const [editingProduct, setEditingProduct] = useState<any | null>(null);
  const [recipeEdits, setRecipeEdits] = useState<{ ingredient_id: number; quantity: number }[]>([]);

  // 1. Fetch ingredients
  const { data: ingredients } = useQuery({
    queryKey: ["ingredients"],
    queryFn: async () => {
      const res = await api.get("/api/v1/inventory/ingredients");
      return res.data;
    }
  });

  // 2. Fetch suppliers
  const { data: suppliers } = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const res = await api.get("/api/v1/suppliers");
      return res.data;
    }
  });

  // 3. Fetch products
  const { data: products } = useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const res = await api.get("/api/v1/pos/products");
      return res.data;
    }
  });

  // Mutations
  const addIngMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await api.post("/api/v1/inventory/ingredients", payload);
      return res.data;
    },
    onSuccess: () => {
      setShowAddIngModal(false);
      setIngName("");
      queryClient.invalidateQueries({ queryKey: ["ingredients"] });
    }
  });

  const importMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await api.post("/api/v1/inventory/imports", payload);
      return res.data;
    },
    onSuccess: () => {
      setImportItems([]);
      setImportPaidAmount(0);
      setImportSupplierId("");
      queryClient.invalidateQueries({ queryKey: ["ingredients"] });
      queryClient.invalidateQueries({ queryKey: ["cashbookBalance"] });
      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      toast.success("Nhập kho hàng thành công!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Nhập kho thất bại!");
    }
  });

  const saveRecipeMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await api.patch(`/api/v1/pos/products/${editingProduct.id}`, {
        recipe: payload
      });
      return res.data;
    },
    onSuccess: () => {
      setEditingProduct(null);
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Cập nhật định lượng công thức thành công!");
    }
  });

  const handleAddIng = (e: React.FormEvent) => {
    e.preventDefault();
    addIngMutation.mutate({
      name: ingName,
      unit: ingUnit,
      min_stock: ingMinStock,
      stock: ingStock,
      cost_price: ingCost
    });
  };

  const handleImportSubmit = () => {
    if (!importSupplierId || importItems.length === 0) return;
    const totalImportAmount = importItems.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    importMutation.mutate({
      supplier_id: Number(importSupplierId),
      items: importItems,
      paid_amount: importPaidAmount,
      payment_method: importPaymentMethod
    });
  };

  const addImportItem = (ingredientId: number) => {
    if (importItems.find(item => item.ingredient_id === ingredientId)) return;
    setImportItems(prev => [...prev, { ingredient_id: ingredientId, quantity: 10, unit_price: 1000 }]);
  };

  const updateImportItem = (ingredientId: number, field: "quantity" | "unit_price", value: number) => {
    setImportItems(prev =>
      prev.map(item =>
        item.ingredient_id === ingredientId ? { ...item, [field]: value } : item
      )
    );
  };

  const removeImportItem = (ingredientId: number) => {
    setImportItems(prev => prev.filter(item => item.ingredient_id !== ingredientId));
  };

  // Recipe edit helpers
  const handleEditRecipeClick = (product: any) => {
    setEditingProduct(product);
    setRecipeEdits((product.recipe || []).map((r: any) => ({ ingredient_id: r.ingredient_id, quantity: r.quantity })));
  };

  const addRecipeIngredient = (ingredientId: number) => {
    if (recipeEdits.find(item => item.ingredient_id === ingredientId)) return;
    setRecipeEdits(prev => [...prev, { ingredient_id: ingredientId, quantity: 10 }]);
  };

  const updateRecipeQty = (ingredientId: number, qty: number) => {
    setRecipeEdits(prev =>
      prev.map(item =>
        item.ingredient_id === ingredientId ? { ...item, quantity: qty } : item
      )
    );
  };

  const removeRecipeIngredient = (ingredientId: number) => {
    setRecipeEdits(prev => prev.filter(item => item.ingredient_id !== ingredientId));
  };

  return (
    <div className="space-y-8">
            
            {/* Header */}
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Kho Hàng & Định Lượng</h1>
                <p className="text-slate-500 text-xs mt-0.5">Quản lý định lượng sản phẩm, theo dõi tồn kho và nhập hàng tính giá vốn</p>
              </div>
              
              <div className="flex space-x-2">
                <button
                  onClick={() => setActiveTab("stock")}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    activeTab === "stock"
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <Package className="w-4 h-4" />
                  <span>Tồn kho nguyên liệu</span>
                </button>
                <button
                  onClick={() => setActiveTab("import")}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    activeTab === "import"
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <Import className="w-4 h-4" />
                  <span>Phiếu Nhập kho</span>
                </button>
                <button
                  onClick={() => setActiveTab("recipe")}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    activeTab === "recipe"
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <Settings className="w-4 h-4" />
                  <span>Công thức (Recipes)</span>
                </button>
              </div>
            </div>

            {/* TAB 1: TỒN KHO NGUYÊN LIỆU */}
            {activeTab === "stock" && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-lg font-bold text-slate-100">Danh sách Nguyên liệu</h2>
                  <button 
                    onClick={() => setShowAddIngModal(true)}
                    className="flex items-center space-x-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Thêm Nguyên liệu</span>
                  </button>
                </div>

                <div className="glass-panel rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-900/60 text-slate-400 font-semibold text-xs border-b border-slate-800">
                        <th className="p-4 pl-6">Mã NL</th>
                        <th className="p-4">Tên nguyên liệu</th>
                        <th className="p-4">Đơn vị</th>
                        <th className="p-4 text-right">Tồn kho hiện tại</th>
                        <th className="p-4 text-right">Giá vốn bình quân</th>
                        <th className="p-4 text-right">Tồn tối thiểu</th>
                        <th className="p-4 text-center">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-sm text-slate-300">
                      {ingredients?.map((ing: any) => {
                        const isLow = ing.stock <= ing.min_stock;
                        return (
                          <tr key={ing.id} className="hover:bg-slate-900/20 transition-colors">
                            <td className="p-4 pl-6 text-xs text-slate-500 font-mono">#{ing.id}</td>
                            <td className="p-4 font-semibold text-slate-100">{ing.name}</td>
                            <td className="p-4 text-xs">{ing.unit}</td>
                            <td className={`p-4 text-right font-bold ${isLow ? "text-rose-400" : "text-slate-200"}`}>{ing.stock}{ing.unit}</td>
                            <td className="p-4 text-right font-semibold text-emerald-400">{ing.cost_price.toLocaleString()}đ</td>
                            <td className="p-4 text-right text-slate-400">{ing.min_stock}{ing.unit}</td>
                            <td className="p-4 text-center">
                              {isLow ? (
                                <span className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] px-2 py-0.5 rounded font-bold">Cần nhập kho</span>
                              ) : (
                                <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] px-2 py-0.5 rounded font-bold">An toàn</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 2: PHIẾU NHẬP KHO */}
            {activeTab === "import" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Form tạo phiếu */}
                <div className="lg:col-span-2 glass-panel p-6 rounded-2xl space-y-6">
                  <h2 className="text-lg font-bold text-slate-100 flex items-center space-x-2">
                    <ClipboardList className="w-5 h-5 text-indigo-400" />
                    <span>Lập Phiếu Nhập Hàng</span>
                  </h2>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Nhà cung cấp</label>
                      <select
                        value={importSupplierId}
                        onChange={(e) => setImportSupplierId(e.target.value ? Number(e.target.value) : "")}
                        className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">-- Chọn nhà cung cấp --</option>
                        {suppliers?.map((s: any) => (
                          <option key={s.id} value={s.id}>{s.name} (Nợ: {s.total_debt.toLocaleString()}đ)</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Chọn Nguyên liệu thêm</label>
                      <select
                        onChange={(e) => {
                          if (e.target.value) {
                            addImportItem(Number(e.target.value));
                            e.target.value = "";
                          }
                        }}
                        className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">-- Click chọn nguyên liệu nhập --</option>
                        {ingredients?.map((ing: any) => (
                          <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Lưới các items nhập kho */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Danh mục hàng nhập</h3>
                    {importItems.length === 0 ? (
                      <div className="text-center py-8 text-xs text-slate-600 bg-slate-900/30 border border-dashed border-slate-800 rounded-xl">
                        Chưa chọn nguyên liệu nhập kho
                      </div>
                    ) : (
                      importItems.map(item => {
                        const ing = ingredients?.find((i: any) => i.id === item.ingredient_id);
                        return (
                          <div key={item.ingredient_id} className="flex justify-between items-center p-3 bg-slate-900/50 border border-slate-800/80 rounded-xl gap-4">
                            <div className="flex-1">
                              <span className="text-sm font-semibold text-slate-200 block">{ing?.name}</span>
                              <span className="text-[10px] text-slate-500">Đơn vị: {ing?.unit}</span>
                            </div>
                            
                            <div className="flex items-center space-x-3 text-xs">
                              <div>
                                <label className="text-[9px] text-slate-500 block mb-0.5 uppercase">Số lượng</label>
                                <input
                                  type="number"
                                  value={item.quantity}
                                  onChange={(e) => updateImportItem(item.ingredient_id, "quantity", Number(e.target.value))}
                                  className="w-20 px-2 py-1 bg-slate-950 border border-slate-850 rounded text-center text-white"
                                />
                              </div>
                              <div>
                                <label className="text-[9px] text-slate-500 block mb-0.5 uppercase">Đơn giá (đ/{ing?.unit})</label>
                                <input
                                  type="number"
                                  value={item.unit_price}
                                  onChange={(e) => updateImportItem(item.ingredient_id, "unit_price", Number(e.target.value))}
                                  className="w-24 px-2 py-1 bg-slate-950 border border-slate-850 rounded text-right text-white"
                                />
                              </div>
                              <button 
                                onClick={() => removeImportItem(item.ingredient_id)}
                                className="text-rose-400 hover:bg-rose-500/10 p-2 rounded mt-3"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Tổng kết & Thanh toán phiếu nhập */}
                <div className="glass-panel p-6 rounded-2xl h-fit space-y-6">
                  <h2 className="text-lg font-bold text-slate-100 flex items-center space-x-2">
                    <Coins className="w-5 h-5 text-indigo-400" />
                    <span>Thanh Toán Nhập Kho</span>
                  </h2>

                  <div className="space-y-3.5 text-xs text-slate-400">
                    <div className="flex justify-between">
                      <span>Tổng tiền hàng nhập</span>
                      <span className="font-semibold text-slate-200">
                        {importItems.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0).toLocaleString("vi-VN")}đ
                      </span>
                    </div>
                    
                    <div className="border-t border-slate-850 pt-3">
                      <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Số tiền thanh toán trước</label>
                      <input 
                        type="number" 
                        value={importPaidAmount}
                        onChange={(e) => setImportPaidAmount(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-emerald-400 font-bold"
                      />
                      <span className="text-[10px] text-slate-500 mt-1 block">
                        Số nợ gối đầu: {(importItems.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0) - importPaidAmount).toLocaleString()}đ
                      </span>
                    </div>

                    <div className="border-t border-slate-850 pt-3">
                      <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Phương thức (nếu trả ngay)</label>
                      <div className="grid grid-cols-2 gap-2 text-[10px]">
                        {CASH_PAYMENT_METHODS.map(m => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setImportPaymentMethod(m)}
                            className={`py-1.5 rounded-lg border font-semibold ${
                              importPaymentMethod === m
                                ? "bg-indigo-600/90 text-white border-indigo-600"
                                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                            }`}
                          >
                            {PAYMENT_METHOD_LABELS[m]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleImportSubmit}
                    disabled={importMutation.isPending || !importSupplierId || importItems.length === 0}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-900 disabled:text-slate-600 text-white font-bold py-3.5 rounded-xl transition-all text-xs flex justify-center items-center"
                  >
                    Thực hiện Nhập Kho
                  </button>
                </div>
              </div>
            )}

            {/* TAB 3: ĐỊNH LƯỢNG RECIPE */}
            {activeTab === "recipe" && (
              <div className="space-y-6">
                <h2 className="text-lg font-bold text-slate-100">Định lượng Công thức thực đơn</h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {products?.map((product: any) => (
                    <div key={product.id} className="glass-panel p-5 rounded-2xl flex flex-col justify-between">
                      <div>
                        <div className="flex justify-between items-center mb-3">
                          <span className="text-sm font-bold text-slate-100">{product.name}</span>
                          <span className="text-xs text-indigo-400 font-semibold bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">{product.category}</span>
                        </div>
                        
                        <div className="space-y-2 mt-4">
                          <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Nguyên liệu cấu thành:</span>
                          {(product.recipe || []).length === 0 ? (
                            <span className="text-xs text-slate-500 italic block">Chưa thiết lập định lượng</span>
                          ) : (
                            (product.recipe || []).map((r: any) => (
                              <div key={r.id} className="flex justify-between text-xs text-slate-400">
                                <span>- {r.ingredient_name}</span>
                                <span>{r.quantity} {r.ingredient_unit}</span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="flex justify-between items-center mt-6 pt-4 border-t border-slate-900">
                        <span className="text-xs text-emerald-400 font-bold">Giá vốn: {product.cost_price?.toLocaleString()}đ</span>
                        <button
                          onClick={() => handleEditRecipeClick(product)}
                          className="flex items-center space-x-1 text-xs text-indigo-400 hover:text-indigo-300 font-semibold"
                        >
                          <Edit className="w-3.5 h-3.5" />
                          <span>Cập nhật công thức</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}


        
        {/* ADD INGREDIENT MODAL */}
        {showAddIngModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative">
              <button 
                onClick={() => setShowAddIngModal(false)}
                className="absolute top-4 right-4 text-slate-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
              
              <h3 className="text-lg font-bold text-slate-100 mb-4">Thêm Nguyên liệu mới</h3>
              <form onSubmit={handleAddIng} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Tên nguyên liệu</label>
                  <input
                    type="text"
                    value={ingName}
                    onChange={(e) => setIngName(e.target.value)}
                    placeholder="Ví dụ: Bột matcha"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Đơn vị tính</label>
                    <select
                      value={ingUnit}
                      onChange={(e) => setIngUnit(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="g">g (Gam)</option>
                      <option value="ml">ml (Mililit)</option>
                      <option value="cái">Cái</option>
                      <option value="lon">Lon</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Định mức tối thiểu</label>
                    <input
                      type="number"
                      value={ingMinStock}
                      onChange={(e) => setIngMinStock(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Tồn kho ban đầu</label>
                    <input
                      type="number"
                      value={ingStock}
                      onChange={(e) => setIngStock(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Giá vốn khởi điểm (đ/đơn vị)</label>
                    <input
                      type="number"
                      value={ingCost}
                      onChange={(e) => setIngCost(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                      required
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={addIngMutation.isPending}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-xl transition-all text-xs flex justify-center items-center"
                >
                  Tạo Nguyên Liệu
                </button>
              </form>
            </div>
          </div>
        )}

        {/* EDIT RECIPE MODAL */}
        {editingProduct && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative max-h-[90vh] flex flex-col justify-between">
              <button 
                onClick={() => setEditingProduct(null)}
                className="absolute top-4 right-4 text-slate-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="mb-4">
                <h3 className="text-lg font-bold text-slate-100">Định lượng: {editingProduct.name}</h3>
                <p className="text-xs text-slate-500 mt-0.5">Thêm/bớt nguyên liệu và số lượng cần dùng làm ra sản phẩm</p>
              </div>

              {/* Thêm nhanh nguyên liệu */}
              <div className="mb-4">
                <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Thêm nguyên liệu vào công thức</label>
                <select
                  onChange={(e) => {
                    if (e.target.value) {
                      addRecipeIngredient(Number(e.target.value));
                      e.target.value = "";
                    }
                  }}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- Chọn nguyên liệu muốn thêm --</option>
                  {ingredients?.map((ing: any) => (
                    <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
                  ))}
                </select>
              </div>

              {/* Lưới các items công thức */}
              <div className="flex-1 overflow-y-auto space-y-3 mb-6 pr-1">
                {recipeEdits.length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-600 bg-slate-900/30 border border-dashed border-slate-800 rounded-xl">
                    Chưa cấu hình công thức cho sản phẩm này.
                  </div>
                ) : (
                  recipeEdits.map(item => {
                    const ing = ingredients?.find((i: any) => i.id === item.ingredient_id);
                    return (
                      <div key={item.ingredient_id} className="flex justify-between items-center p-3 bg-slate-950 border border-slate-850 rounded-xl">
                        <span className="text-sm font-semibold text-slate-200">{ing?.name} ({ing?.unit})</span>
                        <div className="flex items-center space-x-2">
                          <input
                            type="number"
                            value={item.quantity}
                            onChange={(e) => updateRecipeQty(item.ingredient_id, Number(e.target.value))}
                            className="w-20 px-2 py-1 bg-slate-900 border border-slate-800 rounded text-center text-white text-xs"
                          />
                          <button 
                            onClick={() => removeRecipeIngredient(item.ingredient_id)}
                            className="text-rose-400 p-2 hover:bg-rose-500/10 rounded"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <button
                onClick={() => saveRecipeMutation.mutate(recipeEdits)}
                disabled={saveRecipeMutation.isPending}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl transition-all text-xs flex justify-center items-center shrink-0"
              >
                <Save className="w-4 h-4 mr-1.5" />
                <span>Lưu thay đổi Công thức</span>
              </button>
            </div>
          </div>
        )}

    </div>
  );
}
