const clients = new Set();

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

function cleanupStale() {
  clients.forEach((client) => {
    try {
      client.write(": stale\n\n");
    } catch {
      clients.delete(client);
    }
  });
}

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
