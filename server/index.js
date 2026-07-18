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
const { initWebSocket } = require("./websocket");
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
const eventsRouter = require("./routes/events");
const statsRouter = require("./routes/stats");
const hooksRouter = require("./routes/hooks");
const analyticsRouter = require("./routes/analytics");
const pricingRouter = require("./routes/pricing");
const settingsRouter = require("./routes/settings");
const workflowsRouter = require("./routes/workflows");

function createApp() {
  const app = express();

  
  
  app.use(cors(corsOptions()));
  app.use(hostGuard);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", tokenGuard);

  app.use("/api/sessions", sessionsRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/hooks", hooksRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/pricing", pricingRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/workflows", workflowsRouter);

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}

function startServer(app, port) {
  const server = http.createServer(app);
  initWebSocket(server);

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
          const base = path.basename(filePath);
          if (base === "index.html") {
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
      const mode = isProduction ? "production" : "development";
      const shown = boundLoopback ? "localhost" : host;
      console.log(`Agent Dashboard server running on http://${shown}:${port} (${mode})`);
      if (!boundLoopback) {
        console.warn(
          `⚠️  Dashboard bound to ${host} — reachable from the network. ` +
            (getDashboardToken()
              ? "DASHBOARD_TOKEN is set (API + WebSocket require it)."
              : "Set DASHBOARD_TOKEN to require auth, or it is OPEN to anyone who can reach this port.")
        );
      }
      if (!isProduction) {
        console.log(`Client dev server expected at http://localhost:5173`);
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

    const { importAllSessions, backfillCompactions } = require("../scripts/import-history");
    importAllSessions(dbModule)
      .then(({ imported, errors }) => {
        if (imported > 0) console.log(`Imported ${imported} legacy sessions from ~/.claude/`);
        if (errors > 0) console.log(`${errors} session files had errors during import`);
      })
      .then(() => backfillCompactions(dbModule))
      .then(({ backfilled }) => {
        if (backfilled > 0)
          console.log(`Backfilled ${backfilled} compaction events from ~/.claude/`);
      })
      
      
      
      .then(() => require("./lib/workflow-ingest").ingestAllWorkflows(dbModule))
      .then(({ workflows }) => {
        if (workflows > 0) console.log(`Backfilled ${workflows} workflow run(s) from ~/.claude/`);
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
  const { broadcast } = require("./websocket");

  
  autoImportLegacySessions();

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  {
    const bootReap = (label) => {
      try {
        require("./routes/hooks").livenessReap({ ignoreIdleGate: true });
      } catch (err) {
        console.warn(`${label} liveness reap failed:`, err?.message || err);
      }
    };
    setImmediate(() => bootReap("boot"));
    const t = setTimeout(() => bootReap("post-import"), 5_000);
    if (t.unref) t.unref();
  }

  
  
  
  
  {
    const dbModule = require("./db");
    const { backfillSubagentTokenMetadata } = require("../scripts/import-history");
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => backfillSubagentTokenMetadata(dbModule))
        .then((r) => {
          if (r && r.stamped > 0)
            console.log(
              `Backfilled per-agent token cost for ${r.stamped} subagent(s) across ${r.sessions} session(s)`
            );
        })
        .catch((err) => console.warn("subagent token backfill failed:", err?.message || err));
    }, 500);
    if (t.unref) t.unref();
  }

  
  
  
  
  try {
    startWorkflowPoll(broadcast);
  } catch (err) {
    console.warn("workflow poll failed to start:", err.message);
  }
  
  
  
  
  
  try {
    startSessionSync(broadcast);
  } catch (err) {
    console.warn("session sync failed to start:", err.message);
  }
}

function startWorkflowPoll(broadcast) {
  const POLL_MS = process.env.DASHBOARD_WORKFLOW_POLL_MS
    ? Number(process.env.DASHBOARD_WORKFLOW_POLL_MS)
    : 12_000;
  if (!Number.isFinite(POLL_MS) || POLL_MS <= 0) return;

  const dbModule = require("./db");
  const { ingestWorkflowsForSession, workflowsMaxMtime } = require("./lib/workflow-ingest");
  const lastSeen = new Map(); 

  const timer = setInterval(() => {
    let active;
    try {
      active = dbModule.db
        .prepare(
          "SELECT id, transcript_path AS tp FROM sessions WHERE status = 'active' AND transcript_path IS NOT NULL ORDER BY updated_at DESC LIMIT 50"
        )
        .all();
    } catch {
      return;
    }
    for (const row of active) {
      if (!row.tp) continue;
      let mtime = 0;
      try {
        mtime = workflowsMaxMtime(row.tp);
      } catch {
        mtime = 0;
      }
      if (mtime === 0 || lastSeen.get(row.id) === mtime) continue; 
      lastSeen.set(row.id, mtime);
      ingestWorkflowsForSession(dbModule, { id: row.id, transcript_path: row.tp })
        .then((changed) => {
          if (!changed || changed.length === 0) return;
          for (const wf of changed) broadcast("workflow_upserted", wf);
          const sess = dbModule.stmts.getSession.get(row.id); 
          if (sess) broadcast("session_updated", sess);
        })
        .catch(() => {});
    }
  }, POLL_MS);
  if (timer.unref) timer.unref();
}

function startSessionSync(broadcast) {
  const fs = require("fs");
  const dbModule = require("./db");
  const { getProjectsDir } = require("./lib/claude-home");
  const { syncDefaultProjects } = require("../scripts/import-history");

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

  const watchers = [];
  function addWatcher(w) {
    w.on("error", () => {});
    if (w.unref) w.unref();
    watchers.push(w);
  }
  const recursiveOk = process.platform === "darwin" || process.platform === "win32";
  try {
    if (fs.existsSync(projectsDir)) {
      if (recursiveOk) {
        addWatcher(
          fs.watch(projectsDir, { recursive: true }, (_e, filename) => {
            onFsEvent(filename ? path.join(projectsDir, filename) : null);
          })
        );
      } else {
        
        
        const watchChild = (dir) => {
          try {
            addWatcher(
              fs.watch(dir, (_e, filename) => onFsEvent(filename ? path.join(dir, filename) : null))
            );
          } catch {
            
          }
        };
        addWatcher(
          fs.watch(projectsDir, (_e, filename) => {
            if (filename) {
              const child = path.join(projectsDir, filename);
              try {
                if (fs.statSync(child).isDirectory()) watchChild(child);
              } catch {
                
              }
            }
            onFsEvent(filename ? path.join(projectsDir, filename) : null);
          })
        );
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
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf)?.status === "ok");
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
        `Agent Dashboard is already running on http://localhost:${PORT} — not starting a ` +
          `second instance. Open that URL, or stop the other dashboard first.`
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
      require("./websocket").closeWebSocket();
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

  
  
  
  
  
  
  
  
  
  
  
  
  
  const STALE_MINUTES = (() => {
    const raw = parseInt(process.env.DASHBOARD_STALE_MINUTES, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 180;
  })();
  
  
  
  const SWEEP_INTERVAL_MS = Math.max(60_000, Math.min(300_000, (STALE_MINUTES * 60_000) / 4));

  const cleanupDb = require("./db");
  const { broadcast } = require("./websocket");
  const { importCompactions } = require("../scripts/import-history");
  const { transcriptCache } = require("./routes/hooks");
  
  
  
  
  const sweepWorkflowSeen = new Map();
  setInterval(() => {
    
    const stale = cleanupDb.stmts.findStaleSessions.all("__periodic__", STALE_MINUTES);
    const now = new Date().toISOString();
    if (stale.length > 0) {
      const staleIds = stale.map((s) => s.id);
      const placeholders = staleIds.map(() => "?").join(",");

      
      cleanupDb.db
        .prepare(
          `UPDATE agents SET status = 'completed', ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE session_id IN (${placeholders}) AND status NOT IN ('completed', 'error')`
        )
        .run(now, now, ...staleIds);

      for (const s of stale) {
        cleanupDb.stmts.updateSession.run(null, "abandoned", now, null, s.id);
        broadcast("session_updated", cleanupDb.stmts.getSession.get(s.id));

        
        
        
        const tpRow = cleanupDb.db
          .prepare("SELECT transcript_path AS tp FROM sessions WHERE id = ?")
          .get(s.id);
        if (tpRow?.tp) transcriptCache.invalidate(tpRow.tp);
      }

      
      for (const s of stale) {
        const agents = cleanupDb.stmts.listAgentsBySession.all(s.id);
        for (const agent of agents) {
          if (agent.status === "completed") {
            broadcast("agent_updated", agent);
          }
        }
      }
    }

    
    
    
    
    const active = cleanupDb.db
      .prepare(
        "SELECT id AS session_id, transcript_path AS tp FROM sessions WHERE status = 'active' AND transcript_path IS NOT NULL ORDER BY updated_at DESC"
      )
      .all();
    for (const row of active) {
      if (!row.tp) continue;
      try {
        const compactions = transcriptCache.extractCompactions(row.tp);
        if (compactions.length === 0) continue;
        const mainAgentId = `${row.session_id}-main`;
        const created = importCompactions(cleanupDb, row.session_id, mainAgentId, compactions);
        if (created > 0) {
          broadcast(
            "agent_created",
            cleanupDb.stmts.getAgent.get(
              `${row.session_id}-compact-${compactions[compactions.length - 1].uuid}`
            )
          );
        }
      } catch (err) {
        console.warn(
          `[SWEEP] Compaction scan failed for session ${row.session_id}:`,
          err?.message || err
        );
        continue;
      }
    }

    
    
    
    const { ingestWorkflowsForSession, workflowsMaxMtime } = require("./lib/workflow-ingest");
    
    
    const activeIds = new Set(active.map((r) => r.session_id));
    for (const id of sweepWorkflowSeen.keys()) {
      if (!activeIds.has(id)) sweepWorkflowSeen.delete(id);
    }
    for (const row of active) {
      if (!row.tp) continue;
      
      
      
      
      
      
      let mtime = 0;
      try {
        mtime = workflowsMaxMtime(row.tp);
      } catch {
        mtime = 0;
      }
      if (mtime === 0 || sweepWorkflowSeen.get(row.session_id) === mtime) continue;
      sweepWorkflowSeen.set(row.session_id, mtime);
      ingestWorkflowsForSession(cleanupDb, { id: row.session_id, transcript_path: row.tp })
        .then((changed) => {
          if (!changed || changed.length === 0) return;
          for (const wf of changed) broadcast("workflow_upserted", wf);
          const sess = cleanupDb.stmts.getSession.get(row.session_id);
          if (sess) broadcast("session_updated", sess);
        })
        .catch((err) => {
          
          
          sweepWorkflowSeen.delete(row.session_id);
          console.warn(
            `[SWEEP] Workflow scan failed for session ${row.session_id}:`,
            err?.message || err
          );
        });
    }
  }, SWEEP_INTERVAL_MS);

  
  
  
}

module.exports = { createApp, startServer, startBackgroundServices };
