if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

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
          
          
          
          res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
        },
      })
    );
    app.get("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  
  
  
  const host = resolveHost();
  const boundLoopback = isLoopbackHostname(host);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      
      
      
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
          
        }
      })
      .catch(() => {});
  } catch (err) {
    console.warn("legacy session auto-import failed:", err.message);
  }
}

function startBackgroundServices() {
  const { broadcast } = require("./sse");

  
  autoImportLegacySessions();

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
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

  
  
  
  
  {
    const dbModule = require("./db");
    const { backfillSubagentTokenMetadata } = require("../scripts/import-history");
    const backfillTimer = setTimeout(() => {
      Promise.resolve()
        .then(() => backfillSubagentTokenMetadata(dbModule))
        .then((backfillResult) => {
          if (backfillResult && backfillResult.stamped > 0)
            console.log(
              `Backfilled per-agent token cost for ${backfillResult.stamped} subagent(s) across ${backfillResult.sessions} session(s)`
            );
        })
        .catch((error) => console.warn("subagent token backfill failed:", error?.message || error));
    }, 500);
    if (backfillTimer.unref) backfillTimer.unref();
  }

  
  
  
  
  try {
    startSessionSync(broadcast);
  } catch (err) {
    console.warn("session sync failed to start:", err.message);
  }
}

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
        // Clean up sessions whose JSONL files no longer exist
        dbModule.cleanupOrphanedSessions();
        
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

  
  
  
  
  
  
  
  
  
  const initialSweep = setTimeout(runSweep, 250);
  if (initialSweep.unref) initialSweep.unref();

  
  const POLL_MS = process.env.DASHBOARD_SESSION_SYNC_MS
    ? Number(process.env.DASHBOARD_SESSION_SYNC_MS)
    : 30_000;
  if (Number.isFinite(POLL_MS) && POLL_MS > 0) {
    const timer = setInterval(runSweep, POLL_MS);
    if (timer.unref) timer.unref();
  }

  
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
  
  
  
  function onFsEvent(fullPath) {
    if (fullPath && mtimeCache.has(fullPath)) return;
    scheduleSweep();
  }

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
        
        
        const watchChild = (dir) => {
          try {
            const watcher = fs.watch(dir, (_e, filename) => onFsEvent(filename ? path.join(dir, filename) : null));
            watcher.on("error", () => {});
            if (watcher.unref) watcher.unref();
          } catch {
            
          }
        };
        const watcher = fs.watch(projectsDir, (_e, filename) => {
          if (filename) {
            const child = path.join(projectsDir, filename);
            try {
              if (fs.statSync(child).isDirectory()) watchChild(child);
            } catch {
              
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
    
  }
}

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

  
  let shutdownInProgress = false;
  const shutdown = (signal) => {
    if (shutdownInProgress) {
      console.log(`\n${signal} received again — forcing immediate exit.`);
      process.exit(1);
    }
    shutdownInProgress = true;
    console.log(`\n${signal} received — shutting down gracefully… (hit Ctrl+C again to force)`);

    
    
    try {
      require("./sse").closeSSEClients();
    } catch {
      
    }

    const closeDb = () => {
      try {
        require("./db").db.close();
      } catch {
        
      }
    };

    if (httpServer) {
      
      
      
      httpServer.close(() => {
        console.log("HTTP server closed.");
        closeDb();
        process.exit(0);
      });
      
      
      
      
      
      
      
      
      if (typeof httpServer.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
      } else if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
    } else {
      closeDb();
      process.exit(0);
    }

    
    
    
    removeServerInfo();
    
    
    
    
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  
  
  
  
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
    
  }

  

  
  
  
}

module.exports = { createApp, startServer, startBackgroundServices };
