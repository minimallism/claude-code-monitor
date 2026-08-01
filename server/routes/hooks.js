const { Router } = require("express");
const { v4: uuidv4 } = require("uuid");
const dbModule = require("../db");
const { stmts, db } = dbModule;
const { broadcast } = require("../sse");
const TranscriptCache = require("../lib/transcript-cache");

const liveness = require("../lib/session-liveness");
const { scanAndImportSubagents } = require("../../scripts/import-history");

const router = Router();

const transcriptCache = new TranscriptCache();

const WAITING_INPUT_PATTERN =
  /\bpermission\b|waiting (?:for )?(?:your )?(?:input|response|reply|approval)|needs?\s+your\s+(?:input|approval|response|attention)|approval\s+(?:needed|required)|awaiting\s+(?:your\s+)?(?:input|approval|response)/i;

function isWaitingForUserMessage(notificationMessage) {
  if (!notificationMessage || typeof notificationMessage !== "string") return false;
  return WAITING_INPUT_PATTERN.test(notificationMessage);
}

function clearAwaitingInput(sessionId, mainAgentId, broadcastUpdates) {
  
  
  
  const cleared = stmts.clearSessionAgentsAwaitingInput.run(sessionId);
  const sessCleared = stmts.clearSessionAwaitingInput.run(sessionId);
  if (broadcastUpdates && cleared.changes > 0 && mainAgentId) {
    const refreshedMain = stmts.getAgent.get(mainAgentId);
    if (refreshedMain) broadcast("agent_updated", refreshedMain);
  }
  if (broadcastUpdates && sessCleared.changes > 0) {
    const refreshedSess = stmts.getSession.get(sessionId);
    if (refreshedSess) broadcast("session_updated", refreshedSess);
  }
}

function recoverInterruptedSession(sessionId, fullSession, mainAgentId) {
  const timestamp = new Date().toISOString();
  if (mainAgentId) {
    stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
  }
  stmts.setSessionAwaitingInput.run(timestamp, sessionId);
  if (mainAgentId) stmts.setAgentAwaitingInput.run(timestamp, mainAgentId);

  broadcast("session_updated", stmts.getSession.get(sessionId));
  if (mainAgentId) broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
}

function ensureSession(sessionId, data) {
  let session = stmts.getSession.get(sessionId);
  if (!session) {
    stmts.insertSession.run(
      sessionId,
      data.session_name || `Session ${sessionId.slice(0, 8)}`,
      "active",
      data.cwd || null,
      data.model || null,
      null
    );
    session = stmts.getSession.get(sessionId);
    if (!session) {
      console.error(`[HOOKS] Failed to create session ${sessionId} — insert returned no row`);
      return null;
    }
    broadcast("session_created", session);

    
    const mainAgentId = `${sessionId}-main`;
    const sessionLabel = session.name || `Session ${sessionId.slice(0, 8)}`;
    stmts.insertAgent.run(
      mainAgentId,
      sessionId,
      `Main Agent - ${sessionLabel}`,
      "main",
      null,
      "working",
      null,
      null,
      null
    );
    const mainAgent = stmts.getAgent.get(mainAgentId);
    if (mainAgent) broadcast("agent_created", mainAgent);
  }

  
  
  
  
  
  if (typeof data.transcript_path === "string" && data.transcript_path) {
    stmts.setSessionTranscriptPath.run(data.transcript_path, sessionId);
  }
  return session;
}

function getMainAgent(sessionId) {
  return stmts.getAgent.get(`${sessionId}-main`);
}

function isAutoSessionName(name, sessionId, cwd) {
  if (!name || !name.trim()) return true;
  if (name === `Session ${sessionId.slice(0, 8)}`) return true;
  if (cwd) {
    const base = require("path").basename(cwd);
    if (base && (name === base || name.startsWith(`${base} - `) || name.startsWith(`${base} (`))) {
      return true;
    }
  }
  return false;
}

function firstUserLabel(result) {
  const raw = result && typeof result.firstUserMessage === "string" ? result.firstUserMessage : "";
  const text = raw.trim();
  if (!text) return null;
  return text.length > 60 ? text.slice(0, 57) + "..." : text;
}

function isAutoMainAgentName(name, sessionId, cwd) {
  if (!name || !name.trim()) return true;
  if (name === "Main Agent") return true;
  const prefix = "Main Agent - ";
  if (name.startsWith(prefix)) return isAutoSessionName(name.slice(prefix.length), sessionId, cwd);
  return false;
}

function syncSessionName(session, result) {
  if (!session || !result) return;
  const custom = result.customTitle && result.customTitle.trim();
  const ai = result.aiTitle && result.aiTitle.trim();
  const desired = custom || ai || null;
  if (!desired) return;
  const replaceable =
    isAutoSessionName(session.name, session.id, session.cwd) ||
    session.name === firstUserLabel(result);
  if (!custom && !replaceable) return;
  const updateResult = stmts.updateSessionName.run(desired, session.id, desired);
  if (updateResult.changes > 0) {
    const refreshed = stmts.getSession.get(session.id);
    if (refreshed) broadcast("session_updated", refreshed);
  }
}

function applyFirstUserDescriptor(sessionId, result) {
  const label = firstUserLabel(result);
  if (!label) return;

  const session = stmts.getSession.get(sessionId);
  if (session && isAutoSessionName(session.name, session.id, session.cwd)) {
    const updateResult = stmts.updateSessionName.run(label, session.id, label);
    if (updateResult.changes > 0) {
      const refreshed = stmts.getSession.get(session.id);
      if (refreshed) broadcast("session_updated", refreshed);
    }
  }

  const mainAgent = getMainAgent(sessionId);
  if (!mainAgent) return;
  const desiredName = `Main Agent - ${label}`;
  const fillName =
    isAutoMainAgentName(mainAgent.name, sessionId, session?.cwd) && mainAgent.name !== desiredName;
  const fillTask = !mainAgent.task || !String(mainAgent.task).trim();
  if (!fillName && !fillTask) return;
  
  
  
  stmts.updateAgent.run(
    fillName ? desiredName : null,
    null,
    fillTask ? result.firstUserMessage : null,
    mainAgent.current_tool,
    null,
    null,
    mainAgent.id
  );
  const refreshedAgent = stmts.getAgent.get(mainAgent.id);
  if (refreshedAgent) broadcast("agent_updated", refreshedAgent);
}

const processEvent = db.transaction((hookType, data) => {
  const sessionId = data.session_id;
  if (!sessionId) return null;

  const session = ensureSession(sessionId, data);

  
  
  
  
  
  if (data.remote_custom_title || data.remote_ai_title) {
    syncSessionName(session, {
      customTitle:
        typeof data.remote_custom_title === "string"
          ? data.remote_custom_title.slice(0, 200)
          : null,
      aiTitle: typeof data.remote_ai_title === "string" ? data.remote_ai_title.slice(0, 200) : null,
    });
  }

  let mainAgent = getMainAgent(sessionId);
  const mainAgentId = mainAgent?.id ?? null;

  
  
  
  
  
  
  
  const isUserAction = hookType === "UserPromptSubmit" || hookType === "PreToolUse";
  const isNonTerminalEvent = hookType !== "SessionEnd";
  const isStopLike = hookType === "Stop" || hookType === "SubagentStop";
  const isImportedOrAbandoned = session.status === "completed";
  const isSubagentActivity = data.tool_name === "Agent" || hookType === "PreToolUse";
  const needsReactivation =
    session.status !== "active" &&
    isNonTerminalEvent &&
    (isUserAction ||
      (!isStopLike && session.status !== "error") ||
      (isStopLike && isImportedOrAbandoned) ||
      (isSubagentActivity && isImportedOrAbandoned));
  if (needsReactivation) {
    stmts.reactivateSession.run(sessionId);
    broadcast("session_updated", stmts.getSession.get(sessionId));

    if (mainAgent && mainAgent.status !== "working") {
      stmts.reactivateAgent.run(mainAgentId);
      mainAgent = stmts.getAgent.get(mainAgentId);
      broadcast("agent_updated", mainAgent);
    }
  }

  let eventType = hookType;
  let toolName = data.tool_name || null;
  let toolUseId = data.tool_use_id || null;
  let agentId = mainAgentId;

  
  
  
  
  
  
  

  switch (hookType) {
    case "PreToolUse": {
      
      
      
      clearAwaitingInput(sessionId, mainAgentId, true);

      
      if (toolName === "Agent") {
        const toolInput = data.tool_input || {};
        const subagentId = uuidv4();
        
        const rawSubagentName =
          toolInput.description ||
          toolInput.subagent_type ||
          (toolInput.prompt ? toolInput.prompt.split("\n")[0].slice(0, 60) : null) ||
          "Subagent";
        const subagentName = rawSubagentName.length > 60 ? rawSubagentName.slice(0, 57) + "..." : rawSubagentName;

        
        
        
        
        
        
        
        let parentId = mainAgentId;
        if (mainAgent && mainAgent.status !== "working") {
          const deepestWorkingAgent = stmts.findDeepestWorkingAgent.get(sessionId, sessionId);
          if (deepestWorkingAgent) {
            parentId = deepestWorkingAgent.id;
          }
        }

        stmts.insertAgent.run(
          subagentId,
          sessionId,
          subagentName,
          "subagent",
          toolInput.subagent_type || null,
          "working",
          toolInput.prompt ? toolInput.prompt.slice(0, 500) : null,
          parentId,
          toolInput.metadata ? JSON.stringify(toolInput.metadata) : null
        );
        broadcast("agent_created", stmts.getAgent.get(subagentId));
      }

      
      
      
      
      
      
      
      const deepestWorkingAgent =
        mainAgent && mainAgent.status === "waiting"
          ? stmts.findDeepestWorkingAgent.get(sessionId, sessionId)
          : null;
      const subagentIsActor = !!deepestWorkingAgent;
      if (subagentIsActor && toolName !== "Agent") {
        agentId = deepestWorkingAgent.id;
      }
      if (
        mainAgent &&
        !subagentIsActor &&
        (mainAgent.status === "working" || mainAgent.status === "waiting")
      ) {
        stmts.updateAgent.run(null, "working", null, toolName, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "PostToolUse": {
      
      
      
      
      
      clearAwaitingInput(sessionId, mainAgentId, true);

      
      
      

      
      if (mainAgent && mainAgent.status === "waiting" && toolName !== "Agent") {
        const deepestWorkingAgent = stmts.findDeepestWorkingAgent.get(sessionId, sessionId);
        if (deepestWorkingAgent) {
          agentId = deepestWorkingAgent.id;
        }
      }

      
      
      if (mainAgent && mainAgent.status === "working") {
        stmts.updateAgent.run(null, null, null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "PostToolUseFailure": {
      
      clearAwaitingInput(sessionId, mainAgentId, true);

      
      if (mainAgent && mainAgent.status === "waiting" && toolName !== "Agent") {
        const deepestWorkingAgent = stmts.findDeepestWorkingAgent.get(sessionId, sessionId);
        if (deepestWorkingAgent) {
          agentId = deepestWorkingAgent.id;
        }
      }

      
      if (mainAgent && mainAgent.status === "working") {
        stmts.updateAgent.run(null, null, null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "Stop": {

      const now = new Date().toISOString();
      const agentMutable =
        !!mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error";

      
      
      
      
      
      
      if (agentMutable) {
        stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
      }
      stmts.setSessionAwaitingInput.run(now, sessionId);
      if (mainAgentId) stmts.setAgentAwaitingInput.run(now, mainAgentId);

      
      broadcast("session_updated", stmts.getSession.get(sessionId));
      if (mainAgentId) {
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "SubagentStop": {
      const subagents = stmts.listAgentsBySession.all(sessionId);
      let matchingSubagent = null;

      
      
      
      const subagentDescription = data.description || data.agent_type || data.subagent_type || null;
      if (subagentDescription) {
        const namePrefix = subagentDescription.length > 57 ? subagentDescription.slice(0, 57) : subagentDescription;
        matchingSubagent = subagents.find(
          (a) => a.type === "subagent" && a.status === "working" && a.name.startsWith(namePrefix)
        );
      }

      
      if (!matchingSubagent && data.agent_type) {
        matchingSubagent = subagents.find(
          (a) =>
            a.type === "subagent" && a.status === "working" && a.subagent_type === data.agent_type
        );
      }

      if (!matchingSubagent) {
        const prompt = data.prompt ? data.prompt.slice(0, 500) : null;
        if (prompt) {
          matchingSubagent = subagents.find(
            (a) => a.type === "subagent" && a.status === "working" && a.task === prompt
          );
        }
      }

      
      if (!matchingSubagent) {
        matchingSubagent = subagents.find((a) => a.type === "subagent" && a.status === "working");
      }

      if (matchingSubagent) {
        stmts.updateAgent.run(
          null,
          "completed",
          null,
          null,
          new Date().toISOString(),
          null,
          matchingSubagent.id
        );
        broadcast("agent_updated", stmts.getAgent.get(matchingSubagent.id));
        agentId = matchingSubagent.id;
      }
      break;
    }

    case "SessionStart": {

      if (mainAgent && mainAgent.status === "waiting") {
        stmts.updateAgent.run(null, "working", null, null, null, null, mainAgentId);
      }

      
      
      
      
      
      
      const sessionStartTs = new Date().toISOString();
      stmts.setSessionAwaitingInput.run(sessionStartTs, sessionId);
      if (mainAgentId) stmts.setAgentAwaitingInput.run(sessionStartTs, mainAgentId);

      
      
      
      broadcast("session_updated", stmts.getSession.get(sessionId));
      if (mainAgentId) broadcast("agent_updated", stmts.getAgent.get(mainAgentId));

      break;
    }

    case "SessionEnd": {
      const endingSession = stmts.getSession.get(sessionId);

      clearAwaitingInput(sessionId, mainAgentId, false);

      
      
      
      
      
      const finalSessionStatus =
        endingSession?.status === "error" ? "error" : "completed";
      const sessionAgents = stmts.listAgentsBySession.all(sessionId);
      const now = new Date().toISOString();
      for (const agent of sessionAgents) {
        if (agent.status !== "completed" && agent.status !== "error") {
          const finalAgentStatus = finalSessionStatus === "error" ? "error" : "completed";
          stmts.updateAgent.run(null, finalAgentStatus, null, null, now, null, agent.id);
          broadcast("agent_updated", stmts.getAgent.get(agent.id));
        }
      }
      stmts.updateSession.run(null, finalSessionStatus, now, null, sessionId);
      broadcast("session_updated", stmts.getSession.get(sessionId));

      break;
    }

    case "UserPromptSubmit": {

      clearAwaitingInput(sessionId, mainAgentId, true);
      if (mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error") {
        stmts.updateAgent.run(null, "working", null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "Notification": {
      const notificationMessage = data.message || "Notification received";
      if (isWaitingForUserMessage(notificationMessage)) {

        const timestamp = new Date().toISOString();
        stmts.setSessionAwaitingInput.run(timestamp, sessionId);
        broadcast("session_updated", stmts.getSession.get(sessionId));
        if (mainAgentId) {
          stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
          stmts.setAgentAwaitingInput.run(timestamp, mainAgentId);
          broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
        }
      }
      break;
    }

    default: {
    }
  }

  
  
  
  
  
  
  
  
  
  if (data.transcript_path) {
    const result = transcriptCache.extract(data.transcript_path);
    if (result) {
      const { tokensByModel, latestModel } = result;

      
      
      
      
      
      if (latestModel) {
        const updateResult = stmts.updateSessionModel.run(latestModel, sessionId, latestModel);
        if (updateResult.changes > 0) {
          const refreshed = stmts.getSession.get(sessionId);
          if (refreshed) broadcast("session_updated", refreshed);
        }
      }

      
      
      
      syncSessionName(stmts.getSession.get(sessionId), result);

      
      
      
      
      applyFirstUserDescriptor(sessionId, result);

      
      
      


      if (tokensByModel) {
        
        
        for (const tokens of Object.values(tokensByModel)) {
          stmts.replaceTokenUsage.run(
            sessionId,
            tokens.model,
            tokens.input,
            tokens.output,
            tokens.cacheRead,
            tokens.cacheWrite
          );
        }
      }

      
      if (result.usageExtras || result.thinkingBlockCount > 0) {
        const session = stmts.getSession.get(sessionId);
        if (session) {
          const meta = session.metadata ? JSON.parse(session.metadata) : {};
          if (result.usageExtras) {
            meta.usage_extras = result.usageExtras;
          }
          if (result.thinkingBlockCount > 0) {
            meta.thinking_blocks = (meta.thinking_blocks || 0) + result.thinkingBlockCount;
          }
          if (result.turnDurations) {
            meta.turn_count = (meta.turn_count || 0) + result.turnDurations.length;
            const totalMs = result.turnDurations.reduce((s, t) => s + t.durationMs, 0);
            meta.total_turn_duration_ms = (meta.total_turn_duration_ms || 0) + totalMs;
          }
          stmts.updateSession.run(null, null, null, JSON.stringify(meta), sessionId);
        }
      }
    }
  }

  
  
  if (hookType === "SessionEnd" && data.transcript_path) {
    transcriptCache.invalidate(data.transcript_path);
  }

  
  stmts.touchSession.run(sessionId);

  stmts.insertEvent.run(
    sessionId,
    agentId,
    eventType,
    toolName,
    toolUseId
  );

  const event = {
    session_id: sessionId,
    agent_id: agentId,
    event_type: eventType,
    tool_name: toolName,
    tool_use_id: toolUseId,
    created_at: new Date().toISOString(),
  };
  broadcast("new_event", event);
  return event;
});

router.post("/event", (req, res) => {
  const { hook_type, data } = req.body;
  if (!hook_type || !data) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "hook_type and data are required" },
    });
  }

  const result = processEvent(hook_type, data);
  if (!result) {
    return res.status(400).json({
      error: { code: "MISSING_SESSION", message: "session_id is required in data" },
    });
  }

  res.json({ ok: true, event: result });

  
  
  
  
  if (hook_type === "SubagentStop" && data.session_id && data.transcript_path) {
    
    
    
    
    
    
    
    let parentTokenModelNames = [];
    try {
      const mainResult = transcriptCache.extract(data.transcript_path);
      if (mainResult && mainResult.tokensByModel) {
        parentTokenModelNames = Object.values(mainResult.tokensByModel)
          .map((tokenBucket) => tokenBucket.model)
          .filter(Boolean);
      }
      if (mainResult && mainResult.latestModel) parentTokenModelNames.push(mainResult.latestModel);
    } catch {
      
    }
    scanAndImportSubagents(dbModule, data.session_id, data.transcript_path, {
      parentModels: parentTokenModelNames,
    })
      ;
  }
});

const WATCHDOG_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 10_000; 

const WORKING_IDLE_MS = (() => {
  const raw = parseInt(process.env.DASHBOARD_WORKING_IDLE_SECONDS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 120_000; 
})();

function watchdogCheck() {
  try {
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    
    const staleSessions = db
      .prepare(
        `SELECT s.id, s.status, s.cwd, s.transcript_path,
                (SELECT MAX(e.created_at) FROM events e WHERE e.session_id = s.id) as last_event
         FROM sessions s
         WHERE s.status IN ('active', 'error') AND s.updated_at < ?`
      )
      .all(cutoff);

    for (const staleSession of staleSessions) {
      
      let transcriptPath = staleSession.transcript_path || null;
      
      
      if (!transcriptPath && staleSession.cwd) {
        const slug = staleSession.cwd.replace(/[\/\.]/g, "-");
        const candidate = path.join(os.homedir(), ".claude", "projects", slug, `${staleSession.id}.jsonl`);
        if (fs.existsSync(candidate)) transcriptPath = candidate;
      }
      if (!transcriptPath) continue;

      
      
      const result = transcriptCache.extract(transcriptPath);
      if (!result) continue;

      
      
      
      if (result.tokensByModel) {
        for (const tokens of Object.values(result.tokensByModel)) {
          stmts.replaceTokenUsage.run(
            staleSession.id,
            tokens.model,
            tokens.input || 0,
            tokens.output || 0,
            tokens.cacheRead || 0,
            tokens.cacheWrite || 0
          );
        }
      }

      const fullSession = stmts.getSession.get(staleSession.id);
      if (fullSession) {
        syncSessionName(fullSession, result);
        applyFirstUserDescriptor(staleSession.id, result);
      }

      const mainAgent = db
        .prepare("SELECT * FROM agents WHERE session_id = ? AND type = 'main' LIMIT 1")
        .get(staleSession.id);
      const mainAgentId = mainAgent?.id ?? null;

      
      
      
      
      
      
      


      
      
      
      
      
      
      
      
      
      
      
      
      
      if (
        result.pendingInterrupt &&
        mainAgent &&
        mainAgent.status === "working" &&
        !mainAgent.awaiting_input_since
      ) {
        recoverInterruptedSession(staleSession.id, fullSession, mainAgentId)
        
        
        continue;
      }

      
        
        
        
        
        
        
        
      
      
      
      
      if (
        mainAgent &&
        mainAgent.status === "working" &&
        !mainAgent.current_tool &&
        !mainAgent.awaiting_input_since
      ) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(transcriptPath).mtimeMs;
        } catch {
          
        }
        const hookMs = Date.parse(staleSession.last_event) || 0;
        const idleMs = Date.now() - Math.max(mtimeMs, hookMs);
        if (idleMs > WORKING_IDLE_MS) {
          recoverInterruptedSession(staleSession.id, fullSession, mainAgentId)
        }
      }
      continue;
    }

    livenessReap();
  } catch (err) {
    
    console.warn("[WATCHDOG] Error during check:", err?.message || err);
  }
}

function livenessReap() {
  const path = require("path");

  const activeSessions = db
    .prepare(
      `SELECT id, name, cwd, transcript_path, updated_at FROM sessions
       WHERE status = 'active' AND cwd IS NOT NULL AND cwd <> ''`
    )
    .all();
  if (activeSessions.length === 0) return; 

  const probe = liveness.probeLiveCwds();
  if (!probe.available) return;
  for (const staleSession of activeSessions) {
    let resolvedCwd;
    try {
      resolvedCwd = path.resolve(staleSession.cwd);
    } catch {
      continue;
    }
    if (probe.cwds.has(resolvedCwd)) continue;

    
    const timestamp = new Date().toISOString();
    clearAwaitingInput(staleSession.id, null, false);
    const agents = stmts.listAgentsBySession.all(staleSession.id);
    for (const agent of agents) {
      if (agent.status !== "completed" && agent.status !== "error") {
        stmts.updateAgent.run(null, "error", null, null, timestamp, null, agent.id);
      }
    }
    stmts.updateSession.run(null, "error", timestamp, null, staleSession.id);

    const label = staleSession.name || `Session ${staleSession.id.slice(0, 8)}`;
    const mainAgentId = `${staleSession.id}-main`;
    stmts.insertEvent.run(
      staleSession.id,
      stmts.getAgent.get(mainAgentId) ? mainAgentId : null,
      "SessionEnd",
      null,
      null
    );

    broadcast("session_updated", stmts.getSession.get(staleSession.id));
    for (const agent of agents) {
      if (agent.status !== "completed" && agent.status !== "error") {
        broadcast("agent_updated", stmts.getAgent.get(agent.id));
      }
    }
    broadcast("new_event", {
      session_id: staleSession.id,
      agent_id: stmts.getAgent.get(mainAgentId) ? mainAgentId : null,
      event_type: "SessionEnd",
      tool_name: null,
      created_at: timestamp,
    });
    console.log(`[WATCHDOG] Liveness reap: completed dead session ${staleSession.id} (${label})`);
  }
}

const watchdogTimer = setInterval(watchdogCheck, WATCHDOG_INTERVAL_MS);

if (watchdogTimer.unref) watchdogTimer.unref();

router.livenessReap = livenessReap;
module.exports = router;
