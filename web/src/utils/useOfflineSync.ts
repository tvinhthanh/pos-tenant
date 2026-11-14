import { useState, useEffect, useCallback, useRef } from "react";
import api from "./api";
import {
  discardOfflineOrder,
  getPendingOrders,
  removeSyncedOrders,
  updateOfflineOrdersStatus,
  OfflineOrder,
} from "./offlineStore";

// Trạng thái được tự động gửi lại. "syncing" còn sót = tab bị đóng giữa chừng;
// gửi lại an toàn vì server chống trùng theo offline_ref = local_id.
const AUTO_SYNC_STATUSES = new Set(["pending_sync", "failed", "syncing"]);

export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [pendingOrders, setPendingOrders] = useState<OfflineOrder[]>([]);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  // Chặn chạy chồng (sự kiện online + interval cùng lúc) ngay trong một lần render
  const syncingRef = useRef(false);

  // Cập nhật lại danh sách đơn chờ đồng bộ từ LocalStorage
  const refreshPendingCount = useCallback(() => {
    const orders = getPendingOrders();
    setPendingOrders(orders);
  }, []);

  // Hàm thực thi đồng bộ các đơn offline lên Backend DB
  const syncPendingOrders = useCallback(async () => {
    if (syncingRef.current || typeof window === "undefined") return;

    const ordersToSync = getPendingOrders().filter((o) => AUTO_SYNC_STATUSES.has(o.status));

    if (ordersToSync.length === 0) {
      refreshPendingCount();
      return;
    }

    syncingRef.current = true;
    setIsSyncing(true);
    const targetLocalIds = ordersToSync.map((o) => o.local_id);
    updateOfflineOrdersStatus(targetLocalIds, "syncing");

    try {
      const response = await api.post("/api/v1/pos/orders/sync-batch", {
        orders: ordersToSync,
      });

      const syncedIds: string[] = response.data?.synced_local_ids || [];
      const failed: { local_id: string; error: string; permanent: boolean }[] = response.data?.failed || [];
      if (syncedIds.length > 0) {
        removeSyncedOrders(syncedIds);
        setLastSyncTime(new Date());
      }
      // Lỗi dữ liệu → "rejected": dừng tự gửi, chờ nhân viên xử lý.
      // Lỗi mạng → "failed": lần sau tự thử lại.
      for (const row of failed) {
        updateOfflineOrdersStatus([row.local_id], row.permanent ? "rejected" : "failed", row.error);
      }
    } catch (err: any) {
      console.error("Lỗi khi đồng bộ đơn hàng offline lên Server:", err);
      updateOfflineOrdersStatus(
        targetLocalIds,
        "failed",
        err?.response?.data?.detail || "Không thể kết nối máy chủ backend"
      );
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
      refreshPendingCount();
    }
  }, [refreshPendingCount]);

  /** Nhân viên đã xử lý nguyên nhân (VD bật lại tùy chọn) → gửi lại đơn bị từ chối. */
  const retryOfflineOrder = useCallback((localId: string) => {
    updateOfflineOrdersStatus([localId], "pending_sync");
    refreshPendingCount();
    syncPendingOrders();
  }, [refreshPendingCount, syncPendingOrders]);

  /** Bỏ hẳn đơn bị từ chối (VD đã nhập lại bằng tay). */
  const discardOrder = useCallback((localId: string) => {
    discardOfflineOrder(localId);
    refreshPendingCount();
  }, [refreshPendingCount]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    setIsOnline(navigator.onLine);
    refreshPendingCount();

    const handleOnline = () => {
      setIsOnline(true);
      // Tự động đẩy sync khi có lại mạng
      syncPendingOrders();
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Chu kỳ tự động kiểm tra và sync mỗi 15 giây nếu có kết nối mạng
    const intervalId = setInterval(() => {
      if (navigator.onLine) {
        syncPendingOrders();
      }
    }, 15000);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearInterval(intervalId);
    };
  }, [refreshPendingCount, syncPendingOrders]);

  const rejectedOrders = pendingOrders.filter((o) => o.status === "rejected");

  return {
    isOnline,
    pendingOrders,
    /** Đơn còn đang chờ tự đồng bộ (không tính đơn bị từ chối) */
    pendingCount: pendingOrders.length - rejectedOrders.length,
    rejectedOrders,
    retryOfflineOrder,
    discardOrder,
    isSyncing,
    lastSyncTime,
    syncPendingOrders,
    refreshPendingCount,
  };
}
