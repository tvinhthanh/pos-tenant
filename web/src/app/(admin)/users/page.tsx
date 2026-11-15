"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api, { supabase } from "@/utils/api";
import { PIN_MAX, PIN_MIN } from "@/utils/pinLock";
import { CASH_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/utils/enums";
import {
  Users, Plus, Trash2, Edit, User, ShieldCheck, 
  Check, AlertCircle, X, ToggleLeft, ToggleRight,
  DollarSign, Briefcase, Clock, CreditCard, Calendar
} from "lucide-react";
import { toast } from "@/components/Toaster";
import StaffShopsMatrix from "@/components/StaffShopsMatrix";

// Phải khớp với ràng buộc trong Edge Function manage-branch-user và cấu hình
// Auth (docs/06: minimum password length ≥ 10).
const MIN_PASSWORD_LENGTH = 10;

const PIN_PATTERN = new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`);
const PIN_ERROR = `Mã PIN phải gồm ${PIN_MIN}–${PIN_MAX} chữ số.`;

// Đặt (pin = chuỗi số) hoặc xóa (pin = null) mã PIN khóa màn hình của một tài khoản.
async function setUserPin(userId: string, pin: string | null) {
  const { error } = await supabase.rpc("set_user_pin", { p_user_id: userId, p_pin: pin });
  if (error) throw new Error(error.message);
}

// toISOString() quy về UTC nên ở +07 mốc nửa đêm bị lùi 1 ngày.
const toDateInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const ROLE_OPTIONS = [
  { value: "staff", label: "Nhân viên (Staff — bán hàng, tạo phiếu chờ duyệt)" },
  { value: "manager", label: "Quản lý (Manager — danh mục, duyệt cấp quản lý)" },
  { value: "owner", label: "Chủ cửa hàng (Owner — toàn quyền tổ chức)" },
];

const ROLE_LABELS: Record<string, string> = {
  owner: "Quản trị (Owner)",
  manager: "Quản lý (Manager)",
  staff: "Nhân viên (Staff)",
  superadmin: "Superadmin",
};

export default function UserManagement() {
  const queryClient = useQueryClient();
  const [activeSubTab, setActiveSubTab] = useState<"users" | "payroll" | "shops">("users");
  // Gán nhân viên nhiều shop: chỉ chủ cửa hàng (owner toàn tổ chức)
  const { data: me } = useQuery({ queryKey: ["currentUser"], queryFn: async () => (await api.get("/api/v1/auth/me")).data });
  const isOrgOwner = Boolean(me?.is_org_owner);

  // Modals state
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<any | null>(null);
  
  // Payroll payment modal state
  const [payingPayrollUser, setPayingPayrollUser] = useState<any | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState<PaymentMethod>("bank_transfer");
  const [payNotes, setPayNotes] = useState("");

  // Add User form state
  const [addUsername, setAddUsername] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addFullName, setAddFullName] = useState("");
  const [addRole, setAddRole] = useState("staff");
  const [addHourlyRate, setAddHourlyRate] = useState<number>(20000);
  const [addPin, setAddPin] = useState("");

  // Edit User form state
  const [editPassword, setEditPassword] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editRole, setEditRole] = useState("staff");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editHourlyRate, setEditHourlyRate] = useState<number>(20000);
  const [editPin, setEditPin] = useState("");
  const [editClearPin, setEditClearPin] = useState(false);

  // Kỳ tính lương — mặc định tháng hiện tại
  const [payFrom, setPayFrom] = useState(
    toDateInput(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  );
  const [payTo, setPayTo] = useState(toDateInput(new Date()));

  // Errors state
  const [errorMessage, setErrorMessage] = useState("");

  // 1. Fetch Users
  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.get("/api/v1/auth/users");
      return res.data;
    }
  });

  // 2. Fetch Payroll calculations — luôn theo một KỲ cụ thể. Nếu lấy toàn bộ
  // lịch sử thì mỗi lần chi lương lại trả cho cùng số giờ đã trả tháng trước.
  const { data: payroll, isLoading: payrollLoading } = useQuery({
    queryKey: ["payroll", payFrom, payTo],
    queryFn: async () => {
      const res = await api.get(`/api/v1/auth/users/payroll?start_date=${payFrom}&end_date=${payTo}`);
      return res.data;
    },
    enabled: activeSubTab === "payroll"
  });

  // Mutations
  const addUserMutation = useMutation({
    mutationFn: async ({ pin, ...payload }: any) => {
      const res = await api.post("/api/v1/auth/register", payload);
      let pinError = "";
      if (pin && res.data?.user_id) {
        try {
          await setUserPin(res.data.user_id, pin);
        } catch (err: any) {
          pinError = err.message;
        }
      }
      return { ...res.data, pinError };
    },
    onSuccess: (data: any) => {
      setShowAddModal(false);
      resetAddForm();
      queryClient.invalidateQueries({ queryKey: ["users"] });
      if (data?.pinError) toast.error(`Đã tạo tài khoản nhưng chưa đặt được mã PIN: ${data.pinError}`);
      else toast.success("Tạo tài khoản người dùng thành công!");
    },
    onError: (err: any) => {
      setErrorMessage(err.response?.data?.detail || "Không thể tạo tài khoản.");
    }
  });

  const editUserMutation = useMutation({
    mutationFn: async ({ id, payload, pin }: { id: string; payload: any; pin?: string | null }) => {
      const res = await api.patch(`/api/v1/auth/users/${id}`, payload);
      // undefined = giữ nguyên PIN; null = xóa PIN; chuỗi = đặt PIN mới
      if (pin !== undefined) {
        try {
          await setUserPin(id, pin);
        } catch (err: any) {
          err.response = { data: { detail: `Đã lưu thông tin nhưng chưa đổi được mã PIN: ${err.message}` } };
          throw err;
        }
      }
      return res.data;
    },
    onSuccess: () => {
      setShowEditModal(false);
      resetEditForm();
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["payroll"] });
      toast.success("Cập nhật thông tin người dùng thành công!");
    },
    onError: (err: any) => {
      setErrorMessage(err.response?.data?.detail || "Không thể cập nhật tài khoản.");
    }
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/v1/auth/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["payroll"] });
      toast.success("Đã khóa tài khoản thành công!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Không khóa được tài khoản này.");
    }
  });

  const paySalaryMutation = useMutation({
    mutationFn: async (payload: { userId: string; amount: number; payment_method: PaymentMethod; notes: string }) => {
      const res = await api.post(`/api/v1/auth/users/${payload.userId}/pay-salary`, {
        amount: payload.amount,
        payment_method: payload.payment_method,
        notes: payload.notes
      });
      return res.data;
    },
    onSuccess: (data) => {
      setPayingPayrollUser(null);
      setPayAmount(0);
      setPayNotes("");
      queryClient.invalidateQueries({ queryKey: ["payroll"] });
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["cashbookBalance"] });
      queryClient.invalidateQueries({ queryKey: ["financialReport"] });
      toast.success(data.message || "Thanh toán lương nhân viên thành công, sổ quỹ đã ghi chi!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Thanh toán lương thất bại.");
    }
  });

  const resetAddForm = () => {
    setAddUsername("");
    setAddPassword("");
    setAddFullName("");
    setAddRole("staff");
    setAddHourlyRate(20000);
    setAddPin("");
    setErrorMessage("");
  };

  const resetEditForm = () => {
    setEditPassword("");
    setEditFullName("");
    setEditRole("staff");
    setEditIsActive(true);
    setEditHourlyRate(20000);
    setEditPin("");
    setEditClearPin(false);
    setSelectedUser(null);
    setErrorMessage("");
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addUsername || !addPassword || !addFullName) {
      setErrorMessage("Vui lòng điền đầy đủ các thông tin bắt buộc.");
      return;
    }
    if (addPassword.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
      return;
    }
    if (addPin && !PIN_PATTERN.test(addPin)) {
      setErrorMessage(PIN_ERROR);
      return;
    }
    addUserMutation.mutate({
      pin: addPin || null,
      username: addUsername,
      password: addPassword,
      full_name: addFullName,
      role: addRole,
      hourly_rate: addHourlyRate
    });
  };

  const handleEditClick = (user: any) => {
    setSelectedUser(user);
    setEditFullName(user.full_name || "");
    setEditRole(user.role || "staff");
    setEditIsActive(user.is_active);
    setEditHourlyRate(user.hourly_rate || 20000);
    setEditPassword("");
    setEditPin("");
    setEditClearPin(false);
    setShowEditModal(true);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;
    
    if (editPassword.trim() && editPassword.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
      return;
    }
    if (editPin && !PIN_PATTERN.test(editPin)) {
      setErrorMessage(PIN_ERROR);
      return;
    }

    const payload: any = {
      full_name: editFullName,
      role: editRole,
      is_active: editIsActive,
      hourly_rate: editHourlyRate
    };
    if (editPassword.trim()) {
      payload.password = editPassword;
    }

    editUserMutation.mutate({
      id: selectedUser.id,
      payload,
      pin: editClearPin ? null : editPin || undefined,
    });
  };

  const handleDeleteClick = (user: any) => {
    // Không xóa thật: lịch sử ca/đơn/phiếu vẫn phải truy được về người thao tác.
    if (confirm(`Khóa tài khoản "${user.username}" (${user.full_name || "chưa đặt tên"})? Tài khoản sẽ không đăng nhập được nữa nhưng lịch sử vẫn giữ nguyên.`)) {
      deleteUserMutation.mutate(user.id);
    }
  };

  const handlePayPayrollClick = (payrollItem: any) => {
    setPayingPayrollUser(payrollItem);
    setPayAmount(payrollItem.total_salary);
    setPayNotes(`Lương ${payrollItem.total_hours} giờ, kỳ ${payFrom} → ${payTo}`);
  };

  const handlePayPayrollSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingPayrollUser || payAmount <= 0) return;
    paySalaryMutation.mutate({
      userId: payingPayrollUser.user_id,
      amount: payAmount,
      payment_method: payMethod,
      notes: payNotes
    });
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center space-x-2">
            <Users className="w-6.5 h-6.5 text-indigo-400" />
            <span>Quản lý &amp; Tính Lương Nhân viên</span>
          </h1>
          <p className="text-slate-500 text-xs mt-0.5">Phân quyền tài khoản POS, cấu hình lương theo giờ, tính toán thời gian ca làm và chi quỹ trả lương</p>
        </div>

        <div className="flex space-x-2 w-full md:w-auto">
          <button
            onClick={() => setActiveSubTab("users")}
            className={`flex-1 md:flex-initial px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
              activeSubTab === "users"
                ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
            }`}
          >
            <span>Danh sách Tài khoản</span>
          </button>
          <button
            onClick={() => setActiveSubTab("payroll")}
            className={`flex-1 md:flex-initial px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
              activeSubTab === "payroll"
                ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
            }`}
          >
            <span>Tính Lương &amp; Chi Quỹ</span>
          </button>
          {isOrgOwner && (
            <button
              onClick={() => setActiveSubTab("shops")}
              className={`flex-1 md:flex-initial px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                activeSubTab === "shops"
                  ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/20"
                  : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              <span>Phân quyền shop</span>
            </button>
          )}
          
          <button
            onClick={() => {
              setErrorMessage("");
              setShowAddModal(true);
            }}
            className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 rounded-xl text-xs font-semibold transition-all shadow shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>Tạo tài khoản</span>
          </button>
        </div>
      </div>

      {/* TAB: GÁN NHIỀU SHOP */}
      {activeSubTab === "shops" && isOrgOwner && <StaffShopsMatrix />}

      {/* TAB 1: USER LIST */}
      {activeSubTab === "users" && (
        <div className="glass-panel border border-slate-900 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            {usersLoading ? (
              <div className="flex flex-col items-center justify-center py-20 space-y-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
                <span className="text-xs text-slate-500">Đang tải danh sách tài khoản...</span>
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-950/40 text-slate-500 border-b border-slate-900 font-semibold uppercase tracking-wider">
                    <th className="p-4">Tên đăng nhập</th>
                    <th className="p-4">Họ và Tên</th>
                    <th className="p-4">Lương theo giờ</th>
                    <th className="p-4">Vai trò</th>
                    <th className="p-4">Trạng thái</th>
                    <th className="p-4 text-center">Hành động</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900/60">
                  {users && users.length > 0 ? (
                    users.map((u: any) => (
                      <tr key={u.id} className="hover:bg-slate-900/10 transition-colors">
                        <td className="p-4 font-semibold text-slate-200">{u.username}</td>
                        <td className="p-4 text-slate-300 font-medium">{u.full_name || "Chưa cập nhật"}</td>
                        <td className="p-4 text-emerald-400 font-bold font-mono">{(u.hourly_rate || 20000).toLocaleString()}đ/h</td>
                        <td className="p-4">
                          <span className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${
                            u.role === "owner" || u.role === "superadmin"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : u.role === "manager"
                                ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                : "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                          }`}>
                            {u.role === "owner" || u.role === "superadmin" ? (
                              <ShieldCheck className="w-3.5 h-3.5 mr-0.5" />
                            ) : (
                              <User className="w-3.5 h-3.5 mr-0.5" />
                            )}
                            <span>{ROLE_LABELS[u.role] || u.role}</span>
                          </span>
                        </td>
                        <td className="p-4">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                            u.is_active 
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                              : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          }`}>
                            {u.is_active ? "Đang hoạt động" : "Bị khóa"}
                          </span>
                        </td>
                        <td className="p-4 text-center">
                          <div className="flex justify-center space-x-2">
                            <button
                              onClick={() => handleEditClick(u)}
                              className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors border border-slate-800"
                              title="Sửa tài khoản"
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteClick(u)}
                              className="p-2 bg-rose-500/10 hover:bg-rose-500 hover:text-white text-rose-400 rounded-lg transition-colors border border-rose-500/10"
                              title="Khóa tài khoản"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-slate-650">
                        Chưa có tài khoản nào được đăng ký.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: PAYROLL SUMMARY */}
      {activeSubTab === "payroll" && (
        <div className="space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 glass-panel border border-slate-900 rounded-2xl p-4">
            <div className="flex items-center space-x-2 text-xs text-slate-400">
              <Calendar className="w-4 h-4 text-slate-500" />
              <span className="font-semibold">Kỳ tính lương</span>
            </div>
            <div className="flex items-center space-x-2 text-xs">
              <input
                type="date"
                value={payFrom}
                onChange={(e) => setPayFrom(e.target.value)}
                className="bg-slate-950 border border-slate-850 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
              />
              <span className="text-slate-600">→</span>
              <input
                type="date"
                value={payTo}
                onChange={(e) => setPayTo(e.target.value)}
                className="bg-slate-950 border border-slate-850 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
              />
            </div>
          </div>

          <div className="glass-panel border border-slate-900 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            {payrollLoading ? (
              <div className="flex flex-col items-center justify-center py-20 space-y-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
                <span className="text-xs text-slate-500">Đang tính toán bảng lương ca...</span>
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-950/40 text-slate-500 border-b border-slate-900 font-semibold uppercase tracking-wider">
                    <th className="p-4">Nhân sự</th>
                    <th className="p-4 text-center">Lương/Giờ</th>
                    <th className="p-4 text-center">Số ca đã làm</th>
                    <th className="p-4 text-center">Tổng giờ làm</th>
                    <th className="p-4 text-right">Lương đề xuất</th>
                    <th className="p-4 text-center">Thanh toán lương</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900/60">
                  {payroll && payroll.length > 0 ? (
                    payroll.map((p: any) => (
                      <tr key={p.user_id} className="hover:bg-slate-900/10 transition-colors">
                        <td className="p-4">
                          <div>
                            <span className="text-sm font-bold text-slate-200 block">{p.full_name || p.username}</span>
                            <span className="text-[10px] text-slate-500 font-semibold">Username: @{p.username}</span>
                          </div>
                        </td>
                        <td className="p-4 text-center font-bold text-slate-300 font-mono">{p.hourly_rate.toLocaleString()}đ/h</td>
                        <td className="p-4 text-center text-slate-400 font-bold font-mono">{p.total_shifts} ca</td>
                        <td className="p-4 text-center text-indigo-400 font-bold font-mono">{p.total_hours} giờ</td>
                        <td className="p-4 text-right text-emerald-400 font-extrabold font-mono text-sm">{p.total_salary.toLocaleString()}đ</td>
                        <td className="p-4 text-center">
                          <button
                            onClick={() => handlePayPayrollClick(p)}
                            disabled={p.total_salary <= 0}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-[11px] font-bold rounded-lg transition-all shadow hover:shadow-emerald-600/10 flex items-center justify-center space-x-1 mx-auto"
                          >
                            <DollarSign className="w-3.5 h-3.5" />
                            <span>Chi lương</span>
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-slate-650">
                        Không có ca đã đóng nào trong kỳ này.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
          </div>
        </div>
      )}

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-950/40">
              <span className="font-bold text-slate-200 flex items-center space-x-2">
                <Plus className="w-5 h-5 text-indigo-400" />
                <span>Tạo tài khoản nhân viên mới</span>
              </span>
              <button 
                onClick={() => {
                  setShowAddModal(false);
                  resetAddForm();
                }} 
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddSubmit} className="p-6 space-y-4">
              {errorMessage && (
                <div className="p-3.5 bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs rounded-xl flex items-start space-x-2">
                  <AlertCircle className="w-4.5 h-4.5 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Tên đăng nhập (Username)*</label>
                <input
                  type="text"
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value.toLowerCase().replace(/\s/g, ""))}
                  placeholder="Nhập tên đăng nhập viết liền không dấu..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Mật khẩu ban đầu* (tối thiểu {MIN_PASSWORD_LENGTH} ký tự)</label>
                <input
                  type="password"
                  value={addPassword}
                  onChange={(e) => setAddPassword(e.target.value)}
                  placeholder="Mật khẩu bảo mật..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Mã PIN khóa màn hình ({PIN_MIN}–{PIN_MAX} số, để trống thì nhân viên tự tạo khi đăng nhập)</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={PIN_MAX}
                  value={addPin}
                  onChange={(e) => setAddPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="VD: 1234"
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 tracking-[0.4em] font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Họ và Tên đầy đủ*</label>
                <input
                  type="text"
                  value={addFullName}
                  onChange={(e) => setAddFullName(e.target.value)}
                  placeholder="Ví dụ: Nguyễn Văn A..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Lương theo giờ (VND/h)*</label>
                <input
                  type="number"
                  value={addHourlyRate}
                  onChange={(e) => setAddHourlyRate(parseInt(e.target.value) || 0)}
                  placeholder="Ví dụ: 20000..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Vai trò phân quyền</label>
                <select
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="pt-2 flex space-x-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddModal(false);
                    resetAddForm();
                  }}
                  className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-350 font-semibold rounded-xl transition-all text-xs border border-slate-750"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  disabled={addUserMutation.isPending}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold rounded-xl transition-all shadow-lg text-xs flex justify-center items-center"
                >
                  {addUserMutation.isPending ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  ) : (
                    "Đăng ký tài khoản"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {showEditModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-950/40">
              <span className="font-bold text-slate-200 flex items-center space-x-2">
                <Edit className="w-5 h-5 text-indigo-400" />
                <span>Chỉnh sửa tài khoản: {selectedUser.username}</span>
              </span>
              <button 
                onClick={() => {
                  setShowEditModal(false);
                  resetEditForm();
                }} 
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="p-6 space-y-4">
              {errorMessage && (
                <div className="p-3.5 bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs rounded-xl flex items-start space-x-2">
                  <AlertCircle className="w-4.5 h-4.5 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Họ và Tên đầy đủ*</label>
                <input
                  type="text"
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  placeholder="Ví dụ: Nguyễn Văn A..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Mật khẩu mới (để trống nếu giữ nguyên, tối thiểu {MIN_PASSWORD_LENGTH} ký tự)</label>
                <input
                  type="password"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  placeholder="Nhập mật khẩu mới bảo mật..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-650 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Mã PIN khóa màn hình mới (để trống nếu giữ nguyên)</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={PIN_MAX}
                  value={editPin}
                  disabled={editClearPin}
                  onChange={(e) => setEditPin(e.target.value.replace(/\D/g, ""))}
                  placeholder={`${PIN_MIN}–${PIN_MAX} chữ số`}
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 tracking-[0.4em] font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-40"
                />
                <label className="flex items-center gap-2 text-[11px] text-slate-500">
                  <input
                    type="checkbox"
                    checked={editClearPin}
                    onChange={(e) => { setEditClearPin(e.target.checked); if (e.target.checked) setEditPin(""); }}
                  />
                  Xóa mã PIN (nhân viên quên PIN) — lần mở khóa tới sẽ tự tạo PIN mới
                </label>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Lương theo giờ (VND/h)*</label>
                <input
                  type="number"
                  value={editHourlyRate}
                  onChange={(e) => setEditHourlyRate(parseInt(e.target.value) || 0)}
                  placeholder="Mức lương..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Vai trò phân quyền</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 flex items-center justify-between p-3.5 bg-slate-950 border border-slate-850 rounded-xl">
                <div>
                  <span className="text-xs font-bold text-slate-200 block">Trạng thái hoạt động</span>
                  <span className="text-[10px] text-slate-500 block mt-0.5">Khóa tài khoản này không cho đăng nhập</span>
                </div>
                <button
                  type="button"
                  onClick={() => setEditIsActive(!editIsActive)}
                  className="text-slate-400 hover:text-white transition-colors"
                >
                  {editIsActive ? (
                    <ToggleRight className="w-10 h-10 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="w-10 h-10 text-slate-600" />
                  )}
                </button>
              </div>

              <div className="pt-2 flex space-x-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowEditModal(false);
                    resetEditForm();
                  }}
                  className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-355 font-semibold rounded-xl transition-all text-xs border border-slate-750"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  disabled={editUserMutation.isPending}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold rounded-xl transition-all shadow-lg text-xs flex justify-center items-center"
                >
                  {editUserMutation.isPending ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  ) : (
                    "Lưu thay đổi"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pay Payroll Modal */}
      {payingPayrollUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-950/40">
              <span className="font-bold text-slate-200 flex items-center space-x-2">
                <DollarSign className="w-5 h-5 text-emerald-400" />
                <span>Thanh toán lương: {payingPayrollUser.full_name || payingPayrollUser.username}</span>
              </span>
              <button 
                onClick={() => setPayingPayrollUser(null)} 
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handlePayPayrollSubmit} className="p-6 space-y-4">
              <div className="p-4 bg-slate-950/60 border border-slate-850 rounded-xl space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Mức lương theo giờ:</span>
                  <span className="text-slate-200 font-bold">{payingPayrollUser.hourly_rate.toLocaleString()}đ/h</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Tổng giờ làm việc:</span>
                  <span className="text-indigo-400 font-bold">{payingPayrollUser.total_hours} giờ ({payingPayrollUser.total_shifts} ca)</span>
                </div>
                <div className="flex justify-between text-xs pt-1.5 border-t border-slate-900">
                  <span className="text-slate-500">Lương đề xuất đề xuất:</span>
                  <span className="text-emerald-400 font-extrabold text-sm font-mono">{payingPayrollUser.total_salary.toLocaleString()}đ</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Số tiền chi trả thực tế (VND)*</label>
                <input
                  type="number"
                  value={payAmount}
                  onChange={(e) => setPayAmount(parseInt(e.target.value) || 0)}
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono font-bold"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Phương thức chi tiền*</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  {CASH_PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Ghi chú thanh toán</label>
                <input
                  type="text"
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="Ví dụ: Trả lương tháng 6..."
                  className="w-full px-4 py-2.5 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-2 flex space-x-3">
                <button
                  type="button"
                  onClick={() => setPayingPayrollUser(null)}
                  className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-350 font-semibold rounded-xl transition-all text-xs border border-slate-750"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  disabled={paySalaryMutation.isPending}
                  className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-bold rounded-xl transition-all shadow-lg text-xs flex justify-center items-center"
                >
                  {paySalaryMutation.isPending ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  ) : (
                    "Xác nhận chi quỹ"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
