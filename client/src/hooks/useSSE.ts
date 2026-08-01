import { useEffect, useRef, useCallback, useState } from "react";
import type { WSMessage } from "../lib/types";
import { eventBus } from "../lib/eventBus";
import { dashboardToken } from "../lib/api";

type MessageHandler = (msg: WSMessage) => void;

export function useSSE(onMessage: MessageHandler) {
  const esRef = useRef<EventSource | null>(null);
  const handlersRef = useRef<MessageHandler>(onMessage);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);
  const reconnectAttempts = useRef(0);

  handlersRef.current = onMessage;

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const existing = esRef.current;
    if (existing && existing.readyState === EventSource.OPEN) {
      return;
    }

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
        /* empty */
      }
    };

    es.onerror = () => {
      if (mountedRef.current) {
        setConnected(false);
        eventBus.setConnected(false);

        es.close();

        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 15000);
        reconnectAttempts.current++;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    esRef.current = es;
  }, []);

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
