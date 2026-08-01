import type { WSMessage } from "./types";

type Handler = (msg: WSMessage) => void;

type ConnectionHandler = (connected: boolean) => void;

// 保存所有消息处理器和连接状态处理器。
const handlers = new Set<Handler>();
const connectionHandlers = new Set<ConnectionHandler>();
let wsConnected = false;

/**
 * 全局事件总线：桥接 SSE 连接和 React 组件。
 *
 * - SSE 收到后端推送后调用 publish，广播给所有订阅者。
 * - 连接状态变化时调用 setConnected，触发 useConnectionStatus 重新渲染。
 * - 这里沿用了 "ws" 前缀的命名历史原因（早期使用 WebSocket），实际底层已是 SSE。
 */
export const eventBus = {
  subscribe(handler: Handler): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },

  // 由 useSSE 在收到新消息后调用，分发给所有订阅组件（如页面自动刷新逻辑）。
  publish(msg: WSMessage): void {
    handlers.forEach((handler) => handler(msg));
  },

  // 当前 SSE 是否处于连接状态。
  get connected(): boolean {
    return wsConnected;
  },

  // 由 useSSE 在 onopen/onerror 时调用，同步给所有监听连接状态的组件。
  setConnected(value: boolean): void {
    wsConnected = value;
    connectionHandlers.forEach((handler) => handler(value));
  },

  // useSyncExternalStore 使用的订阅接口；返回取消订阅函数。
  onConnection(handler: ConnectionHandler): () => void {
    connectionHandlers.add(handler);
    return () => connectionHandlers.delete(handler);
  },
};
