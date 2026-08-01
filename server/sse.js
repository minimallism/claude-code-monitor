/**
 * Server-Sent Events (SSE) 广播模块。
 *
 * 职责：
 * 1. 维护所有已连接的 SSE 客户端集合。
 * 2. 提供 initSSE 供 /api/events/stream 路由使用，建立长连接并发送事件流。
 * 3. 提供 broadcast 把服务器端状态变化实时推送给所有前端页面。
 * 4. 定期清理失效连接，避免客户端断开但内存中仍保留响应对象。
 *
 * 设计要点：
 * - SSE 比 WebSocket 更轻量，且基于 HTTP，便于通过 tokenGuard 统一鉴权。
 * - 使用 "data: ...\n\n" 格式发送事件，前端 EventSource 自动解析。
 * - 30 秒一次 keepalive 注释行（: keepalive\n\n），防止中间代理/防火墙超时断连。
 * - 写失败时立即把响应对象从 clients 中删除，避免对同一失效连接反复写。
 */

const clients = new Set();

/**
 * 初始化一条 SSE 长连接。
 *
 * 设置必要响应头后把 res 加入 clients，并启动 keepalive 定时器。
 * 当请求关闭或出错时清理资源并更新连接计数。
 */
function initSSE(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  clients.add(res);
  broadcast("ws_connections", { count: getConnectionCount() });

  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      cleanupStale();
      clearInterval(keepalive);
    }
  }, 30000);

  const cleanup = () => {
    clients.delete(res);
    clearInterval(keepalive);
    cleanupStale();
    broadcast("ws_connections", { count: getConnectionCount() });
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

/**
 * 清理已无法写入的失效客户端。
 *
 * 通过发送一条无害的 stale 注释行探测连接，写失败则删除。
 */
function cleanupStale() {
  clients.forEach((client) => {
    try {
      client.write(": stale\n\n");
    } catch {
      clients.delete(client);
    }
  });
}

/**
 * 向所有存活客户端广播一条事件。
 *
 * @param {string} type - 事件类型，前端据此决定刷新哪部分 UI。
 * @param {*} data - 事件载荷，会被 JSON 序列化。
 */
function broadcast(type, data) {
  const message = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
  clients.forEach((client) => {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  });
}

function getConnectionCount() {
  return clients.size;
}

/**
 * 关闭所有 SSE 客户端连接。
 *
 * 主要用于服务优雅退出前清理，避免进程 hang 住。
 */
function closeSSEClients() {
  clients.forEach((client) => {
    try {
      client.end();
    } catch {
      /* empty */
    }
  });
  clients.clear();
}

module.exports = { initSSE, broadcast, getConnectionCount, closeSSEClients };
