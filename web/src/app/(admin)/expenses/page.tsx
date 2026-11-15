"use client";

import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import api from "@/utils/api";
import { CASH_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, paymentMethodLabel, type PaymentMethod } from "@/utils/enums";
import {
  DollarSign, ClipboardList, Plus, History, Coins,
  ArrowUpRight, ArrowDownRight, Wallet, Check, AlertCircle, X
} from "lucide-react";
import { toast } from "@/components/Toaster";

export default function Expenses() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"cashbook" | "expense">("cashbook");

  // Modal states
  const [showAddExpenseModal, setShowAddExpenseModal] = useState(false);
  const [showAddCashbookModal, setShowAddCashbookModal] = useState(false);

  // Add Expense States — category_id là bigint của expense_categories, không phải mã text
  const [expCategory, setExpCategory] = useState<number | "">("");
  const [expSubCat, setExpSubCat] = useState("");
  const [expAmount, setExpAmount] = useState(0);
  const [expPayment, setExpPayment] = useState<PaymentMethod>("cash");
  const [expDesc, setExpDesc] = useState("");

  // Add Other Cashbook states (Thu khác, Chi khác)
  const [cbType, setCbType] = useState<"thu" | "chi">("thu");
  const [cbCategory, setCbCategory] = useState("Chủ góp vốn");
  const [cbAmount, setCbAmount] = useState(0);
  const [cbPayment, setCbPayment] = useState<PaymentMethod>("bank_transfer");
  const [cbDesc, setCbDesc] = useState("");

  // 1. Fetch cashbook
  const { data: cashbook } = useQuery({
    queryKey: ["cashbook"],
    queryFn: async () => {
      const res = await api.get("/api/v1/cashbook");
      return res.data;
    }
  });

  // 2. Fetch cashbook balance
  const { data: balanceData } = useQuery({
    queryKey: ["cashbookBalance"],
    queryFn: async () => {
      const res = await api.get("/api/v1/cashbook/balance");
      return res.data;
    }
  });

  // 3. Fetch expenses
  const { data: expenses } = useQuery({
    queryKey: ["expenses"],
    queryFn: async () => {
      const res = await api.get("/api/v1/expenses");
      return res.data;
    }
  });

  // 4. Fetch expense categories
  const { data: categories } = useQuery({
    queryKey: ["expenseCategories"],
    queryFn: async () => {
      const res = await api.get("/api/v1/expenses/categories");
      return res.data;
    }
  });

  // Chốt nhóm chi phí mặc định theo dữ liệu thật thay vì mã cứng "operations"
  useEffect(() => {
    if (expCategory !== "" || !categories?.length) return;
    const first = categories[0];
    setExpCategory(first.id);
    setExpSubCat(first.sub_categories?.[0] || "");
  }, [categories, expCategory]);

  // Mutations
  const addExpenseMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await api.post("/api/v1/expenses", payload);
      return res.data;
    },
    onSuccess: (data: any) => {
      setShowAddExpenseModal(false);
      setExpAmount(0);
      setExpDesc("");
      if (data?.status === "pending_approval") {
        toast.success(
          `Khoản chi vượt ngưỡng — đã gửi yêu cầu chờ ${data.required_level === "owner" ? "chủ quán" : "quản lý"} duyệt.`
        );
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["cashbook"] });
      queryClient.invalidateQueries({ queryKey: ["cashbookBalance"] });
      queryClient.invalidateQueries({ queryKey: ["financialReport"] });
      toast.success("Ghi nhận chi phí thành công!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Ghi nhận thất bại!");
    }
  });

  const addCashbookMutation = useMutation({
    // Ghi nhận trực tiếp vào sổ quỹ (áp dụng cho các hoạt động ngoài POS/Nhập hàng bình thường)
    mutationFn: async (payload: any) => {
      // Vì backend tự động log cashbook thông qua crud, chúng ta có thể sử dụng endpoint phụ hoặc tạo trực tiếp thông qua API.
      // Để tránh overengineering, chúng ta có thể nạp vốn / rút quỹ thông qua log_cashbook_entry giả định hoặc tạo endpoint tương đương.
      // Khoan, backend đã có hàm log_cashbook_entry ở crud, nhưng chưa có endpoint router trực tiếp POST cho cashbook.
      // Vậy chúng ta có thể tạo chi phí dưới dạng "Chi khác", hoặc tạo đơn hàng POS dưới dạng "Thu khác"?
      // Hoặc chúng ta có thể viết thêm API cho cashbook! Thật tuyệt vời, đó là thế mạnh của Senior Backend.
      // Để đảm bảo NextJS gọi được, lát nữa chúng ta hãy kiểm tra xem có cần bổ sung route cashbook POST hay không.
      // Hiện tại, để đơn giản và chuẩn hóa, chúng ta có thể ghi nhận Thu khác / Vốn góp thông qua API chi phí (Expense) hoặc POS.
      // Chờ đã! Hãy tạo một API để thêm trực tiếp bản ghi sổ quỹ. Hãy bổ sung endpoint này ở backend nếu cần.
      // Thực ra, chúng ta đã có API POST expenses tự tạo phiếu chi. Còn phiếu thu thì sao? Chúng ta có thể tạo một endpoint phụ cho Cashbook!
      // Hãy coi như chúng ta gửi lên API POST /api/v1/cashbook trực tiếp. Lát nữa chúng ta sẽ viết thêm route này vào backend.
      const res = await api.post("/api/v1/cashbook", payload);
      return res.data;
    },
    onSuccess: () => {
      setShowAddCashbookModal(false);
      setCbAmount(0);
      setCbDesc("");
      queryClient.invalidateQueries({ queryKey: ["cashbook"] });
      queryClient.invalidateQueries({ queryKey: ["cashbookBalance"] });
      queryClient.invalidateQueries({ queryKey: ["financialReport"] });
      toast.success("Ghi nhận sổ quỹ thành công!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Ghi nhận thất bại!");
    }
  });

  const handleAddExpenseSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (expCategory === "") {
      toast.error("Chưa có nhóm chi phí nào cho chi nhánh này.");
      return;
    }
    if (expAmount <= 0) {
      toast.error("Số tiền chi phải lớn hơn 0.");
      return;
    }
    addExpenseMutation.mutate({
      category_id: expCategory,
      sub_category: expSubCat,
      amount: expAmount,
      payment_method: expPayment,
      description: expDesc
    });
  };

  const handleAddCashbookSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (cbAmount <= 0) {
      toast.error("Số tiền phải lớn hơn 0.");
      return;
    }
    // Payload cho API POST /cashbook
    addCashbookMutation.mutate({
      type: cbType,
      category: cbCategory,
      amount: cbAmount,
      payment_method: cbPayment,
      description: cbDesc
    });
  };

  // Cập nhật các tiểu mục nhỏ tùy theo nhóm chi phí được chọn
  const getSubCategories = (): string[] => {
    const cat = categories?.find((c: any) => Number(c.id) === Number(expCategory));
    return cat?.sub_categories || [];
  };

  return (
    <div className="space-y-8">
            
            {/* Header */}
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Chi Phí & Sổ Quỹ</h1>
                <p className="text-slate-500 text-xs mt-0.5">Theo dõi dòng tiền thu chi thực tế và ghi nhận chi phí vận hành chi tiết</p>
              </div>

              <div className="flex space-x-2">
                <button
                  onClick={() => setActiveTab("cashbook")}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    activeTab === "cashbook"
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <Wallet className="w-4 h-4" />
                  <span>Sổ Quỹ Thu Chi</span>
                </button>
                <button
                  onClick={() => setActiveTab("expense")}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    activeTab === "expense"
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <History className="w-4 h-4" />
                  <span>Nhật ký chi phí (OPEX)</span>
                </button>
              </div>
            </div>

            {/* TAB 1: SỔ QUỸ THU CHI */}
            {activeTab === "cashbook" && (
              <div className="space-y-6">
                {/* Metric Summary Banner */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="glass-panel p-6 rounded-2xl flex items-center justify-between">
                    <div>
                      <span className="text-slate-400 text-xs font-semibold block uppercase">Số dư quỹ hiện tại</span>
                      <span className="text-2xl font-bold text-emerald-400 block mt-1.5">
                        {balanceData?.balance?.toLocaleString("vi-VN")}đ
                      </span>
                    </div>
                    <div className="bg-emerald-500/10 p-3 rounded-xl text-emerald-400">
                      <Wallet className="w-6 h-6" />
                    </div>
                  </div>

                  <div className="glass-panel p-6 rounded-2xl flex items-center justify-between">
                    <div>
                      <span className="text-slate-400 text-xs font-semibold block uppercase">Tổng Thu trong kỳ</span>
                      <span className="text-2xl font-bold text-indigo-400 block mt-1.5">
                        {cashbook?.filter((c: any) => c.type === "thu").reduce((s: number, c: any) => s + c.amount, 0).toLocaleString("vi-VN")}đ
                      </span>
                    </div>
                    <div className="bg-indigo-500/10 p-3 rounded-xl text-indigo-400">
                      <ArrowUpRight className="w-6 h-6" />
                    </div>
                  </div>

                  <div className="glass-panel p-6 rounded-2xl flex items-center justify-between">
                    <div>
                      <span className="text-slate-400 text-xs font-semibold block uppercase">Tổng Chi trong kỳ</span>
                      <span className="text-2xl font-bold text-rose-400 block mt-1.5">
                        {cashbook?.filter((c: any) => c.type === "chi").reduce((s: number, c: any) => s + c.amount, 0).toLocaleString("vi-VN")}đ
                      </span>
                    </div>
                    <div className="bg-rose-500/10 p-3 rounded-xl text-rose-400">
                      <ArrowDownRight className="w-6 h-6" />
                    </div>
                  </div>
                </div>

                <div className="flex justify-between items-center">
                  <h2 className="text-lg font-bold text-slate-100">Lịch sử Giao dịch Sổ Quỹ</h2>
                  <button 
                    onClick={() => setShowAddCashbookModal(true)}
                    className="flex items-center space-x-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all shadow"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Ghi nhận Thu/Chi ngoài</span>
                  </button>
                </div>

                {/* Sổ quỹ table */}
                <div className="glass-panel rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-900/60 text-slate-400 font-semibold text-xs border-b border-slate-800">
                        <th className="p-4 pl-6">Thời gian</th>
                        <th className="p-4">Phân loại</th>
                        <th className="p-4">Mục giao dịch</th>
                        <th className="p-4 text-right">Số tiền (VND)</th>
                        <th className="p-4">Hình thức</th>
                        <th className="p-4">Mô tả chi tiết</th>
                        <th className="p-4 text-right pr-6">Số dư quỹ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-sm text-slate-300">
                      {cashbook?.map((c: any) => {
                        const isThu = c.type === "thu";
                        return (
                          <tr key={c.id} className="hover:bg-slate-900/20 transition-colors">
                            <td className="p-4 pl-6 text-xs text-slate-500">{new Date(c.date).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}</td>
                            <td className="p-4">
                              <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                                isThu 
                                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
                                  : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                              }`}>
                                {isThu ? "THU" : "CHI"}
                              </span>
                            </td>
                            <td className="p-4 font-semibold text-slate-100">{c.category}</td>
                            <td className={`p-4 text-right font-bold ${isThu ? "text-emerald-400" : "text-rose-400"}`}>
                              {isThu ? "+" : "-"}{c.amount.toLocaleString()}đ
                            </td>
                            <td className="p-4 text-xs">{paymentMethodLabel(c.payment_method)}</td>
                            <td className="p-4 text-xs text-slate-400 max-w-[200px] truncate" title={c.description}>{c.description}</td>
                            <td className="p-4 text-right pr-6 font-semibold text-slate-200">{c.balance.toLocaleString()}đ</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* TAB 2: NHẬT KÝ CHI PHÍ */}
            {activeTab === "expense" && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-lg font-bold text-slate-100">Nhật ký Chi phí vận hành (OPEX)</h2>
                  <button 
                    onClick={() => setShowAddExpenseModal(true)}
                    className="flex items-center space-x-1.5 bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all shadow"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Ghi nhận Khoản chi</span>
                  </button>
                </div>

                {/* Danh sách chi phí */}
                <div className="glass-panel rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-900/60 text-slate-400 font-semibold text-xs border-b border-slate-800">
                        <th className="p-4 pl-6">Ngày chi</th>
                        <th className="p-4">Nhóm chi phí</th>
                        <th className="p-4">Khoản chi chi tiết</th>
                        <th className="p-4 text-right">Số tiền (VND)</th>
                        <th className="p-4">Hình thức thanh toán</th>
                        <th className="p-4 pr-6">Mô tả</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-sm text-slate-300">
                      {expenses?.map((e: any) => (
                        <tr key={e.id} className="hover:bg-slate-900/20 transition-colors">
                          <td className="p-4 pl-6 text-xs text-slate-500">{new Date(e.date).toLocaleDateString("vi-VN")}</td>
                          <td className="p-4 font-semibold text-slate-100">{e.category_name}</td>
                          <td className="p-4 text-slate-300">{e.sub_category}</td>
                          <td className="p-4 text-right font-bold text-rose-400">{e.amount.toLocaleString()}đ</td>
                          <td className="p-4 text-xs">{paymentMethodLabel(e.payment_method)}</td>
                          <td className="p-4 text-xs text-slate-400 pr-6 truncate max-w-[200px]" title={e.description}>{e.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}



        {/* MODAL GHI CHI PHÍ */}
        {showAddExpenseModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative">
              <button onClick={() => setShowAddExpenseModal(false)} className="absolute top-4 right-4 text-slate-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              
              <h3 className="text-lg font-bold text-slate-100 mb-4">Ghi nhận Chi phí vận hành</h3>
              <form onSubmit={handleAddExpenseSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Nhóm chi phí</label>
                    <select
                      value={expCategory}
                      onChange={(e) => {
                        const nextId = Number(e.target.value);
                        setExpCategory(nextId);
                        // Cập nhật default sub category cho nhóm tương ứng
                        const cat = categories?.find((c: any) => Number(c.id) === nextId);
                        setExpSubCat(cat?.sub_categories?.[0] || "");
                      }}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                    >
                      {categories?.map((c: any) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Khoản chi chi tiết</label>
                    <select
                      value={expSubCat}
                      onChange={(e) => setExpSubCat(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                    >
                      {getSubCategories().map((sc: string) => (
                        <option key={sc} value={sc}>{sc}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Số tiền chi (VND)</label>
                  <input
                    type="number"
                    value={expAmount}
                    onChange={(e) => setExpAmount(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-rose-400 font-bold"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Phương thức thanh toán</label>
                  <select
                    value={expPayment}
                    onChange={(e) => setExpPayment(e.target.value as PaymentMethod)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    {CASH_PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Mô tả/Chi chú hóa đơn</label>
                  <textarea
                    value={expDesc}
                    onChange={(e) => setExpDesc(e.target.value)}
                    placeholder="Nhập tên đối tác, số hóa đơn hoặc chi tiết khoản chi..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500 h-20 resize-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={addExpenseMutation.isPending}
                  className="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold py-2.5 rounded-xl transition-all text-xs flex justify-center items-center"
                >
                  Xác nhận Chi quỹ
                </button>
              </form>
            </div>
          </div>
        )}

        {/* MODAL GHI THU/CHI NGOÀI SỔ QUỸ */}
        {showAddCashbookModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative">
              <button onClick={() => setShowAddCashbookModal(false)} className="absolute top-4 right-4 text-slate-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              
              <h3 className="text-lg font-bold text-slate-100 mb-4">Ghi nhận giao dịch quỹ ngoài</h3>
              <form onSubmit={handleAddCashbookSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Loại giao dịch</label>
                    <select
                      value={cbType}
                      onChange={(e) => {
                        setCbType(e.target.value as "thu" | "chi");
                        setCbCategory(e.target.value === "thu" ? "Chủ góp vốn" : "Chi tiêu khác");
                      }}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="thu">Phiếu Thu (Tiền vào)</option>
                      <option value="chi">Phiếu Chi (Tiền ra)</option>
                    </select>
                  </div>
                  
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Mục đích</label>
                    <select
                      value={cbCategory}
                      onChange={(e) => setCbCategory(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                    >
                      {cbType === "thu" ? (
                        <>
                          <option value="Chủ góp vốn">Chủ góp vốn</option>
                          <option value="Thu khác">Doanh thu khác</option>
                        </>
                      ) : (
                        <>
                          <option value="Chi tiêu khác">Chi tiêu khác</option>
                          <option value="Tạm ứng">Tạm ứng</option>
                        </>
                      )}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Số tiền (VND)</label>
                  <input
                    type="number"
                    value={cbAmount}
                    onChange={(e) => setCbAmount(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm font-bold text-white"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Hình thức</label>
                  <select
                    value={cbPayment}
                    onChange={(e) => setCbPayment(e.target.value as PaymentMethod)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    {CASH_PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Chi tiết nghiệp vụ</label>
                  <textarea
                    value={cbDesc}
                    onChange={(e) => setCbDesc(e.target.value)}
                    placeholder="Ghi rõ nội dung giao dịch..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500 h-20 resize-none"
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={addCashbookMutation.isPending}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-xl transition-all text-xs flex justify-center items-center"
                >
                  Ghi sổ quỹ
                </button>
              </form>
            </div>
          </div>
        )}
    </div>
  );
}
