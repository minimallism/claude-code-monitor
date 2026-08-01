import { useEffect, useRef, useCallback, useState } from "react";
import type { WSMessage } from "../lib/types";
import { eventBus } from "../lib/eventBus";
import { dashboardToken } from "../lib/api";

type MessageHandler = (msg: WSMessage) => void;

/**
 * SSE (Server-Sent Events) 连接 Hook。
 *
 * 设计要点：
 * - 使用原生 EventSource 替代 WebSocket，因为服务端只需要单向推送，且 SSE 自动支持断线重连语义。
 * - 所有可变状态尽量用 ref 保存（EventSource 实例、定时器、重试计数），避免闭包陈旧问题。
 * - handlersRef 保存最新的 onMessage，这样 EventSource 回调里总能调用到最新处理器，
 *   而不需要每次 onMessage 变化都重新创建连接。
 * - 重连策略：指数退避，最大 15 秒，窗口重新获得焦点或网络恢复时立即重连。
 */
export function useSSE(onMessage: MessageHandler) {
  const esRef = useRef<EventSource | null>(null);
  const handlersRef = useRef<MessageHandler>(onMessage);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);
  const reconnectAttempts = useRef(0);

  // 每次渲染都更新 handlersRef，保证回调永远是最新的。
  handlersRef.current = onMessage;

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // 如果已经存在 OPEN 的连接，避免重复创建。
    const existing = esRef.current;
    if (existing && existing.readyState === EventSource.OPEN) {
      return;
    }

    // 把 dashboard token 拼到 URL 查询参数中；SSE 不支持自定义请求头，所以用 URL 传 token。
    const token = dashboardToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const es = new EventSource(`/api/events/stream${query}`);

    es.onopen = () => {
      if (mountedRef.current) {
        setConnected(true);
        eventBus.setConnected(true);
        reconnectAttempts.current = 0;
      }
    };

    es.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WSMessage;
        handlersRef.current(message);
      } catch {
        // 非法 JSON 直接丢弃，避免一次坏消息导致整个连接不可用。
      }
    };

    es.onerror = () => {
      if (mountedRef.current) {
        setConnected(false);
        eventBus.setConnected(false);

        es.close();

        // 指数退避重连：1s, 2s, 4s... 最大 15s。
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 15000);
        reconnectAttempts.current++;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    esRef.current = es;
  }, []);

  // 组件挂载时建立连接，卸载时彻底清理：
  // - 清除未触发的重连定时器，避免内存泄漏。
  // - 把回调置空后再 close，防止 close 触发 onerror 又创建新的重连定时器。
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      const es = esRef.current;
      if (es) {
        es.onopen = null;
        es.onmessage = null;
        es.onerror = null;
        es.close();
        esRef.current = null;
      }
    };
  }, [connect]);

  // 监听窗口焦点恢复、网络恢复、页面重新可见，立即尝试重连（重置退避计数）。
  useEffect(() => {
    const reconnectNow = () => {
      if (!mountedRef.current) return;
      const es = esRef.current;
      if (es && es.readyState === EventSource.OPEN) {
        return;
      }
      clearTimeout(reconnectTimer.current);
      reconnectAttempts.current = 0;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };
    window.addEventListener("focus", reconnectNow);
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", reconnectNow);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connect]);

  return { connected };
}
