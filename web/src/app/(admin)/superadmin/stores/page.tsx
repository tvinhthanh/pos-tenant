"use client";

import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  Plus, Edit, Trash2, Calendar, User, Layers, 
  Activity, Phone, MapPin, AlertCircle, CheckCircle2, 
  Lock, Unlock, ShieldAlert, Store, Key
} from "lucide-react";
import api from "@/utils/api";
import { toast } from "@/components/Toaster";

interface StoreData {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  subscription_tier: string;
  subscription_expires_at: string | null;
  is_active: boolean;
  users_count: number;
}

export default function SuperadminStoresPage() {
  const queryClient = useQueryClient();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedStore, setSelectedStore] = useState<StoreData | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // Form states for creation
  const [createForm, setCreateForm] = useState({
    name: "",
    address: "",
    phone: "",
    subscription_tier: "free",
    subscription_expires_at: "",
    owner_username: "",
    owner_password: "",
    owner_full_name: "",
  });

  // Form states for update
  const [editForm, setEditForm] = useState({
    name: "",
    address: "",
    phone: "",
    subscription_tier: "free",
    subscription_expires_at: "",
    is_active: true,
  });

  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");

  // 1. Fetch stores
  const { data: stores = [], isLoading } = useQuery<StoreData[]>({
    queryKey: ["superStores"],
    queryFn: async () => {
      const res = await api.get("/api/v1/auth/super/stores");
      return res.data;
    }
  });

  // 2. Mutations
  const createMutation = useMutation({
    mutationFn: async (data: typeof createForm) => {
      const payload = {
        name: data.name,
        address: data.address || null,
        phone: data.phone || null,
        subscription_tier: data.subscription_tier,
        subscription_expires_at: data.subscription_expires_at ? new Date(data.subscription_expires_at).toISOString() : null,
        owner_username: data.owner_username,
        owner_password: data.owner_password,
        owner_full_name: data.owner_full_name,
      };
      const res = await api.post("/api/v1/auth/super/stores", payload);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["superStores"] });
      setFormSuccess("Tạo cửa hàng và tài khoản chủ cửa hàng thành công!");
      setTimeout(() => {
        setIsCreateModalOpen(false);
        resetCreateForm();
      }, 1500);
    },
    onError: (err: any) => {
      setFormError(err.response?.data?.detail || "Đã xảy ra lỗi khi tạo cửa hàng.");
    }
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: number; payload: typeof editForm }) => {
      const payload = {
        name: data.payload.name,
        address: data.payload.address || null,
        phone: data.payload.phone || null,
        subscription_tier: data.payload.subscription_tier,
        subscription_expires_at: data.payload.subscription_expires_at ? new Date(data.payload.subscription_expires_at).toISOString() : null,
        is_active: data.payload.is_active,
      };
      const res = await api.patch(`/api/v1/auth/super/stores/${data.id}`, payload);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["superStores"] });
      setFormSuccess("Cập nhật thông tin cửa hàng thành công!");
      setTimeout(() => {
        setIsEditModalOpen(false);
        setSelectedStore(null);
        setFormSuccess("");
      }, 1500);
    },
    onError: (err: any) => {
      setFormError(err.response?.data?.detail || "Đã xảy ra lỗi khi cập nhật.");
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/api/v1/auth/super/stores/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["superStores"] });
      setDeleteConfirmId(null);
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Không thể xóa cửa hàng.");
    }
  });

  const resetCreateForm = () => {
    // Set default expiration date to 30 days from now
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 30);
    const dateString = defaultDate.toISOString().split("T")[0];

    setCreateForm({
      name: "",
      address: "",
      phone: "",
      subscription_tier: "free",
      subscription_expires_at: dateString,
      owner_username: "",
      owner_password: "",
      owner_full_name: "",
    });
    setFormError("");
    setFormSuccess("");
  };

  const handleOpenCreateModal = () => {
    resetCreateForm();
    setIsCreateModalOpen(true);
  };

  const handleOpenEditModal = (store: StoreData) => {
    setSelectedStore(store);
    
    // Format ISO string to YYYY-MM-DD
    let dateStr = "";
    if (store.subscription_expires_at) {
      dateStr = new Date(store.subscription_expires_at).toISOString().split("T")[0];
    }

    setEditForm({
      name: store.name,
      address: store.address || "",
      phone: store.phone || "",
      subscription_tier: store.subscription_tier,
      subscription_expires_at: dateStr,
      is_active: store.is_active,
    });
    setFormError("");
    setFormSuccess("");
    setIsEditModalOpen(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setFormSuccess("");
    createMutation.mutate(createForm);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStore) return;
    setFormError("");
    setFormSuccess("");
    updateMutation.mutate({ id: selectedStore.id, payload: editForm });
  };

  // Helper checking expiration
  const getSubscriptionStatus = (store: StoreData) => {
    if (!store.is_active) {
      return { label: "Đã khóa", className: "bg-slate-900 border-slate-800 text-slate-400" };
    }
    if (store.subscription_expires_at) {
      const expires = new Date(store.subscription_expires_at);
      if (expires < new Date()) {
        return { label: "Hết hạn", className: "bg-rose-500/10 border-rose-500/20 text-rose-400" };
      }
    }
    return { label: "Đang chạy", className: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" };
  };

  return (
    <div className="space-y-8">
      {/* Header Panel */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight flex items-center space-x-3">
            <Store className="w-8 h-8 text-indigo-400" />
            <span>Quản Lý Cửa Hàng & Thuê Bao</span>
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Trang dành riêng cho Quản trị viên tối cao (SaaS Admin) kiểm soát thuê bao đối tác
          </p>
        </div>
        <button
          onClick={handleOpenCreateModal}
          className="flex items-center space-x-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-xl shadow-lg shadow-indigo-600/20 active:scale-95 transition-all text-sm font-semibold"
        >
          <Plus className="w-4 h-4" />
          <span>Thêm cửa hàng & Chủ tiệm</span>
        </button>
      </div>

      {/* Grid Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card p-6 rounded-2xl relative overflow-hidden">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-slate-400 text-xs font-semibold block uppercase tracking-wider">Tổng cửa hàng</span>
              <span className="text-3xl font-bold text-slate-100 block mt-1.5">{stores.length}</span>
            </div>
            <div className="bg-indigo-500/10 p-3 rounded-xl text-indigo-400">
              <Store className="w-5 h-5" />
            </div>
          </div>
        </div>

        <div className="glass-card p-6 rounded-2xl relative overflow-hidden">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-slate-400 text-xs font-semibold block uppercase tracking-wider">Đang hoạt động</span>
              <span className="text-3xl font-bold text-emerald-400 block mt-1.5">
                {stores.filter(s => s.is_active && (!s.subscription_expires_at || new Date(s.subscription_expires_at) >= new Date())).length}
              </span>
            </div>
            <div className="bg-emerald-500/10 p-3 rounded-xl text-emerald-400">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          </div>
        </div>

        <div className="glass-card p-6 rounded-2xl relative overflow-hidden">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-slate-400 text-xs font-semibold block uppercase tracking-wider">Hết hạn / Khóa</span>
              <span className="text-3xl font-bold text-rose-400 block mt-1.5">
                {stores.filter(s => !s.is_active || (s.subscription_expires_at && new Date(s.subscription_expires_at) < new Date())).length}
              </span>
            </div>
            <div className="bg-rose-500/10 p-3 rounded-xl text-rose-400">
              <ShieldAlert className="w-5 h-5" />
            </div>
          </div>
        </div>
      </div>

      {/* Main List Box */}
      <div className="glass-panel p-6 rounded-2xl">
        <h3 className="text-lg font-bold text-slate-100 mb-6">Danh Sách Đối Tác & Cửa Hàng</h3>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
          </div>
        ) : stores.length === 0 ? (
          <div className="text-center py-12 text-slate-500 text-sm">
            Chưa có cửa hàng đối tác nào được đăng ký trong hệ thống.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-900 text-slate-500 font-bold uppercase tracking-wider">
                  <th className="p-4">Tên Cửa Hàng / Liên Hệ</th>
                  <th className="p-4">Gói Dịch Vụ</th>
                  <th className="p-4">Hạn Thuê Bao</th>
                  <th className="p-4">Nhân sự</th>
                  <th className="p-4 text-center">Trạng thái</th>
                  <th className="p-4 text-center">Hành động</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/60">
                {stores.map((store) => {
                  const status = getSubscriptionStatus(store);
                  return (
                    <tr key={store.id} className="hover:bg-slate-900/20 transition-all">
                      <td className="p-4">
                        <div>
                          <span className="text-sm font-bold text-slate-200 block">{store.name}</span>
                          <div className="flex items-center space-x-4 mt-1 text-slate-500">
                            {store.phone && (
                              <span className="flex items-center space-x-1">
                                <Phone className="w-3 h-3" />
                                <span>{store.phone}</span>
                              </span>
                            )}
                            {store.address && (
                              <span className="flex items-center space-x-1">
                                <MapPin className="w-3 h-3" />
                                <span>{store.address}</span>
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <span className="px-2.5 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/25 text-indigo-400 font-bold capitalize">
                          {store.subscription_tier}
                        </span>
                      </td>
                      <td className="p-4 font-medium text-slate-300">
                        {store.subscription_expires_at ? (
                          <div className="flex items-center space-x-1.5">
                            <Calendar className="w-3.5 h-3.5 text-slate-500" />
                            <span>
                              {new Date(store.subscription_expires_at).toLocaleDateString("vi-VN", {
                                dateStyle: "medium"
                              })}
                            </span>
                          </div>
                        ) : (
                          "Không thời hạn"
                        )}
                      </td>
                      <td className="p-4 font-bold text-slate-400 font-mono">
                        {store.users_count} Users
                      </td>
                      <td className="p-4 text-center">
                        <span className={`px-2.5 py-1 rounded-full border text-[10px] font-bold ${status.className}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center justify-center space-x-3">
                          <button
                            onClick={() => handleOpenEditModal(store)}
                            className="p-2 text-indigo-400 hover:bg-indigo-500/10 rounded-lg border border-transparent hover:border-indigo-500/20 transition-all"
                            title="Gia hạn hoặc Chỉnh sửa"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setDeleteConfirmId(store.id)}
                            className="p-2 text-rose-400 hover:bg-rose-500/10 rounded-lg border border-transparent hover:border-rose-500/20 transition-all"
                            title="Xóa cửa hàng"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CREATE MODAL */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
          <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 md:p-8 max-h-[90vh] overflow-y-auto relative">
            <h3 className="text-xl font-bold text-slate-100 flex items-center space-x-3.5 mb-6">
              <Store className="w-6 h-6 text-indigo-400" />
              <span>Đăng Ký Cửa Hàng & Chủ Sở Hữu Mới</span>
            </h3>

            <form onSubmit={handleCreateSubmit} className="space-y-6">
              {formError && (
                <div className="flex items-start space-x-2.5 p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </div>
              )}
              {formSuccess && (
                <div className="flex items-start space-x-2.5 p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400 text-xs">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{formSuccess}</span>
                </div>
              )}

              {/* Store Section */}
              <div className="space-y-4">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block border-b border-slate-850 pb-1.5">1. Thông tin cửa hàng đối tác</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 font-semibold mb-1.5 block">Tên Cửa Hàng <span className="text-rose-500">*</span></label>
                    <input
                      type="text"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                      placeholder="Tiệm Trà Sữa ABC"
                      value={createForm.name}
                      onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-slate-400 font-semibold mb-1.5 block">Số Điện Thoại</label>
                    <input
                      type="text"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                      placeholder="0987xxxxxx"
                      value={createForm.phone}
                      onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-slate-400 font-semibold mb-1.5 block">Địa Chỉ Cửa Hàng</label>
                  <input
                    type="text"
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    placeholder="Số 10, Đường X, Hà Nội"
                    value={createForm.address}
                    onChange={(e) => setCreateForm({ ...createForm, address: e.target.value })}
                  />
                </div>
              </div>

              {/* Owner Account Section */}
              <div className="space-y-4">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block border-b border-slate-850 pb-1.5">2. Tài khoản quản lý (Owner)</span>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="text-slate-400 font-semibold mb-1.5 block">Tên Đăng Nhập <span className="text-rose-500">*</span></label>
                    <input
                      type="text"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                      placeholder="owner_abc"
                      value={createForm.owner_username}
                      onChange={(e) => setCreateForm({ ...createForm, owner_username: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-slate-400 font-semibold mb-1.5 block">Mật Khẩu <span className="text-rose-500">*</span></label>
                    <input
                      type="password"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                      placeholder="••••••••"
                      value={createForm.owner_password}
                      onChange={(e) => setCreateForm({ ...createForm, owner_password: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-slate-400 font-semibold mb-1.5 block">Họ Tên Chủ Cửa Hàng <span className="text-rose-500">*</span></label>
                    <input
                      type="text"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                      placeholder="Nguyễn Văn A"
                      value={createForm.owner_full_name}
                      onChange={(e) => setCreateForm({ ...createForm, owner_full_name: e.target.value })}
                      required
                    />
                  </div>
                </div>
              </div>

              {/* Subscription Details */}
              <div className="space-y-4">
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block border-b border-slate-850 pb-1.5">3. Cấu hình gói dịch vụ thuê bao</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 font-semibold mb-1.5 block">Gói Thuê Bao</label>
                    <select
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                      value={createForm.subscription_tier}
                      onChange={(e) => setCreateForm({ ...createForm, subscription_tier: e.target.value })}
                    >
                      <option value="free">Gói Miễn Phí (Free)</option>
                      <option value="basic">Gói Cơ Bản (Basic)</option>
                      <option value="premium">Gói Cao Cấp (Premium)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-400 font-semibold mb-1.5 block">Hạn Sử Dụng</label>
                    <input
                      type="date"
                      className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                      value={createForm.subscription_expires_at}
                      onChange={(e) => setCreateForm({ ...createForm, subscription_expires_at: e.target.value })}
                      required
                    />
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex justify-end items-center space-x-4 border-t border-slate-850 pt-5 mt-8">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="flex items-center space-x-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/10 transition-all active:scale-95 disabled:opacity-50"
                >
                  {createMutation.isPending ? "Đang xử lý..." : "Khởi tạo Cửa hàng"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT / RENEW MODAL */}
      {isEditModalOpen && selectedStore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 md:p-8 max-h-[90vh] overflow-y-auto relative">
            <h3 className="text-xl font-bold text-slate-100 flex items-center space-x-3.5 mb-6">
              <Edit className="w-6 h-6 text-indigo-400" />
              <span>Gia Hạn & Cấu Hình Thuê Bao</span>
            </h3>

            <form onSubmit={handleEditSubmit} className="space-y-6">
              {formError && (
                <div className="flex items-start space-x-2.5 p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{formError}</span>
                </div>
              )}
              {formSuccess && (
                <div className="flex items-start space-x-2.5 p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400 text-xs">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{formSuccess}</span>
                </div>
              )}

              <div>
                <label className="text-slate-400 font-semibold mb-1.5 block">Tên Cửa Hàng <span className="text-rose-500">*</span></label>
                <input
                  type="text"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  required
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-slate-400 font-semibold mb-1.5 block">Số Điện Thoại</label>
                  <input
                    type="text"
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-slate-400 font-semibold mb-1.5 block">Địa Chỉ</label>
                  <input
                    type="text"
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                    value={editForm.address}
                    onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-slate-850 pt-5">
                <div>
                  <label className="text-slate-400 font-semibold mb-1.5 block">Gói Dịch Vụ</label>
                  <select
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                    value={editForm.subscription_tier}
                    onChange={(e) => setEditForm({ ...editForm, subscription_tier: e.target.value })}
                  >
                    <option value="free">Gói Miễn Phí (Free)</option>
                    <option value="basic">Gói Cơ Bản (Basic)</option>
                    <option value="premium">Gói Cao Cấp (Premium)</option>
                  </select>
                </div>
                <div>
                  <label className="text-slate-400 font-semibold mb-1.5 block">Hạn Thuê Bao Mới</label>
                  <input
                    type="date"
                    className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                    value={editForm.subscription_expires_at}
                    onChange={(e) => setEditForm({ ...editForm, subscription_expires_at: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="flex items-center space-x-3 border-t border-slate-850 pt-5">
                <input
                  type="checkbox"
                  id="editIsActive"
                  className="w-4 h-4 text-indigo-600 border-slate-800 bg-slate-950 rounded focus:ring-indigo-500 focus:ring-offset-slate-900"
                  checked={editForm.is_active}
                  onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })}
                />
                <label htmlFor="editIsActive" className="text-slate-300 font-semibold select-none flex items-center space-x-1.5">
                  {editForm.is_active ? <Unlock className="w-3.5 h-3.5 text-emerald-400" /> : <Lock className="w-3.5 h-3.5 text-rose-400" />}
                  <span>Kích hoạt tài khoản cửa hàng (Cho phép người dùng đăng nhập)</span>
                </label>
              </div>

              {/* Action buttons */}
              <div className="flex justify-end items-center space-x-4 border-t border-slate-850 pt-5 mt-8">
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="flex items-center space-x-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/10 transition-all active:scale-95 disabled:opacity-50"
                >
                  {updateMutation.isPending ? "Đang xử lý..." : "Lưu thay đổi"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRM MODAL */}
      {deleteConfirmId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 relative text-center">
            <div className="mx-auto w-12 h-12 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-full flex items-center justify-center mb-4">
              <Trash2 className="w-6 h-6 animate-pulse" />
            </div>
            <h3 className="text-lg font-bold text-slate-100 mb-2">Bạn Chắc Chắn Muốn Xóa?</h3>
            <p className="text-slate-400 text-xs px-2 mb-6">
              Hành động này sẽ xóa vĩnh viễn cửa hàng đối tác này cùng toàn bộ người dùng (Owner & Staff) trực thuộc. Hành động này **không thể** khôi phục!
            </p>

            <div className="flex items-center justify-center space-x-4">
              <button
                type="button"
                onClick={() => setDeleteConfirmId(null)}
                className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(deleteConfirmId)}
                disabled={deleteMutation.isPending}
                className="bg-rose-600 hover:bg-rose-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-rose-600/10 transition-all active:scale-95 disabled:opacity-50"
              >
                {deleteMutation.isPending ? "Đang xóa..." : "Xóa Vĩnh Viễn"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
