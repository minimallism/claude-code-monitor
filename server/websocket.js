const { WebSocketServer } = require("ws");
const { isHostAllowed, isWebSocketAuthorized } = require("./lib/security");

let wss = null;

function initWebSocket(server) {
  
  
  wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024,
    verifyClient(info, done) {
      if (!isHostAllowed(info.req.headers.host)) return done(false, 403, "host not allowed");
      if (!isWebSocketAuthorized(info.req)) return done(false, 401, "unauthorized");
      return done(true);
    },
  });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", (err) => {
      
      if (err.code !== "ECONNRESET") {
        console.warn("[WS] client error:", err.code || err.message);
      }
    });
  });

  
  const interval = setInterval(() => {
    if (!wss) {
      clearInterval(interval);
      return;
    }
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  interval.unref();

  wss.on("close", () => {
    clearInterval(interval);
  });

  return wss;
}

function broadcast(type, data) {
  if (!wss) return;
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch {
        
      }
    }
  });
}

function getConnectionCount() {
  if (!wss) return 0;
  let count = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === 1) count++;
  });
  return count;
}

function closeWebSocket() {
  if (!wss) return;
  wss.clients.forEach((client) => {
    try {
      client.terminate();
    } catch {
      
    }
  });
  try {
    wss.close();
  } catch {
    
  }
  wss = null;
}

module.exports = { initWebSocket, broadcast, getConnectionCount, closeWebSocket };
