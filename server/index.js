// 默认以生产模式运行，这样 CLI 启动的进程会提供前端静态资源。
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

// 自实现 .env 加载：不依赖 dotenv 包，减少依赖。
// 规则：忽略空行和 # 注释；去掉首尾引号；把 ~/ 替换为当前用户主目录；
// 已存在的环境变量不会被覆盖（命令行/CLI 传入的优先级更高）。
(function loadDotEnv() {
  const fs = require("fs");
  const os = require("os");
  const envPath = require("path").resolve(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val.replace(/^~(?=\/)/, os.homedir());
    }
  }
})();

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { initSSE } = require("./sse");
const { cleanupOrphanedSessions } = require("./db");
const { writeServerInfo, removeServerInfo } = require("./lib/server-info");
const {
  resolveHost,
  isLoopbackHostname,
  corsOptions,
  hostGuard,
  tokenGuard,
  getDashboardToken,
} = require("./lib/security");

const sessionsRouter = require("./routes/sessions");
const agentsRouter = require("./routes/agents");
const statsRouter = require("./routes/stats");
const hooksRouter = require("./routes/hooks");
const analyticsRouter = require("./routes/analytics");
const settingsRouter = require("./routes/settings");
const projectsRouter = require("./routes/projects");
const processesRouter = require("./routes/processes");

/**
 * 创建 Express 应用实例。
 *
 * 中间件顺序说明：
 * 1. cors：允许跨域（开发/本地场景）。
 * 2. hostGuard：防止非预期的 Host 头访问（当绑定到非回环地址时尤为重要）。
 * 3. express.json：解析 JSON 请求体，限制 1MB。
 * 4. tokenGuard：/api 下所有路由（除显例外的 hooks）需要验证 DASHBOARD_TOKEN。
 * 5. 清理孤儿会话：每次 /api 请求时顺便清理已被外部删除的会话，除 hooks 外避免影响 hook 性能。
 */
function createApp() {
  const app = express();

  app.use(cors(corsOptions()));
  app.use(hostGuard);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", tokenGuard);
  app.use("/api", (req, res, next) => {
    if (!req.path.startsWith("/hooks")) cleanupOrphanedSessions();
    next();
  });

  app.use("/api/sessions", sessionsRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/hooks", hooksRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/processes", processesRouter);

  app.get("/api/events/stream", (req, res) => {
    initSSE(req, res);
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}

/**
 * 启动 HTTP 服务器，并在生产模式下提供前端静态资源。
 *
 * 缓存策略：
 * - assets/ 下的构建产物带哈希文件名，可长期缓存（1 年）。
 * - index.html 永不缓存，保证新版本发布后客户端能拿到最新入口。
 * - 其他静态资源缓存 5 分钟。
 *
 * 安全提示：如果绑定到非回环地址，会在控制台提示设置 DASHBOARD_TOKEN。
 */
function startServer(app, port) {
  const server = http.createServer(app);

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    const clientDist = path.join(__dirname, "..", "client", "dist");

    app.use(
      express.static(clientDist, {
        etag: true,
        lastModified: true,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            return;
          }
          const fileName = path.basename(filePath);
          if (fileName === "index.html") {
            res.setHeader("Cache-Control", "no-cache, must-revalidate");
            return;
          }
          // 其余静态资源给一个较短缓存，兼顾性能与更新及时性。
          res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
        },
      })
    );
    // 前端路由由 React Router 处理，所有未命中静态文件的路径都返回 index.html。
    app.get("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  const host = resolveHost();
  const boundLoopback = isLoopbackHostname(host);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // 把当前监听端口写入磁盘，便于 hook-handler.js 和安装脚本发现多个 dashboard 实例。
      writeServerInfo(port);
      const shown = boundLoopback ? "localhost" : host;
      if (isProduction) {
        console.log(`Claude Code Monitor server running on http://${shown}:${port} (production)`);
      }
      if (!boundLoopback) {
        console.warn(
          `⚠️  Monitor bound to ${host} — reachable from the network. ` +
            (getDashboardToken()
              ? "DASHBOARD_TOKEN is set (API requires it)."
              : "Set DASHBOARD_TOKEN to require auth, or it is OPEN to anyone who can reach this port.")
        );
      }
      resolve(server);
    });
  });
}

/**
 * 首次启动时从 ~/.claude/ 导入历史会话。使用标记文件避免每次启动重复导入。
 * 导入完成后写入 .legacy-import.done 文件。
 */
function autoImportLegacySessions() {
  try {
    const fs = require("fs");
    const dbModule = require("./db");
    const markerPath = path.join(path.dirname(dbModule.DB_PATH), ".legacy-import.done");
    if (fs.existsSync(markerPath)) return;

    const { importAllSessions } = require("../scripts/import-history");
    importAllSessions(dbModule)
      .then(({ imported, errors }) => {
        if (imported > 0) console.log(`Imported ${imported} legacy sessions from ~/.claude/`);
        if (errors > 0) console.log(`${errors} session files had errors during import`);
      })
      .then(() => {
        try {
          fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
        } catch {
          // 标记文件写入失败不影响业务。
        }
      })
      .catch(() => {});
  } catch (err) {
    console.warn("legacy session auto-import failed:", err.message);
  }
}

/**
 * 启动后台服务：
 * 1. 导入历史会话（仅首次）。
 * 2. 启动时及导入后执行活性收割，清理已死亡会话。
 * 3. 回填子 agent 的 token 元数据（补偿旧数据）。
 * 4. 启动会话同步服务（文件监听 + 轮询）。
 */
function startBackgroundServices() {
  const { broadcast } = require("./sse");

  autoImportLegacySessions();

  // 启动时立即做一次活性收割，5 秒后再做一次（覆盖历史导入可能复活/新增的会话）。
  {
    const bootReap = (label) => {
      try {
        require("./routes/hooks").livenessReap();
      } catch (err) {
        console.warn(`${label} liveness reap failed:`, err?.message || err);
      }
    };
    setImmediate(() => bootReap("boot"));
    const postImportTimer = setTimeout(() => bootReap("post-import"), 5_000);
    if (postImportTimer.unref) postImportTimer.unref();
  }

  // 启动文件系统监听 + 轮询，保持数据库与 ~/.claude/projects 下的 JSONL 同步。
  try {
    startSessionSync(broadcast);
  } catch (err) {
    console.warn("session sync failed to start:", err.message);
  }
}

/**
 * 启动会话同步服务。
 *
 * 策略：
 * - 同时启用文件系统监听（及时）和轮询（兜底）。
 * - 使用 running/queued 互斥锁避免并发扫描；新事件到达时若正在扫描则排队一次。
 * - mtimeCache 记录已扫描文件的修改时间，增量同步避免全量重新导入。
 * - 扫描完成后清理孤儿会话，并调和 token_usage 表（处理子 agent 导入后的 token 归属）。
 */
function startSessionSync(broadcast) {
  const fs = require("fs");
  const dbModule = require("./db");
  const { getProjectsDir } = require("./lib/claude-home");
  const { syncDefaultProjects, reconcileTokens } = require("../scripts/import-history");

  const projectsDir = getProjectsDir();
  const mtimeCache = new Map();
  let running = false;
  let queued = false;

  function runSweep() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    syncDefaultProjects(dbModule, { mtimeCache })
      .then(({ changed }) => {
        // 清理 JSONL 已不存在的会话。
        dbModule.cleanupOrphanedSessions();

        // 把新增/更新的会话和 main agent 广播到前端。
        for (const { sessionId, isNew } of changed) {
          let row;
          try {
            row = dbModule.stmts.getSession.get(sessionId);
          } catch {
            continue;
          }
          if (!row) continue;
          broadcast(isNew ? "session_created" : "session_updated", row);

          try {
            const mainAgent = dbModule.db
              .prepare("SELECT * FROM agents WHERE session_id = ? AND type = 'main' LIMIT 1")
              .get(sessionId);
            if (mainAgent) broadcast(isNew ? "agent_created" : "agent_updated", mainAgent);
          } catch {
            // 单个会话广播失败不影响后续。
          }
        }
      })
      .then(() => reconcileTokens(dbModule))
      .catch(() => {})
      .finally(() => {
        running = false;
        if (queued) {
          queued = false;
          runSweep();
        }
      });
  }

  // 启动后稍延迟执行首次扫描，让服务先完成初始化。
  const initialSweep = setTimeout(runSweep, 250);
  if (initialSweep.unref) initialSweep.unref();

  // 定时轮询兜底（默认 30 秒），文件监听不可靠时仍能保证数据同步。
  const POLL_MS = process.env.DASHBOARD_SESSION_SYNC_MS
    ? Number(process.env.DASHBOARD_SESSION_SYNC_MS)
    : 30_000;
  if (Number.isFinite(POLL_MS) && POLL_MS > 0) {
    const timer = setInterval(runSweep, POLL_MS);
    if (timer.unref) timer.unref();
  }

  // 文件系统事件去抖：800ms 内多次事件只触发一次扫描，避免大量事件压垮服务。
  const DEBOUNCE_MS = 800;
  let debounce = null;
  function scheduleSweep() {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      runSweep();
    }, DEBOUNCE_MS);
    if (debounce.unref) debounce.unref();
  }

  // 如果 mtimeCache 里已经有该文件，说明它已经被扫描过，可以跳过立即调度
  //（实际仍会被轮询覆盖）。未知文件则触发去抖扫描。
  function onFsEvent(fullPath) {
    if (fullPath && mtimeCache.has(fullPath)) return;
    scheduleSweep();
  }

  // 平台差异：macOS/Windows 的 fs.watch 支持 recursive，Linux 需要手动递归监听子目录。
  const recursiveOk = process.platform === "darwin" || process.platform === "win32";
  try {
    if (fs.existsSync(projectsDir)) {
      if (recursiveOk) {
        const watcher = fs.watch(projectsDir, { recursive: true }, (_e, filename) => {
          onFsEvent(filename ? path.join(projectsDir, filename) : null);
        });
        watcher.on("error", () => {});
        if (watcher.unref) watcher.unref();
      } else {
        // Linux：递归监听需要为每个子目录单独创建 watcher。
        const watchChild = (dir) => {
          try {
            const watcher = fs.watch(dir, (_e, filename) => onFsEvent(filename ? path.join(dir, filename) : null));
            watcher.on("error", () => {});
            if (watcher.unref) watcher.unref();
          } catch {
            // 单个目录监听失败不影响整体。
          }
        };
        const watcher = fs.watch(projectsDir, (_e, filename) => {
          if (filename) {
            const child = path.join(projectsDir, filename);
            try {
              if (fs.statSync(child).isDirectory()) watchChild(child);
            } catch {
              // 目录可能已被删除，忽略。
            }
          }
          onFsEvent(filename ? path.join(projectsDir, filename) : null);
        });
        watcher.on("error", () => {});
        if (watcher.unref) watcher.unref();
        for (const ent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
          if (ent.isDirectory()) watchChild(path.join(projectsDir, ent.name));
        }
      }
    }
  } catch {
    // 文件监听失败不影响轮询兜底。
  }
}

/**
 * 探测本机是否已有 dashboard 实例在运行。用于避免重复启动多个监听同一端口的服务。
 */
function probeDashboardHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(responseBody)?.status === "ok");
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

if (require.main === module) {
  const PORT = parseInt(process.env.DASHBOARD_PORT || "4820", 10);
  let httpServer = null;

  // 启动前探测是否已有实例运行。--watch 模式（如 nodemon）下跳过，避免开发时误退出。
  const isWatchMode = process.execArgv.some((a) => a.startsWith("--watch"));
  probeDashboardHealth(PORT).then((alreadyRunning) => {
    if (alreadyRunning && !isWatchMode) {
      console.log(
        `Claude Code Monitor is already running on http://localhost:${PORT} — not starting a ` +
          `second instance. Open that URL, or stop the other monitor first.`
      );
      process.exit(0);
      return;
    }
    const app = createApp();
    startServer(app, PORT).then((server) => {
      httpServer = server;
      startBackgroundServices();
    });
  });

  // 优雅关闭：先关闭 SSE 连接，再关闭 HTTP 服务器，最后关闭数据库。
  let shutdownInProgress = false;
  const shutdown = (signal) => {
    if (shutdownInProgress) {
      console.log(`\n${signal} received again — forcing immediate exit.`);
      process.exit(1);
    }
    shutdownInProgress = true;
    console.log(`\n${signal} received — shutting down gracefully… (hit Ctrl+C again to force)`);

    // 先通知所有 SSE 客户端关闭连接，避免客户端长时间挂起。
    try {
      require("./sse").closeSSEClients();
    } catch {
      // SSE 关闭失败不影响后续。
    }

    const closeDb = () => {
      try {
        require("./db").db.close();
      } catch {
        // 数据库可能已关闭。
      }
    };

    if (httpServer) {
      // 停止接收新连接，等待现有连接处理完毕后关闭数据库并退出。
      httpServer.close(() => {
        console.log("HTTP server closed.");
        closeDb();
        process.exit(0);
      });

      // Node 18+ 提供 closeIdleConnections/closeAllConnections，可加速关闭长连接。
      if (typeof httpServer.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
      } else if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
    } else {
      closeDb();
      process.exit(0);
    }

    // 从磁盘移除当前实例的端口信息，避免其他进程误以为它仍在运行。
    removeServerInfo();

    // 5 秒兜底：即使 HTTP 服务器未完全关闭，也强制退出。
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // 自动安装/配置 Claude Code hooks，使 dashboard 能接收 Claude Code 的事件。
  // 容器内跳过自动配置，因为 hook 脚本需要指向宿主机路径。
  try {
    const { installHooks, isInsideContainer } = require("../scripts/install-hooks");
    if (installHooks(true)) {
      console.log("Claude Code hooks auto-configured.");
    } else if (isInsideContainer()) {
      console.log(
        "Claude Code hooks NOT auto-configured: running inside a container. " +
          "Run `npm run install-hooks` on the host so hooks point at a host path and " +
          "POST to http://localhost:4820 (this container's published port)."
      );
    }
  } catch {
    // hook 安装失败不影响服务启动。
  }
}

module.exports = { createApp, startServer, startBackgroundServices };
