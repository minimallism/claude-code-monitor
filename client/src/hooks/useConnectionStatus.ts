import { useSyncExternalStore } from "react";
import { eventBus } from "../lib/eventBus";

/**
 * 返回当前 SSE 连接状态（true/false）。
 *
 * 使用 useSyncExternalStore 订阅 eventBus，保证 SSR 安全和并发特性。
 * 组件卸载时自动取消订阅。
 */
export function useConnectionStatus() {
  return useSyncExternalStore(
    eventBus.onConnection,
    () => eventBus.connected
  );
}
