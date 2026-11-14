/**
 * useSocket — Hook kết nối WebSocket với backend FastAPI dùng Redis pub/sub.
 * 
 * Dùng:
 *   const { lastEvent, isConnected } = useSocket({ branchId: 2 });
 * 
 * Tự động:
 *  - Lấy JWT từ localStorage
 *  - Kết nối ws://host/api/v1/ws?token=...&branch_id=...
 *  - Reconnect mỗi 3s nếu mất kết nối
 *  - Cleanup khi component unmount
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { API_URL } from "./api";

export type SocketEvent = {
  event: string;
  data: Record<string, unknown>;
};

interface UseSocketOptions {
  branchId: number | null;
  onEvent?: (evt: SocketEvent) => void;
}

export function useSocket({ branchId, onEvent }: UseSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<SocketEvent | null>(null);

  const connect = useCallback(() => {
    if (!branchId) return;

    const token = typeof window !== "undefined" ? localStorage.getItem("melio_token") : null;
    if (!token) return;

    // Chuyển http/https -> ws/wss
    const wsBase = API_URL.replace(/^http/, "ws");
    const url = `${wsBase}/api/v1/ws?token=${encodeURIComponent(token)}&branch_id=${branchId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onmessage = (e) => {
      try {
        const evt: SocketEvent = JSON.parse(e.data);
        setLastEvent(evt);
        onEvent?.(evt);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      // Reconnect sau 3 giây
      retryTimer.current = setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [branchId, onEvent]);

  useEffect(() => {
    connect();
    return () => {
      retryTimer.current && clearTimeout(retryTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { isConnected, lastEvent };
}
