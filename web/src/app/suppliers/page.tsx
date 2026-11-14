"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import api from "@/utils/api";
import { CASH_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/utils/enums";
import {
  Users, UserCheck, Plus, Landmark, Phone, MapPin,
  Coins, X, Check, AlertCircle, Sparkles
} from "lucide-react";
import { toast } from "@/components/Toaster";

export default function Suppliers() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"supplier" | "customer">("supplier");

  // UI modals
  const [payingSupplier, setPayingSupplier] = useState<any | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState<PaymentMethod>("bank_transfer");
  
  const [showAddSupplierModal, setShowAddSupplierModal] = useState(false);
  const [supName, setSupName] = useState("");
  const [supPhone, setSupPhone] = useState("");
  const [supAddress, setSupAddress] = useState("");

  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [custName, setCustName] = useState("");
  const [custPhone, setCustPhone] = useState("");

  // 1. Fetch suppliers
  const { data: suppliers } = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const res = await api.get("/api/v1/suppliers");
      return res.data;
    }
  });

  // 2. Fetch customers
  const { data: customers } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await api.get("/api/v1/pos/customers");
      return res.data;
    }
  });

  // Mutations
  const addSupplierMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await api.post("/api/v1/suppliers", payload);
      return res.data;
    },
    onSuccess: () => {
      setShowAddSupplierModal(false);
      setSupName("");
      setSupPhone("");
      setSupAddress("");
      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      toast.success("Thêm nhà cung cấp thành công!");
    }
  });

  const addCustomerMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await api.post("/api/v1/pos/customers", payload);
      return res.data;
    },
    onSuccess: () => {
      setShowAddCustomerModal(false);
      setCustName("");
      setCustPhone("");
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Đăng ký khách hàng thành công!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Đăng ký thất bại!");
    }
  });

  const payDebtMutation = useMutation({
    mutationFn: async (payload: { supplierId: number; amount: number; payment_method: PaymentMethod }) => {
      const res = await api.post(`/api/v1/suppliers/${payload.supplierId}/pay-debt`, {
        amount: payload.amount,
        payment_method: payload.payment_method
      });
      return res.data;
    },
    onSuccess: () => {
      setPayingSupplier(null);
      setPayAmount(0);
      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["cashbook"] });
      queryClient.invalidateQueries({ queryKey: ["cashbookBalance"] });
      queryClient.invalidateQueries({ queryKey: ["financialReport"] });
      toast.success("Đã trả nợ thành công, sổ quỹ đã ghi nhận phiếu chi!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Giao dịch thất bại!");
    }
  });

  const handleAddSupplier = (e: React.FormEvent) => {
    e.preventDefault();
    addSupplierMutation.mutate({
      name: supName,
      phone: supPhone,
      address: supAddress
    });
  };

  const handleAddCustomer = (e: React.FormEvent) => {
    e.preventDefault();
    addCustomerMutation.mutate({
      name: custName,
      phone: custPhone
    });
  };

  const handlePayDebtSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingSupplier || payAmount <= 0) return;
    payDebtMutation.mutate({
      supplierId: payingSupplier.id,
      amount: payAmount,
      payment_method: payMethod
    });
  };

  return (
    <div className="space-y-8">
            
            {/* Header */}
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Đối Tác & Khách Hàng</h1>
                <p className="text-slate-500 text-xs mt-0.5">Theo dõi công nợ nhà cung cấp mua sỉ và chăm sóc khách hàng tích điểm</p>
              </div>

              <div className="flex space-x-2">
                <button
                  onClick={() => setActiveTab("supplier")}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    activeTab === "supplier"
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <Users className="w-4 h-4" />
                  <span>Công nợ Nhà cung cấp</span>
                </button>
                <button
                  onClick={() => setActiveTab("customer")}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    activeTab === "customer"
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <UserCheck className="w-4 h-4" />
                  <span>Khách hàng thân thiết</span>
                </button>
              </div>
            </div>

            {/* TAB 1: CÔNG NỢ NHÀ CUNG CẤP */}
            {activeTab === "supplier" && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-lg font-bold text-slate-100">Đối tác Nhà cung cấp</h2>
                  <button
                    onClick={() => setShowAddSupplierModal(true)}
                    className="flex items-center space-x-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all shadow"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Thêm nhà cung cấp</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {suppliers?.map((sup: any) => (
                    <div key={sup.id} className="glass-panel p-5 rounded-2xl flex flex-col justify-between relative overflow-hidden">
                      {sup.total_debt > 0 && (
                        <div className="absolute top-0 right-0 w-16 h-16 bg-rose-500/5 rounded-full blur-xl"></div>
                      )}
                      
                      <div className="space-y-3">
                        <div className="flex justify-between items-start">
                          <span className="text-sm font-bold text-slate-200">{sup.name}</span>
                          <span className="text-[10px] text-slate-500 font-mono">#{sup.id}</span>
                        </div>
                        
                        <div className="space-y-1.5 text-xs text-slate-400">
                          <div className="flex items-center space-x-2">
                            <Phone className="w-3.5 h-3.5 text-slate-650" />
                            <span>{sup.phone || "Không có SĐT"}</span>
                          </div>
                          <div className="flex items-center space-x-2">
                            <MapPin className="w-3.5 h-3.5 text-slate-650" />
                            <span className="truncate max-w-[200px]">{sup.address || "Không có địa chỉ"}</span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-6 pt-4 border-t border-slate-900 flex justify-between items-center">
                        <div>
                          <span className="text-[10px] text-slate-500 uppercase font-semibold block">Dư nợ hiện tại</span>
                          <span className={`text-sm font-bold block mt-0.5 ${sup.total_debt > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                            {sup.total_debt.toLocaleString()}đ
                          </span>
                        </div>
                        
                        {sup.total_debt > 0 && (
                          <button
                            onClick={() => {
                              setPayingSupplier(sup);
                              setPayAmount(sup.total_debt);
                            }}
                            className="flex items-center space-x-1.5 bg-rose-600 hover:bg-rose-500 text-white px-3.5 py-2 rounded-xl text-xs font-semibold transition-all shadow shadow-rose-600/10"
                          >
                            <Landmark className="w-3.5 h-3.5" />
                            <span>Trả nợ sỉ</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB 2: KHÁCH HÀNG THÂN THIẾT */}
            {activeTab === "customer" && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-lg font-bold text-slate-100">Khách hàng thành viên</h2>
                  <button
                    onClick={() => setShowAddCustomerModal(true)}
                    className="flex items-center space-x-1.5 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all shadow"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Đăng ký khách mới</span>
                  </button>
                </div>

                <div className="glass-panel rounded-2xl overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-900/60 text-slate-400 font-semibold text-xs border-b border-slate-800">
                        <th className="p-4 pl-6">Mã KH</th>
                        <th className="p-4">Tên khách hàng</th>
                        <th className="p-4">Số điện thoại</th>
                        <th className="p-4 text-right">Điểm tích lũy</th>
                        <th className="p-4 text-right pr-6">Tổng chi tiêu (VND)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-sm text-slate-300">
                      {customers?.map((cust: any) => (
                        <tr key={cust.id} className="hover:bg-slate-900/20 transition-colors">
                          <td className="p-4 pl-6 text-xs text-slate-500 font-mono">#{cust.id}</td>
                          <td className="p-4 font-semibold text-slate-100 flex items-center space-x-1.5">
                            <span>{cust.name}</span>
                            {cust.total_spent >= 1000000 && (
                              <span title="Khách VIP">
                                <Sparkles className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" />
                              </span>
                            )}
                          </td>
                          <td className="p-4 text-xs font-mono">{cust.phone}</td>
                          <td className="p-4 text-right font-bold text-indigo-400">{cust.points} điểm</td>
                          <td className="p-4 text-right pr-6 font-semibold text-emerald-450">{cust.total_spent.toLocaleString()}đ</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}



        {/* MODAL TRẢ NỢ NCC */}
        {payingSupplier && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative">
              <button onClick={() => setPayingSupplier(null)} className="absolute top-4 right-4 text-slate-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              
              <h3 className="text-lg font-bold text-slate-100 mb-2">Thanh toán nợ: {payingSupplier.name}</h3>
              <p className="text-xs text-slate-500 mb-4">Tổng số nợ hiện tại: {payingSupplier.total_debt.toLocaleString()}đ</p>
              
              <form onSubmit={handlePayDebtSubmit} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Số tiền thanh toán nợ</label>
                  <input
                    type="number"
                    value={payAmount}
                    onChange={(e) => setPayAmount(Number(e.target.value))}
                    max={payingSupplier.total_debt}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm font-bold text-rose-450"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Hình thức trả nợ</label>
                  <select
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none"
                  >
                    {CASH_PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>
                    ))}
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={payDebtMutation.isPending}
                  className="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold py-2.5 rounded-xl transition-all text-xs flex justify-center items-center"
                >
                  Xác nhận Trả nợ
                </button>
              </form>
            </div>
          </div>
        )}

        {/* MODAL THÊM NCC */}
        {showAddSupplierModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative">
              <button onClick={() => setShowAddSupplierModal(false)} className="absolute top-4 right-4 text-slate-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              
              <h3 className="text-lg font-bold text-slate-100 mb-4">Thêm Nhà cung cấp mới</h3>
              <form onSubmit={handleAddSupplier} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Tên nhà cung cấp</label>
                  <input
                    type="text"
                    value={supName}
                    onChange={(e) => setSupName(e.target.value)}
                    placeholder="Ví dụ: Đại lý sữa cô gái Hà Lan"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Số điện thoại liên hệ</label>
                  <input
                    type="text"
                    value={supPhone}
                    onChange={(e) => setSupPhone(e.target.value)}
                    placeholder="Ví dụ: 0988xxxxxx"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Địa chỉ</label>
                  <input
                    type="text"
                    value={supAddress}
                    onChange={(e) => setSupAddress(e.target.value)}
                    placeholder="Quận/Huyện, Tỉnh/TP..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={addSupplierMutation.isPending}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-xl transition-all text-xs"
                >
                  Tạo Nhà cung cấp
                </button>
              </form>
            </div>
          </div>
        )}

        {/* MODAL THÊM KHÁCH HÀNG */}
        {showAddCustomerModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative">
              <button onClick={() => setShowAddCustomerModal(false)} className="absolute top-4 right-4 text-slate-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              
              <h3 className="text-lg font-bold text-slate-100 mb-4">Đăng ký thành viên mới</h3>
              <form onSubmit={handleAddCustomer} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Tên khách hàng</label>
                  <input
                    type="text"
                    value={custName}
                    onChange={(e) => setCustName(e.target.value)}
                    placeholder="Ví dụ: Nguyễn Văn Hải"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 uppercase">Số điện thoại tích điểm</label>
                  <input
                    type="text"
                    value={custPhone}
                    onChange={(e) => setCustPhone(e.target.value)}
                    placeholder="Ví dụ: 097xxxxxxx"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-sm text-white focus:outline-none"
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={addCustomerMutation.isPending}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-xl transition-all text-xs"
                >
                  Tạo Thẻ Thành Viên
                </button>
              </form>
            </div>
          </div>
        )}

    </div>
  );
}
