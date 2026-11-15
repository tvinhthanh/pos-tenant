"use client";

import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import api, { supabase } from "@/utils/api";
import { 
  Search, ShoppingCart, Plus, Minus, Trash2, 
  Ticket, UserPlus, Receipt, CreditCard, Check, AlertCircle,
  Unlock, Printer, Undo2, Clock, BookOpen, User, Tag,
  Wifi, WifiOff, RefreshCw, LogOut, ChefHat, Send, Gift, X
} from "lucide-react";

import ShiftGuard from "@/components/ShiftGuard";
import ShiftModal from "@/components/ShiftModal";
import ReceiptModal from "@/components/ReceiptModal";
import ProductOptionsModal, { type OptionPickerProduct } from "@/components/ProductOptionsModal";
import OfflineRejectedOrders from "@/components/OfflineRejectedOrders";
import { useOfflineSync } from "@/utils/useOfflineSync";
import { saveOfflineOrder, cacheCatalog, getCachedCatalog } from "@/utils/offlineStore";
import {
  lineDisplayName,
  minUnitPrice,
  optionIdsOf as sortedOptionIds,
  optionSummary,
  unitPriceOf,
  type SelectedOption,
} from "@/utils/productOptions";
import { toast } from "@/components/Toaster";
import { getBranchProfile, vietQrUrl } from "@/utils/rpc";
import { addItemsToOrder } from "@/utils/fnb";
import { PAYMENT_METHODS, orderItemCount, paymentLabel, pendingKitchenItemCount } from "@/components/pos/helpers";
import OrderHistoryTab from "@/components/pos/OrderHistoryTab";
import KitchenTab from "@/components/pos/KitchenTab";
import TablesTab from "@/components/pos/TablesTab";

interface CartItem {
  lineId: string;
  id: number;
  name: string;
  /** Đơn giá đã gồm tùy chọn (chỉ để hiển thị — DB tự tính lại khi lưu đơn) */
  price: number;
  quantity: number;
  options: SelectedOption[];
  status?: string;
  orderItemId?: number;
  /** Lý do tặng — có giá trị nghĩa là dòng này tặng khách (0đ, vẫn ghi lại) */
  comp?: string;
}

/** Tiền khách phải trả cho 1 phần của dòng (món tặng = 0đ). */
const linePrice = (item: CartItem) => (item.comp ? 0 : item.price);

const COMP_REASONS = ["Khách quen", "Đền bù chờ lâu", "Khuyến mãi", "Chủ quán mời"];

const optionIdsOf = (item: CartItem) => sortedOptionIds(item.options);

const sameOptions = (a: SelectedOption[], b: SelectedOption[]) =>
  sortedOptionIds(a).join(",") === sortedOptionIds(b).join(",");

/** Dòng món gửi lên server — giá do DB tính, chỉ cần món + số lượng + tùy chọn. */
const toOrderLine = (item: CartItem) => ({
  product_id: item.id,
  quantity: item.quantity,
  option_ids: optionIdsOf(item),
  ...(item.comp ? { comp: true, comp_reason: item.comp } : {}),
});

const toReceiptItem = (item: CartItem) => ({
  product_id: item.id,
  product_name: lineDisplayName(item.name, item.options),
  quantity: item.quantity,
  price: linePrice(item),
  comp: Boolean(item.comp),
  comp_value: item.comp ? item.price : 0,
});


function POSContent() {
  const queryClient = useQueryClient();
  const {
    isOnline, pendingCount, isSyncing, syncPendingOrders,
    rejectedOrders, retryOfflineOrder, discardOrder,
  } = useOfflineSync();
  const [activeTab, setActiveTab] = useState<"menu" | "orders" | "tables" | "kitchen">("menu");
  const [selectedTable, setSelectedTable] = useState<any>(null);
  const [activeOrder, setActiveOrder] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("Tất cả");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [phoneSearch, setPhoneSearch] = useState("");
  const [customer, setCustomer] = useState<{ id: number; name: string; phone: string; points: number } | null>(null);
  const [voucherCode, setVoucherCode] = useState("");
  const [voucher, setVoucher] = useState<{ code: string; value: number; discount_type: string; min_order_value: number } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  // Tài khoản nhận chuyển khoản của quán → mã VietQR thật
  const { data: branchProfile } = useQuery({ queryKey: ["branchProfile"], queryFn: getBranchProfile });
  
  const [checkoutError, setCheckoutError] = useState("");
  const [checkoutSuccess, setCheckoutSuccess] = useState("");
  const [showFloatingCart, setShowFloatingCart] = useState(true);
  
  // Modals state
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [selectedOrderForReceipt, setSelectedOrderForReceipt] = useState<any>(null);
  const [optionProduct, setOptionProduct] = useState<OptionPickerProduct | null>(null);
  // Dòng giỏ hàng đang chọn lý do tặng
  const [compLine, setCompLine] = useState<{ lineId: string; name: string; reason: string } | null>(null);

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => {
      const res = await api.get("/api/v1/auth/me");
      return res.data as { role: string; full_name?: string };
    },
    retry: false,
  });

  const isStaff = currentUser?.role === "staff";

  useEffect(() => {
    const cartEl = document.getElementById("pos-cart");
    if (!cartEl) return;

    const observer = new IntersectionObserver(
      ([entry]) => setShowFloatingCart(!entry.isIntersecting),
      { threshold: 0.15 }
    );

    observer.observe(cartEl);
    return () => observer.disconnect();
  }, [selectedTable]);

  // 1. Fetch products kèm Offline Cache Fallback
  const { data: products } = useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      try {
        const res = await api.get("/api/v1/pos/products");
        cacheCatalog({ products: res.data });
        return res.data;
      } catch (err) {
        const cached = getCachedCatalog();
        if (cached && cached.products) {
          return cached.products;
        }
        throw err;
      }
    }
  });

  // 2. Fetch recent orders
  const { data: orders } = useQuery({
    queryKey: ["orders"],
    queryFn: async () => {
      const res = await api.get("/api/v1/pos/orders?limit=100");
      return res.data;
    }
  });

  // Fetch areas & tables
  const { data: areas = [] } = useQuery({
    queryKey: ["areas"],
    queryFn: async () => {
      const res = await api.get("/api/v1/tables/areas");
      return res.data;
    }
  });

  const { data: tables = [], isLoading: tablesLoading } = useQuery({
    queryKey: ["tables"],
    queryFn: async () => {
      const res = await api.get("/api/v1/tables/tables");
      return res.data;
    }
  });

  // 3. Mutation tìm kiếm khách hàng bằng SDT
  const searchCustomerMutation = useMutation({
    mutationFn: async (phone: string) => {
      const res = await api.get(`/api/v1/pos/customers/search?phone=${phone}`);
      return res.data;
    },
    onSuccess: (data) => {
      setCustomer(data);
      setCheckoutError("");
    },
    onError: () => {
      setCustomer(null);
      setCheckoutError("Không tìm thấy khách hàng. Vui lòng đăng ký mới!");
    }
  });

  // 4. Mutation tìm kiếm voucher bằng mã
  const searchVoucherMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await api.get(`/api/v1/pos/vouchers/${code}`);
      return res.data;
    },
    onSuccess: (data) => {
      setVoucher(data);
      setCheckoutError("");
    },
    onError: () => {
      setVoucher(null);
      setCheckoutError("Mã voucher không hợp lệ hoặc đã hết hạn/lượt!");
    }
  });

  // 5. Mutation Tạo đơn hàng POS
  const createOrderMutation = useMutation({
    mutationFn: async (payload: any) => {
      // Gọi thêm món vào đơn bàn đang mở (không đổi khách / voucher): RPC riêng,
      // chỉ trừ kho phần thêm và tự tính lại voucher trên tổng mới.
      if (payload?.add_items_order_id) {
        const result = await addItemsToOrder(payload.add_items_order_id, payload.items, Boolean(payload.send_to_kitchen));
        return { ...result, id: result.order_id, date: new Date().toISOString(), items: payload.receipt_items || [] };
      }
      const endpoint = payload?.complete_order_id
        ? `/api/v1/pos/orders/${payload.complete_order_id}/complete`
        : "/api/v1/pos/orders";
      const res = await api.post(endpoint, payload);
      return res.data;
    },
    onSuccess: (data) => {
      setCart([]);
      setCustomer(null);
      setVoucher(null);
      setVoucherCode("");
      setPhoneSearch("");
      setSelectedTable(null);
      setActiveOrder(null);
      setCheckoutSuccess(data.status === "draft" ? "Đã báo bếp và đưa đơn vào hàng đợi." : "Đơn hàng thanh toán thành công.");
      setCheckoutError("");
      
      // Auto open print receipt modal (only if completed)
      if (data.status === "completed") {
        setSelectedOrderForReceipt({
        id: data.id,
        date: data.date,
        customer_name: data.customer_name,
        total_amount: data.total_amount,
        discount_amount: data.discount_amount,
        final_amount: data.final_amount,
        payment_method: paymentLabel(data.payment_method || ""),
        items: data.items.map((item: any) => ({
          product_name: item.product_name,
          quantity: item.quantity,
          price: item.price,
          comp: Boolean(item.comp),
          comp_value: Number(item.comp_value || 0),
        }))
      });
      setIsReceiptModalOpen(true);
      }
      
      // Invalidate các cache liên quan để reload data
      queryClient.invalidateQueries({ queryKey: ["ingredients"] });
      queryClient.invalidateQueries({ queryKey: ["financialReport"] });
      queryClient.invalidateQueries({ queryKey: ["cashbookBalance"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["currentShift"] });
      
      setTimeout(() => setCheckoutSuccess(""), 5000);
    },
    onError: (err: any) => {
      setCheckoutError(err.response?.data?.detail || "Thanh toán thất bại!");
    }
  });

  // 6. Mutation Hủy đơn hàng (Chỉ dành cho Owner)
  const cancelOrderMutation = useMutation({
    mutationFn: async ({ orderId, reason }: { orderId: number; reason: string }) => {
      const res = await api.patch(`/api/v1/pos/orders/${orderId}/cancel`, { reason });
      return res.data;
    },
    onSuccess: (data: any) => {
      if (data?.status === "pending_approval") {
        toast.success(
          `Số tiền hoàn vượt ngưỡng — đã gửi yêu cầu chờ ${data.required_level === "owner" ? "chủ quán" : "quản lý"} duyệt.`
        );
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["ingredients"] });
      queryClient.invalidateQueries({ queryKey: ["financialReport"] });
      queryClient.invalidateQueries({ queryKey: ["cashbookBalance"] });
      queryClient.invalidateQueries({ queryKey: ["currentShift"] });
      toast.success("Hủy đơn hàng thành công!");
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.detail || "Hủy đơn thất bại. Yêu cầu quyền Chủ cửa hàng!");
    }
  });

  const updateOrderItemStatusMutation = useMutation({
    mutationFn: async ({ itemId, status }: { itemId: number; status: string }) => {
      const res = await api.patch(`/api/v1/pos/order-items/${itemId}/status`, { status });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (err: any) => {
      setCheckoutError(err.response?.data?.detail || "Cập nhật trạng thái món thất bại.");
    }
  });

  // Thêm một dòng vào giỏ; gộp với dòng chưa lưu cùng món + cùng tùy chọn
  const addLine = (product: any, options: SelectedOption[], quantity: number) => {
    const unitPrice = unitPriceOf(product.price, options);
    setCart(prevCart => {
      const existingUnsaved = prevCart.find(item =>
        item.id === product.id && !item.orderItemId && !item.comp && sameOptions(item.options, options)
      );
      if (existingUnsaved) {
        return prevCart.map(item =>
          item.lineId === existingUnsaved.lineId ? { ...item, quantity: item.quantity + quantity } : item
        );
      }
      return [...prevCart, {
        lineId: `new-${product.id}-${Date.now()}`,
        id: product.id,
        name: product.name,
        price: unitPrice,
        quantity,
        options,
      }];
    });
  };

  // Món có nhóm tùy chọn → mở bảng chọn Size/Sốt...; món thường → thêm thẳng
  const addToCart = (product: any) => {
    if (product.option_groups?.length) {
      setOptionProduct(product);
      return;
    }
    addLine(product, [], 1);
  };

  const updateQuantity = (lineId: string, delta: number) => {
    setCart(prevCart =>
      prevCart.map(item => {
        if (item.lineId === lineId) {
          if (item.orderItemId) return item;
          const newQty = item.quantity + delta;
          return newQty > 0 ? { ...item, quantity: newQty } : item;
        }
        return item;
      })
    );
  };

  const removeFromCart = (lineId: string) => {
    setCart(prevCart => prevCart.filter(item => item.lineId !== lineId));
  };

  // Tặng / bỏ tặng một dòng (chỉ dòng chưa lưu; dòng đã lưu là hóa đơn bất biến)
  const setLineComp = (lineId: string, reason: string | undefined) => {
    setCart(prevCart => prevCart.map(item => (item.lineId === lineId ? { ...item, comp: reason } : item)));
  };

  // Tính toán số tiền trong giỏ hàng
  const subtotal = cart.reduce((sum, item) => sum + linePrice(item) * item.quantity, 0);
  const cartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  
  const getDiscount = () => {
    if (!voucher) return 0;
    if (subtotal < voucher.min_order_value) return 0;
    if (voucher.discount_type === "amount") {
      return Math.min(voucher.value, subtotal);
    } else {
      return Math.floor(subtotal * (voucher.value / 100));
    }
  };

  const discount = getDiscount();
  const total = Math.max(0, subtotal - discount);

  // Xử lý tạo đơn hàng (Hỗ trợ Online & Offline)
  const handleCheckout = (isDraft: boolean = false, sendToKitchen: boolean = false) => {
    if (cart.length === 0) return;
    setCheckoutError("");
    if (sendToKitchen && !selectedTable) {
      setCheckoutError("Vui lòng chọn bàn trước khi báo bếp.");
      return;
    }
    if (sendToKitchen && !isOnline) {
      setCheckoutError("Thiết bị đang offline, không thể báo bếp ngay. Vui lòng kết nối mạng.");
      return;
    }
    
    // Nếu thiết bị mất mạng (Offline), lưu đơn vào LocalStorage Queue
    if (!isOnline) {
      // Hàng đợi offline chỉ chứa đơn bán đứt. Đơn bàn đang mở / lưu nháp cần
      // server (món đã lưu nằm trong DB) — tạo đơn offline sẽ nhân đôi món.
      if (isDraft || activeOrder) {
        setCheckoutError(
          activeOrder
            ? "Bàn này đang có đơn mở trên hệ thống — cần có mạng để thêm món hoặc thanh toán."
            : "Đang offline: chỉ thanh toán ngay được, không lưu nháp/báo bếp."
        );
        return;
      }
      const offlineOrder = saveOfflineOrder({
        customer_id: customer?.id ?? null,
        customer_phone: customer?.phone,
        customer_name: customer?.name,
        voucher_code: voucher?.code ?? null,
        table_id: selectedTable?.id || undefined,
        payment_method: paymentMethod,
        total_amount: subtotal,
        discount_amount: discount,
        items: cart.map(item => ({
          ...toOrderLine(item),
          product_name: lineDisplayName(item.name, item.options),
          unit_price: item.price,
        }))
      });

      setCart([]);
      setCustomer(null);
      setVoucher(null);
      setVoucherCode("");
      setPhoneSearch("");
      setSelectedTable(null);
      setCheckoutSuccess("Đã lưu đơn offline, chờ đồng bộ.");

      // Hiển thị hóa đơn cho đơn offline
      setSelectedOrderForReceipt({
        id: offlineOrder.local_id,
        date: offlineOrder.created_at,
        customer_name: customer?.name || "Khách lẻ (Offline)",
        total_amount: subtotal,
        discount_amount: discount,
        final_amount: total,
        payment_method: paymentLabel(paymentMethod),
        items: cart.map(toReceiptItem)
      });
      setIsReceiptModalOpen(true);
      setTimeout(() => setCheckoutSuccess(""), 5000);
      return;
    }
    
    if (activeOrder) {
      const newItems = cart.filter(item => !item.orderItemId);
      if (isDraft && newItems.length === 0) {
        setCheckoutError("Chưa có món mới để cập nhật cho đơn bàn này.");
        return;
      }

      // Chỉ thêm món (khách và voucher giữ nguyên) → add_items_to_order.
      // Đổi khách / voucher hoặc thanh toán → complete_draft_order như trước.
      const sameCustomer = (customer?.id ?? null) === (activeOrder.customer?.id ?? activeOrder.customer_id ?? null);
      const sameVoucher = (voucher?.code || "").toUpperCase() === (activeOrder.voucher?.code || "").toUpperCase();
      if (isDraft && sameCustomer && sameVoucher) {
        createOrderMutation.mutate({
          add_items_order_id: activeOrder.id,
          send_to_kitchen: sendToKitchen,
          items: newItems.map(toOrderLine),
          receipt_items: cart.map(toReceiptItem),
        });
        return;
      }

      createOrderMutation.mutate({
        complete_order_id: activeOrder.id,
        customer_id: customer?.id || null,
        customer_name: customer?.name || activeOrder.customer_name,
        voucher_code: voucher?.code || null,
        points_to_redeem: 0,
        status: isDraft ? "draft" : "completed",
        send_to_kitchen: sendToKitchen,
        payments: isDraft ? [] : [{ method: paymentMethod, amount: total }],
        payment_method: paymentMethod,
        total_amount: subtotal,
        discount_amount: discount,
        final_amount: total,
        items: newItems.map(toOrderLine),
        receipt_items: cart.map(toReceiptItem),
      });
      return;
    }

    const payload = {
      customer_id: customer?.id || null,
      voucher_code: voucher?.code || null,
      items: cart.map(toOrderLine),
      receipt_items: cart.map(toReceiptItem),
      payments: isDraft ? [] : [{ method: paymentMethod, amount: total }],
      payment_method: paymentMethod,
      total_amount: subtotal,
      final_amount: total,
      table_id: selectedTable?.id || null,
      status: isDraft ? "draft" : "completed",
      send_to_kitchen: sendToKitchen,
      points_to_redeem: 0
    };
    
    createOrderMutation.mutate(payload);
  };

  const handlePhoneSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneSearch.trim()) return;
    searchCustomerMutation.mutate(phoneSearch);
  };

  const handleVoucherSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!voucherCode.trim()) return;
    searchVoucherMutation.mutate(voucherCode);
  };

  const handleCancelOrder = (orderId: number) => {
    const reason = prompt("Nhập lý do hủy đơn hàng này:");
    if (reason === null) return; // Cancelled prompt
    cancelOrderMutation.mutate({ orderId, reason: reason || "Yêu cầu từ nhân viên" });
  };

  const handleViewReceipt = (order: any) => {
    setSelectedOrderForReceipt({
      id: order.id,
      date: order.date,
      customer_name: order.customer_name,
      total_amount: order.total_amount,
      discount_amount: order.discount_amount,
      final_amount: order.final_amount,
      payment_method: order.payment_method,
      items: order.items.map((item: any) => ({
        product_name: lineDisplayName(item.product_name, item.options),
        quantity: item.quantity,
        price: item.price,
        comp: Boolean(item.is_comp),
        comp_value: Number(item.comp_value || 0),
      }))
    });
    setIsReceiptModalOpen(true);
  };

  const loadOpenOrderForTable = async (table: any) => {
    try {
      const res = await api.get(`/api/v1/pos/tables/${table.id}/open-order`);
      const order = res.data;
      setActiveOrder(order);
      setCustomer(order?.customer || null);
      setVoucher(order?.voucher || null);
      setVoucherCode(order?.voucher?.code || "");
      setPhoneSearch(order?.customer?.phone || "");
      if (order?.items?.length) {
        setCart(order.items.map((item: any) => ({
          lineId: `existing-${item.id}`,
          id: item.product_id,
          name: item.product_name,
          price: item.is_comp ? Number(item.comp_value || 0) : item.price,
          quantity: item.quantity,
          options: item.options || [],
          status: item.status,
          orderItemId: item.id,
          comp: item.is_comp ? item.comp_reason || "Tặng" : undefined,
        })));
      } else {
        setCart([]);
      }
    } catch (err: any) {
      setActiveOrder(null);
      setCart([]);
      setCheckoutError(err.response?.data?.detail || "Không tải được đơn đang mở của bàn.");
    }
  };

  const handleTableSelect = (table: any) => {
    setSelectedTable(table);
    setActiveTab("menu");
    loadOpenOrderForTable(table);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem("melio_token");
    window.location.reload();
  };

  // Lọc sản phẩm
  const categories: string[] = ["Tất cả", ...Array.from(new Set<string>(products?.map((p: any) => p.category as string) || []))];
  const filteredProducts = products?.filter((p: any) => {
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === "Tất cả" || p.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });
  const kitchenOrders = (orders || []).filter((order: any) =>
    order.status === "draft" && order.items?.some((item: any) => item.status !== "served")
  );
  const todayOrderHistory = (orders || []).filter((order: any) => {
    const orderDate = new Date(order.date);
    const now = new Date();
    return orderDate.toDateString() === now.toDateString();
  });
  const visibleOrderHistory = isStaff ? todayOrderHistory : (orders || []);
  const todayCompletedOrderCount = todayOrderHistory.filter((order: any) => order.status === "completed").length;
  const kitchenItemCount = kitchenOrders.reduce((sum: number, order: any) => sum + pendingKitchenItemCount(order), 0);
  const openOrdersByTable = new Map<number, any>(
    (orders || [])
      .filter((order: any) => order.status === "draft" && order.table_id)
      .map((order: any): [number, any] => [Number(order.table_id), order])
  );
  const shouldShowAreaName = areas.length > 1;

  if (isStaff && !selectedTable && activeTab !== "orders") {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 px-4 py-5 md:px-8 md:py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <header className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">Chọn bàn</h1>
              <p className="mt-1 text-xs font-semibold text-slate-500">Chọn bàn để bắt đầu gọi món</p>
            </div>
            <div className="ml-auto">
              <OfflineRejectedOrders orders={rejectedOrders} onRetry={retryOfflineOrder} onDiscard={discardOrder} />
            </div>
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              <span>Đăng xuất</span>
            </button>
          </header>

          {tablesLoading ? (
            <div className="flex min-h-64 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/40">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
            </div>
          ) : tables.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/40 px-4 text-center text-sm font-semibold text-slate-500">
              Chưa có bàn nào được cấu hình
            </div>
          ) : (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {tables.map((table: any) => (
                <button
                  key={table.id}
                  onClick={() => handleTableSelect(table)}
                  className={`relative flex min-h-28 flex-col items-center justify-center rounded-2xl border p-4 text-center transition-all hover:border-indigo-500 hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    openOrdersByTable.has(table.id) ? "border-amber-500/50 bg-amber-500/10" : "border-slate-800 bg-slate-900/70"
                  }`}
                >
                  {openOrdersByTable.has(table.id) && (
                    <span className="absolute right-2 top-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-slate-950">
                      {orderItemCount(openOrdersByTable.get(table.id))} món
                    </span>
                  )}
                  <span className="text-base font-bold text-slate-100">{table.name}</span>
                  {shouldShowAreaName && (
                    <span className="mt-1 text-xs font-semibold text-slate-500">
                      {areas.find((area: any) => area.id === table.area_id)?.name || "Khu vực"}
                    </span>
                  )}
                </button>
              ))}
            </section>
          )}
        </div>
        <button
          onClick={() => {
            setActiveTab("orders");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-white shadow-2xl shadow-slate-950/40"
          title="Xem đơn hôm nay"
        >
          <Clock className="h-5 w-5" />
          {todayCompletedOrderCount > 0 && (
            <span className="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-slate-950">
              {todayCompletedOrderCount}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 w-full lg:h-[calc(100vh-8rem)]">
      
      {/* Left Area: Product Menu or Orders History */}
      <div className="flex-1 flex flex-col lg:h-full overflow-hidden">
        
        {/* Header and navigation tabs */}
        <div className="flex flex-col gap-3 mb-6 shrink-0">
          {/* Hàng 1: tiêu đề + công cụ (tự xuống dòng khi hẹp). Hàng 2: tab, luôn đủ chiều ngang */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-bold text-slate-100 tracking-tight">Cửa hàng POS</h1>
              <p className="text-slate-500 text-xs mt-0.5">Quản lý bán hàng &amp; Chốt ca làm việc</p>
            </div>
            <div className="flex flex-wrap items-center justify-start sm:justify-end gap-2 w-full sm:w-auto">
              {/* Badge Trạng thái Kết nối Mạng Online / Offline */}
              <div className="flex items-center space-x-2">
                {isOnline ? (
                  <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-800/60 dark:text-emerald-400 rounded-xl text-xs font-semibold">
                    <Wifi className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 animate-pulse" />
                    <span>ONLINE</span>
                  </div>
                ) : (
                  <div className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-50 border border-amber-300 text-amber-800 dark:bg-amber-950/50 dark:border-amber-800/80 dark:text-amber-300 rounded-xl text-xs font-semibold">
                    <WifiOff className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                    <span>OFFLINE {pendingCount > 0 && `(${pendingCount} chờ sync)`}</span>
                  </div>
                )}

                {pendingCount > 0 && isOnline && (
                  <button
                    onClick={() => syncPendingOrders()}
                    disabled={isSyncing}
                    className="flex items-center space-x-1 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition-all shadow"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                    <span>{isSyncing ? "Đang sync..." : `Sync (${pendingCount})`}</span>
                  </button>
                )}

                <OfflineRejectedOrders orders={rejectedOrders} onRetry={retryOfflineOrder} onDiscard={discardOrder} />
              </div>

              <button
                onClick={() => setIsShiftModalOpen(true)}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-850 text-slate-200 border border-slate-800 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition-all shadow-sm shrink-0"
              >
                <Unlock className="w-3.5 h-3.5 text-emerald-400" />
                <span>Chốt/Khai ca</span>
              </button>
              
              {activeTab === "menu" && (
                <div className="relative w-full sm:w-56 xl:w-64">
                  <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-500">
                    <Search className="w-4 h-4" />
                  </span>
                  <input 
                    type="text" 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Tìm món ăn, trà sữa..." 
                    className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="flex w-fit max-w-full self-start space-x-1 overflow-x-auto p-0.5 bg-slate-900 border border-slate-800 rounded-xl no-scrollbar">
            <button
              onClick={() => setActiveTab("menu")}
              className={`shrink-0 px-3 py-2 rounded-lg text-xs font-semibold flex items-center space-x-1 transition-all ${
                activeTab === "menu"
                  ? "bg-indigo-600 text-white shadow"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Thực đơn</span>
            </button>
            <button
              onClick={() => setActiveTab("orders")}
              className={`shrink-0 px-3 py-2 rounded-lg text-xs font-semibold flex items-center space-x-1 transition-all ${
                activeTab === "orders"
                  ? "bg-indigo-600 text-white shadow"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Đơn hàng gần đây</span>
            </button>
            <button
              onClick={() => setActiveTab("kitchen")}
              className={`shrink-0 px-3 py-2 rounded-lg text-xs font-semibold flex items-center space-x-1 transition-all ${
                activeTab === "kitchen"
                  ? "bg-indigo-600 text-white shadow"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <ChefHat className="w-3.5 h-3.5" />
              <span>Bếp</span>
              {kitchenItemCount > 0 && (
                <span className="ml-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-slate-950">
                  {kitchenItemCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("tables")}
              className={`shrink-0 px-3 py-2 rounded-lg text-xs font-semibold flex items-center space-x-1 transition-all ${
                activeTab === "tables"
                  ? "bg-indigo-600 text-white shadow"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Ticket className="w-3.5 h-3.5" />
              <span>Tại bàn</span>
            </button>
          </div>
        </div>

        {/* Tab 1: Product Menu */}
        {activeTab === "menu" ? (
          <>
            {/* Category tabs */}
            <div className="flex space-x-2 mb-6 overflow-x-auto shrink-0 pb-1">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                    selectedCategory === cat
                      ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "bg-slate-900 text-slate-400 hover:text-white border border-slate-800"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Product Cards Grid */}
            {/* auto-rows-max: hàng cao đúng bằng thẻ. Không có nó, lưới bị giới hạn
                chiều cao sẽ nén các hàng (thẻ overflow-hidden có min-height 0) → thẻ đè nhau */}
            <div className="flex-1 overflow-y-auto pr-1 grid auto-rows-max content-start grid-cols-2 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 md:gap-4 pb-28 lg:pb-8">
              {filteredProducts?.map((product: any) => (
                <div 
                  key={product.id}
                  onClick={() => addToCart(product)}
                  className="glass-card rounded-2xl overflow-hidden cursor-pointer group flex flex-col h-fit"
                >
                  <div className="relative aspect-video w-full overflow-hidden bg-slate-900">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img 
                      src={product.image_url || "https://images.unsplash.com/photo-1541658016709-82535e94bc69?w=300"} 
                      alt={product.name} 
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                    <div className="absolute top-2 right-2 bg-slate-900/90 backdrop-blur px-2.5 py-1 rounded-lg text-[10px] text-indigo-700 dark:text-indigo-300 font-bold border border-slate-800/60 shadow-sm">
                      {product.category}
                    </div>
                  </div>
                  <div className="p-3 md:p-4 flex flex-col">
                    <span className="text-sm font-bold text-slate-200 block truncate group-hover:text-indigo-400 transition-colors">
                      {product.name}
                    </span>
                    {product.option_groups?.length > 0 && (
                      <span className="mt-1 block truncate text-[11px] font-semibold text-slate-500">
                        {product.option_groups.map((group: any) => group.name).join(" · ")}
                      </span>
                    )}
                    <div className="flex justify-between items-center gap-2 mt-3">
                      <span className="min-w-0 truncate text-sm font-bold text-emerald-600 dark:text-emerald-400">
                        {product.option_groups?.length > 0 && <span className="mr-1 text-[10px] font-semibold text-slate-500">từ</span>}
                        {minUnitPrice(product).toLocaleString("vi-VN")}đ
                      </span>
                      <div className="w-8 h-8 rounded-lg bg-indigo-600/10 text-indigo-400 flex items-center justify-center hover:bg-indigo-600 hover:text-white transition-all shrink-0">
                        <Plus className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : activeTab === "orders" ? (
          <OrderHistoryTab
            orders={visibleOrderHistory}
            isStaff={isStaff}
            onViewReceipt={handleViewReceipt}
            onCancelOrder={handleCancelOrder}
          />
        ) : activeTab === "kitchen" ? (
          <KitchenTab
            orders={kitchenOrders}
            tables={tables}
            serving={updateOrderItemStatusMutation.isPending}
            onServe={(itemId) => updateOrderItemStatusMutation.mutate({ itemId, status: "served" })}
          />
        ) : (
          <TablesTab
            tables={tables}
            areas={areas}
            selectedTableId={selectedTable?.id ?? null}
            openOrdersByTable={openOrdersByTable}
            onSelect={handleTableSelect}
          />
        )}
      </div>

      {/* Right Area: Cart Checkout Drawer */}
      <div id="pos-cart" className="w-full lg:w-[320px] xl:w-[360px] 2xl:w-[380px] glass-panel border border-slate-900 rounded-2xl lg:h-full flex flex-col shrink-0 overflow-hidden scroll-mt-4">
        
        {/* Header info */}
        <div className="px-6 py-6 border-b border-slate-800 flex items-center space-x-2 text-slate-100 shrink-0 bg-slate-950/20">
          <ShoppingCart className="w-5 h-5 text-indigo-400" />
          <span className="font-bold text-lg">Giỏ Hàng</span>
          <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 px-2 py-0.5 rounded-lg font-bold ml-auto">
            {cartItemCount} món
          </span>
        </div>

        {/* Cart Items list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {checkoutSuccess && (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs rounded-xl flex items-start space-x-2">
              <Check className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{checkoutSuccess}</span>
            </div>
          )}
          {checkoutError && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs rounded-xl flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{checkoutError}</span>
            </div>
          )}

          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-650 py-12">
              <ShoppingCart className="w-12 h-12 mb-3 stroke-[1.5] text-slate-600" />
              <span className="text-xs font-semibold text-slate-500">Giỏ hàng đang trống</span>
            </div>
          ) : (
            cart.map(item => (
              <div key={item.lineId} className="flex justify-between items-center p-3 bg-slate-900/40 border border-slate-800/80 rounded-xl">
                <div className="flex-1 min-w-0 pr-2">
                  <span className="text-sm font-semibold text-slate-200 block truncate">{item.name}</span>
                  {item.options.length > 0 && (
                    <span className="mt-0.5 block text-[11px] font-semibold leading-snug text-slate-400">
                      {optionSummary(item.options)}
                    </span>
                  )}
                  {item.comp ? (
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="inline-flex items-center gap-1 rounded-full bg-pink-50 px-2 py-0.5 text-[10px] font-bold text-pink-700 dark:bg-pink-500/10 dark:text-pink-300">
                        <Gift className="h-3 w-3" /> Tặng
                      </span>
                      <span className="text-slate-500 line-through">{(item.price * item.quantity).toLocaleString("vi-VN")}đ</span>
                      <span className="text-[10px] text-slate-500 truncate">· {item.comp}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold block mt-1">{(item.price * item.quantity).toLocaleString("vi-VN")}đ</span>
                  )}
                  {item.status && (
                    <span className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      item.status === "served"
                        ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                        : "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                    }`}>
                      {item.status === "served" ? "Bếp xong" : "Đang làm"}
                    </span>
                  )}
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  <button
                    onClick={() =>
                      item.comp
                        ? setLineComp(item.lineId, undefined)
                        : setCompLine({ lineId: item.lineId, name: item.name, reason: "" })
                    }
                    disabled={Boolean(item.orderItemId)}
                    title={item.comp ? "Bỏ tặng" : "Tặng món này cho khách"}
                    aria-label={item.comp ? `Bỏ tặng ${item.name}` : `Tặng ${item.name}`}
                    className={`p-1 rounded transition-colors disabled:opacity-40 ${
                      item.comp ? "text-pink-600 dark:text-pink-300" : "text-slate-500 hover:text-pink-600"
                    }`}
                  >
                    <Gift className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => updateQuantity(item.lineId, -1)}
                    disabled={Boolean(item.orderItemId)}
                    className="w-6.5 h-6.5 bg-slate-850 text-slate-400 hover:text-white rounded flex items-center justify-center hover:bg-slate-800 transition-colors"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="text-xs font-bold text-slate-200 w-6 text-center">{item.quantity}</span>
                  <button 
                    onClick={() => updateQuantity(item.lineId, 1)}
                    disabled={Boolean(item.orderItemId)}
                    className="w-6.5 h-6.5 bg-slate-850 text-slate-400 hover:text-white rounded flex items-center justify-center hover:bg-slate-800 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                  <button 
                    onClick={() => !item.orderItemId && removeFromCart(item.lineId)}
                    disabled={Boolean(item.orderItemId)}
                    className="text-slate-600 hover:text-rose-400 p-1 transition-colors"
                  >
                    <Trash2 className="w-4.5 h-4.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Cart Utilities: Customer & Voucher inputs */}
        {cart.length > 0 && (
          <div className="px-6 py-4 border-t border-slate-800/60 bg-slate-900/10 space-y-3 shrink-0">
            {/* Customer search */}
            <form onSubmit={handlePhoneSearchSubmit} className="flex items-center space-x-2">
              <div className="relative flex-1">
                <User className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
                <input 
                  type="text" 
                  value={phoneSearch}
                  onChange={(e) => setPhoneSearch(e.target.value)}
                  placeholder="SĐT Khách thân thiết" 
                  className="w-full pl-8 pr-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <button 
                type="submit"
                className="bg-slate-850 hover:bg-slate-800 text-slate-300 hover:text-white px-3.5 py-2 rounded-xl text-xs border border-slate-850 transition-all font-semibold shrink-0"
              >
                Tìm
              </button>
            </form>

            {customer && (
              <div className="flex items-center justify-between p-2.5 bg-indigo-500/5 border border-indigo-500/25 rounded-xl">
                <div>
                  <span className="text-xs font-semibold text-indigo-400 block">{customer.name}</span>
                  <span className="text-[10px] text-slate-550 block font-semibold">Tích lũy: {customer.points} điểm</span>
                </div>
                <button 
                  onClick={() => setCustomer(null)}
                  className="text-[10px] text-slate-450 hover:text-rose-400 font-semibold"
                >
                  Gỡ bỏ
                </button>
              </div>
            )}

            {/* Voucher input */}
            <form onSubmit={handleVoucherSearchSubmit} className="flex items-center space-x-2">
              <div className="relative flex-1">
                <Tag className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
                <input 
                  type="text" 
                  value={voucherCode}
                  onChange={(e) => setVoucherCode(e.target.value.toUpperCase())}
                  placeholder="Nhập mã giảm giá Voucher" 
                  className="w-full pl-8 pr-3 py-2 bg-slate-950 border border-slate-850 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <button 
                type="submit"
                className="bg-slate-850 hover:bg-slate-800 text-slate-300 hover:text-white px-3.5 py-2 rounded-xl text-xs border border-slate-850 transition-all font-semibold shrink-0"
              >
                Áp mã
              </button>
            </form>

            {voucher && (
              <div className="flex items-center justify-between p-2.5 bg-emerald-500/5 border border-emerald-500/25 rounded-xl">
                <div className="flex items-center space-x-1.5">
                  <Ticket className="w-4.5 h-4.5 text-emerald-400" />
                  <div>
                    <span className="text-xs font-semibold text-emerald-400 block">{voucher.code}</span>
                    <span className="text-[10px] text-slate-500">
                      Khấu trừ: {voucher.discount_type === "amount" ? `${voucher.value.toLocaleString()}đ` : `${voucher.value}%`}
                    </span>
                  </div>
                </div>
                <button 
                  onClick={() => setVoucher(null)}
                  className="text-[10px] text-slate-400 hover:text-rose-400 font-semibold"
                >
                  Gỡ
                </button>
              </div>
            )}
          </div>
        )}

        {/* Billing details & Payment */}
        <div className="px-4 py-4 xl:px-6 xl:py-6 border-t border-slate-800 space-y-4 shrink-0 bg-slate-950 lg:max-h-[62%] lg:overflow-y-auto">
          <div className="space-y-1.5 text-xs text-slate-400">
            <div className="flex justify-between">
              <span>Tạm tính</span>
              <span className="font-semibold text-slate-200">{subtotal.toLocaleString("vi-VN")}đ</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-rose-400">
                <span>Giảm giá chiết khấu</span>
                <span>-{discount.toLocaleString("vi-VN")}đ</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-bold text-slate-100 pt-2 border-t border-slate-900">
              <span>Khách thanh toán</span>
              <span className="text-lg text-emerald-400 font-bold">{total.toLocaleString("vi-VN")}đ</span>
            </div>
          </div>

          {/* Payment selector */}
          {cart.length > 0 && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {PAYMENT_METHODS.map(method => (
                <button
                  key={method.value}
                  onClick={() => setPaymentMethod(method.value)}
                  className={`py-2 rounded-lg border font-semibold flex items-center justify-center space-x-1 transition-all ${
                    paymentMethod === method.value
                      ? "bg-indigo-600/90 text-white border-indigo-600 shadow"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white"
                  }`}
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  <span>{method.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* VietQR thật (chuẩn NAPAS): số tiền điền sẵn, app ngân hàng nào cũng quét được */}
          {paymentMethod === "bank_transfer" && cart.length > 0 && (() => {
            const qrUrl = branchProfile ? vietQrUrl(branchProfile, total, "Thanh toan don hang") : null;
            return (
              <div className="p-3.5 bg-slate-900 border border-slate-850 rounded-2xl flex flex-col items-center space-y-2">
                {qrUrl ? (
                  <>
                    <div className="w-40 h-40 xl:w-44 xl:h-44 bg-white p-1.5 rounded-xl flex items-center justify-center border border-slate-250 overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={qrUrl} alt={`Mã VietQR chuyển khoản ${total.toLocaleString("vi-VN")}đ`} className="w-full h-full object-contain" />
                    </div>
                    <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider block">
                      Quét QR chuyển khoản · {total.toLocaleString("vi-VN")}đ
                    </span>
                  </>
                ) : (
                  <p className="text-xs text-center text-slate-400">
                    Chưa cài tài khoản nhận chuyển khoản. Chủ quán vào <b>Thông tin quán</b> để thêm ngân hàng và số tài khoản.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Nút luôn nhìn thấy, kể cả khi phần trên (QR) phải cuộn */}
          <div className="grid grid-cols-3 gap-2 sticky bottom-0 -mx-1 px-1 pt-2 bg-slate-950">
            <button
              disabled={cart.length === 0 || createOrderMutation.isPending}
              onClick={() => handleCheckout(true)}
              className="bg-slate-800 hover:bg-slate-700 disabled:bg-slate-850 disabled:text-slate-500 disabled:border disabled:border-slate-800 text-slate-100 font-bold py-3.5 rounded-xl transition-all text-xs flex justify-center items-center"
            >
              Lưu nháp (Bàn)
            </button>
            <button
              disabled={cart.length === 0 || createOrderMutation.isPending}
              onClick={() => handleCheckout(true, true)}
              className="bg-amber-600 hover:bg-amber-500 disabled:bg-slate-850 disabled:text-slate-500 disabled:border disabled:border-slate-800 disabled:shadow-none text-white font-bold py-3.5 rounded-xl transition-all text-xs flex justify-center items-center gap-1.5"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Báo bếp</span>
            </button>
            <button
              disabled={cart.length === 0 || createOrderMutation.isPending}
              onClick={() => handleCheckout(false)}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-850 disabled:text-slate-500 disabled:border disabled:border-slate-800 disabled:shadow-none text-white font-bold py-3.5 rounded-xl shadow-lg shadow-emerald-600/10 hover:shadow-emerald-500/20 transition-all text-xs flex justify-center items-center"
            >
              {createOrderMutation.isPending ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              ) : (
                "Thanh toán"
              )}
            </button>
          </div>
        </div>
      </div>

      {cartItemCount > 0 && showFloatingCart && (
        <button
          onClick={() => document.getElementById("pos-cart")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] left-1/2 z-50 flex w-[min(21rem,calc(100vw-2rem))] -translate-x-1/2 items-center justify-between rounded-full border border-indigo-300/30 bg-indigo-600 px-4 py-2.5 text-white shadow-2xl shadow-indigo-950/50 lg:hidden"
        >
          <span className="flex items-center gap-2 text-xs font-bold">
            <ShoppingCart className="h-4 w-4" />
            <span>{cartItemCount} món</span>
          </span>
          <span className="text-sm font-extrabold">{total.toLocaleString("vi-VN")}đ</span>
        </button>
      )}

      <button
        onClick={() => {
          setActiveTab("orders");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        className={`fixed right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border shadow-2xl lg:hidden ${
          cartItemCount > 0 && showFloatingCart
            ? "bottom-[calc(env(safe-area-inset-bottom)+4.75rem)]"
            : "bottom-[calc(env(safe-area-inset-bottom)+1rem)]"
        } border-slate-700 bg-slate-900 text-slate-200 shadow-slate-950/40`}
        title={isStaff ? "Xem đơn hôm nay" : "Xem lịch sử đơn"}
      >
        <Clock className="h-5 w-5" />
        {todayCompletedOrderCount > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-slate-950">
            {todayCompletedOrderCount}
          </span>
        )}
      </button>

      {/* Modals wrappers */}
      <ShiftModal isOpen={isShiftModalOpen} onClose={() => setIsShiftModalOpen(false)} />

      {optionProduct && (
        <ProductOptionsModal
          key={optionProduct.id}
          product={optionProduct}
          onClose={() => setOptionProduct(null)}
          onConfirm={({ options, quantity }) => {
            addLine(optionProduct, options, quantity);
            setOptionProduct(null);
          }}
        />
      )}
      
      {compLine && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 backdrop-blur-sm sm:items-center sm:p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const reason = compLine.reason.trim();
              if (!reason) return;
              setLineComp(compLine.lineId, reason);
              setCompLine(null);
            }}
            className="w-full max-w-sm space-y-4 rounded-t-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl sm:rounded-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-bold text-slate-100">
                  <Gift className="h-5 w-5 text-pink-500" /> Tặng món
                </h3>
                <p className="text-xs text-slate-500">
                  {compLine.name} · khách không phải trả, nhưng vẫn ghi lại người tặng và lý do để kiểm tra.
                </p>
              </div>
              <button type="button" onClick={() => setCompLine(null)} className="text-slate-500 hover:text-slate-200" aria-label="Đóng">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {COMP_REASONS.map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setCompLine({ ...compLine, reason: r })}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                    compLine.reason === r
                      ? "border-pink-500 bg-pink-50 text-pink-700 dark:bg-pink-500/10 dark:text-pink-300"
                      : "border-slate-800 text-slate-300 hover:border-pink-400"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <div>
              <label htmlFor="comp-reason" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Lý do (bắt buộc)
              </label>
              <input
                id="comp-reason"
                type="text"
                maxLength={120}
                autoFocus
                value={compLine.reason}
                onChange={(e) => setCompLine({ ...compLine, reason: e.target.value })}
                placeholder="VD: Khách quen, tặng trà tắc"
                className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 focus:border-pink-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={!compLine.reason.trim()}
              className="w-full rounded-xl bg-pink-600 py-2.5 text-sm font-semibold text-white hover:bg-pink-500 disabled:opacity-50"
            >
              Tặng món này
            </button>
          </form>
        </div>
      )}

      <ReceiptModal 
        isOpen={isReceiptModalOpen} 
        onClose={() => {
          setIsReceiptModalOpen(false);
          setSelectedOrderForReceipt(null);
        }} 
        order={selectedOrderForReceipt} 
      />

    </div>
  );
}

export default function POS() {
  return (
    <ShiftGuard>
      <POSContent />
    </ShiftGuard>
  );
}
