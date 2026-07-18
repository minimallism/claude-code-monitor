const { Router } = require("express");
const { v4: uuidv4 } = require("uuid");
const dbModule = require("../db");
const { stmts, db } = dbModule;
const { broadcast } = require("../websocket");
const TranscriptCache = require("../lib/transcript-cache");
const { scanAndImportSubagents } = require("../../scripts/import-history");
const { ingestWorkflowsForSession } = require("../lib/workflow-ingest");

const liveness = require("../lib/session-liveness");

const router = Router();

const transcriptCache = new TranscriptCache();

const STALE_MINUTES = (() => {
  const raw = parseInt(process.env.DASHBOARD_STALE_MINUTES, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 180;
})();

const WAITING_INPUT_PATTERN =
  /\bpermission\b|waiting (?:for )?(?:your )?(?:input|response|reply|approval)|needs?\s+your\s+(?:input|approval|response|attention)|approval\s+(?:needed|required)|awaiting\s+(?:your\s+)?(?:input|approval|response)/i;

function isWaitingForUserMessage(msg) {
  if (!msg || typeof msg !== "string") return false;
  return WAITING_INPUT_PATTERN.test(msg);
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

function recoverInterruptedSession(sessionId, fullSess, mainAgentId, reasonSuffix) {
  const ts = new Date().toISOString();
  if (mainAgentId) {
    stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
  }
  stmts.setSessionAwaitingInput.run(ts, sessionId);
  if (mainAgentId) stmts.setAgentAwaitingInput.run(ts, mainAgentId);

  const label = fullSess?.name || `Session ${sessionId.slice(0, 8)}`;
  const summary = reasonSuffix ? `${label} - ${reasonSuffix}` : `${label} - interrupted by user`;
  stmts.insertEvent.run(sessionId, mainAgentId, "Interrupted", null, summary, null);

  broadcast("session_updated", stmts.getSession.get(sessionId));
  if (mainAgentId) broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
  broadcast("new_event", {
    session_id: sessionId,
    agent_id: mainAgentId,
    event_type: "Interrupted",
    tool_name: null,
    summary,
    created_at: ts,
  });
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
  const upd = stmts.updateSessionName.run(desired, session.id, desired);
  if (upd.changes > 0) {
    const refreshed = stmts.getSession.get(session.id);
    if (refreshed) broadcast("session_updated", refreshed);
  }
}

function applyFirstUserDescriptor(sessionId, result) {
  const label = firstUserLabel(result);
  if (!label) return;

  const session = stmts.getSession.get(sessionId);
  if (session && isAutoSessionName(session.name, session.id, session.cwd)) {
    const upd = stmts.updateSessionName.run(label, session.id, label);
    if (upd.changes > 0) {
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
  const isImportedOrAbandoned = session.status === "completed" || session.status === "abandoned";
  const needsReactivation =
    session.status !== "active" &&
    isNonTerminalEvent &&
    (isUserAction ||
      (!isStopLike && session.status !== "error") ||
      (isStopLike && isImportedOrAbandoned));
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
  let summary = null;
  let agentId = mainAgentId;

  
  
  
  
  
  
  

  switch (hookType) {
    case "PreToolUse": {
      summary = `Using tool: ${toolName}`;

      
      
      
      clearAwaitingInput(sessionId, mainAgentId, true);

      
      if (toolName === "Agent") {
        const input = data.tool_input || {};
        const subId = uuidv4();
        
        const rawName =
          input.description ||
          input.subagent_type ||
          (input.prompt ? input.prompt.split("\n")[0].slice(0, 60) : null) ||
          "Subagent";
        const subName = rawName.length > 60 ? rawName.slice(0, 57) + "..." : rawName;

        
        
        
        
        
        
        
        let parentId = mainAgentId;
        if (mainAgent && mainAgent.status !== "working") {
          const deepest = stmts.findDeepestWorkingAgent.get(sessionId, sessionId);
          if (deepest) {
            parentId = deepest.id;
          }
        }

        stmts.insertAgent.run(
          subId,
          sessionId,
          subName,
          "subagent",
          input.subagent_type || null,
          "working",
          input.prompt ? input.prompt.slice(0, 500) : null,
          parentId,
          input.metadata ? JSON.stringify(input.metadata) : null
        );
        broadcast("agent_created", stmts.getAgent.get(subId));
        agentId = subId;
        summary = `Subagent spawned: ${subName}`;
      }

      
      
      
      
      
      
      
      const deepestWorking =
        mainAgent && mainAgent.status === "waiting"
          ? stmts.findDeepestWorkingAgent.get(sessionId, sessionId)
          : null;
      const subagentIsActor = !!deepestWorking;
      if (subagentIsActor && toolName !== "Agent") {
        agentId = deepestWorking.id;
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
      summary = `Tool completed: ${toolName}`;

      
      
      
      
      
      clearAwaitingInput(sessionId, mainAgentId, true);

      
      
      

      
      if (mainAgent && mainAgent.status === "waiting" && toolName !== "Agent") {
        const deepest = stmts.findDeepestWorkingAgent.get(sessionId, sessionId);
        if (deepest) {
          agentId = deepest.id;
        }
      }

      
      
      if (mainAgent && mainAgent.status === "working") {
        stmts.updateAgent.run(null, null, null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "Stop": {
      const session = stmts.getSession.get(sessionId);
      const sessionLabel = session?.name || `Session ${sessionId.slice(0, 8)}`;
      summary =
        data.stop_reason === "error"
          ? `Error in ${sessionLabel}`
          : `${sessionLabel} - ready for input`;

      
      
      
      
      
      
      
      
      
      
      const now = new Date().toISOString();
      const agentMutable =
        !!mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error";

      if (data.stop_reason === "error") {
        if (agentMutable) {
          stmts.updateAgent.run(null, "error", null, null, null, null, mainAgentId);
        }
        stmts.updateSession.run(null, "error", now, null, sessionId);
        
        
        clearAwaitingInput(sessionId, mainAgentId, false);
      } else {
        if (agentMutable) {
          stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
        }
        
        
        
        stmts.setSessionAwaitingInput.run(now, sessionId);
        if (mainAgentId) stmts.setAgentAwaitingInput.run(now, mainAgentId);
      }

      
      broadcast("session_updated", stmts.getSession.get(sessionId));
      if (mainAgentId) {
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "SubagentStop": {
      summary = `Subagent completed`;
      const subagents = stmts.listAgentsBySession.all(sessionId);
      let matchingSub = null;

      
      
      
      const subDesc = data.description || data.agent_type || data.subagent_type || null;
      if (subDesc) {
        const namePrefix = subDesc.length > 57 ? subDesc.slice(0, 57) : subDesc;
        matchingSub = subagents.find(
          (a) => a.type === "subagent" && a.status === "working" && a.name.startsWith(namePrefix)
        );
      }

      
      if (!matchingSub && data.agent_type) {
        matchingSub = subagents.find(
          (a) =>
            a.type === "subagent" && a.status === "working" && a.subagent_type === data.agent_type
        );
      }

      if (!matchingSub) {
        const prompt = data.prompt ? data.prompt.slice(0, 500) : null;
        if (prompt) {
          matchingSub = subagents.find(
            (a) => a.type === "subagent" && a.status === "working" && a.task === prompt
          );
        }
      }

      
      if (!matchingSub) {
        matchingSub = subagents.find((a) => a.type === "subagent" && a.status === "working");
      }

      if (matchingSub) {
        stmts.updateAgent.run(
          null,
          "completed",
          null,
          null,
          new Date().toISOString(),
          null,
          matchingSub.id
        );
        broadcast("agent_updated", stmts.getAgent.get(matchingSub.id));
        agentId = matchingSub.id;
        summary = `Subagent completed: ${matchingSub.name}`;

        
        
      }
      break;
    }

    case "SessionStart": {
      summary = data.source === "resume" ? "Session resumed" : "Session started";

      
      
      if (mainAgent && mainAgent.status === "waiting") {
        stmts.updateAgent.run(null, "working", null, null, null, null, mainAgentId);
      }

      
      
      
      
      
      
      const sessionStartTs = new Date().toISOString();
      stmts.setSessionAwaitingInput.run(sessionStartTs, sessionId);
      if (mainAgentId) stmts.setAgentAwaitingInput.run(sessionStartTs, mainAgentId);

      
      
      
      broadcast("session_updated", stmts.getSession.get(sessionId));
      if (mainAgentId) broadcast("agent_updated", stmts.getAgent.get(mainAgentId));

      
      
      
      const staleSessions = stmts.findStaleSessions.all(sessionId, STALE_MINUTES);
      const now = new Date().toISOString();
      for (const stale of staleSessions) {
        const staleAgents = stmts.listAgentsBySession.all(stale.id);
        for (const agent of staleAgents) {
          if (agent.status !== "completed" && agent.status !== "error") {
            stmts.updateAgent.run(null, "completed", null, null, now, null, agent.id);
            broadcast("agent_updated", stmts.getAgent.get(agent.id));
          }
        }
        stmts.updateSession.run(null, "abandoned", now, null, stale.id);
        broadcast("session_updated", stmts.getSession.get(stale.id));
      }
      break;
    }

    case "SessionEnd": {
      const endSession = stmts.getSession.get(sessionId);
      const endLabel = endSession?.name || `Session ${sessionId.slice(0, 8)}`;
      summary = `Session closed: ${endLabel}`;

      
      
      clearAwaitingInput(sessionId, mainAgentId, false);

      
      
      
      
      
      const endResult = data.transcript_path ? transcriptCache.extract(data.transcript_path) : null;
      const finalSessionStatus =
        endSession?.status === "error" && isErrorAtTail(endResult) ? "error" : "completed";
      const allAgents = stmts.listAgentsBySession.all(sessionId);
      const now = new Date().toISOString();
      for (const agent of allAgents) {
        if (agent.status !== "completed" && agent.status !== "error") {
          const agentFinal = finalSessionStatus === "error" ? "error" : "completed";
          stmts.updateAgent.run(null, agentFinal, null, null, now, null, agent.id);
          broadcast("agent_updated", stmts.getAgent.get(agent.id));
        }
      }
      stmts.updateSession.run(null, finalSessionStatus, now, null, sessionId);
      broadcast("session_updated", stmts.getSession.get(sessionId));

      break;
    }

    case "UserPromptSubmit": {
      
      
      
      
      
      
      
      summary = "User prompt submitted";
      clearAwaitingInput(sessionId, mainAgentId, true);
      if (mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error") {
        stmts.updateAgent.run(null, "working", null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "Notification": {
      const msg = data.message || "Notification received";
      
      if (/compact|compress|context.*(reduc|truncat|summar)/i.test(msg)) {
        eventType = "Compaction";
        summary = msg;
      } else if (isWaitingForUserMessage(msg)) {
        
        
        
        
        const ts = new Date().toISOString();
        stmts.setSessionAwaitingInput.run(ts, sessionId);
        broadcast("session_updated", stmts.getSession.get(sessionId));
        if (mainAgentId) {
          stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
          stmts.setAgentAwaitingInput.run(ts, mainAgentId);
          broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
        }
        summary = msg;
      } else {
        summary = msg;
      }
      break;
    }

    default: {
      summary = `Event: ${hookType}`;
    }
  }

  
  
  
  
  
  
  
  
  
  if (data.transcript_path) {
    const result = transcriptCache.extract(data.transcript_path);
    if (result) {
      const { tokensByModel, compaction, latestModel } = result;

      
      
      
      
      
      if (latestModel) {
        const upd = stmts.updateSessionModel.run(latestModel, sessionId, latestModel);
        if (upd.changes > 0) {
          const refreshed = stmts.getSession.get(sessionId);
          if (refreshed) broadcast("session_updated", refreshed);
        }
      }

      
      
      
      syncSessionName(stmts.getSession.get(sessionId), result);

      
      
      
      
      applyFirstUserDescriptor(sessionId, result);

      
      
      
      if (compaction) {
        for (const entry of compaction.entries) {
          const compactId = `${sessionId}-compact-${entry.uuid}`;
          if (stmts.getAgent.get(compactId)) continue;

          const ts = entry.timestamp || new Date().toISOString();
          stmts.insertAgent.run(
            compactId,
            sessionId,
            "Context Compaction",
            "subagent",
            "compaction",
            "completed",
            "Automatic conversation context compression",
            mainAgentId,
            null
          );
          
          
          
          
          
          db.prepare(
            "UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?"
          ).run(ts, ts, ts, compactId);
          broadcast("agent_created", stmts.getAgent.get(compactId));

          const compactSummary = `Context compacted - conversation history compressed (#${compaction.entries.indexOf(entry) + 1})`;
          stmts.insertEvent.run(
            sessionId,
            compactId,
            "Compaction",
            null,
            compactSummary,
            JSON.stringify({
              uuid: entry.uuid,
              timestamp: ts,
              compaction_number: compaction.entries.indexOf(entry) + 1,
              total_compactions: compaction.count,
            })
          );
          broadcast("new_event", {
            session_id: sessionId,
            agent_id: compactId,
            event_type: "Compaction",
            tool_name: null,
            summary: compactSummary,
            created_at: ts,
          });
        }
      }

      if (tokensByModel) {
        
        
        for (const tokens of Object.values(tokensByModel)) {
          stmts.replaceTokenUsage.run(
            sessionId,
            tokens.model,
            tokens.speed,
            tokens.geo,
            tokens.tier,
            tokens.input,
            tokens.output,
            tokens.cacheRead,
            tokens.cacheWrite,
            tokens.cacheWrite1h,
            tokens.webSearch,
            tokens.webFetch,
            tokens.codeExec
          );
        }
      }

      
      if (result.errors) {
        let newErrorRecorded = false;
        for (const apiErr of result.errors) {
          
          const errKey = `${apiErr.type}:${apiErr.timestamp || ""}`;
          const existing = db
            .prepare(
              `SELECT 1 FROM events WHERE session_id = ? AND event_type = 'APIError'
               AND summary = ? LIMIT 1`
            )
            .get(sessionId, `${apiErr.type}: ${apiErr.message}`);
          if (existing) continue;

          stmts.insertEvent.run(
            sessionId,
            mainAgentId,
            "APIError",
            null,
            `${apiErr.type}: ${apiErr.message}`,
            JSON.stringify(apiErr)
          );
          broadcast("new_event", {
            session_id: sessionId,
            agent_id: mainAgentId,
            event_type: "APIError",
            tool_name: null,
            summary: `${apiErr.type}: ${apiErr.message}`,
            created_at: apiErr.timestamp || new Date().toISOString(),
          });
          newErrorRecorded = true;
        }

        
        
        
        
        
        
        
        
        
        
        if (newErrorRecorded && isErrorAtTail(result)) {
          const curSession = stmts.getSession.get(sessionId);
          if (curSession && curSession.status === "active") {
            stmts.updateSession.run(null, "error", null, null, sessionId);
            broadcast("session_updated", stmts.getSession.get(sessionId));
          }
          if (mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error") {
            stmts.updateAgent.run(null, "error", null, null, null, null, mainAgentId);
            clearAwaitingInput(sessionId, mainAgentId, false);
            broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
          }
        }
      }

      
      
      
      
      
      
      
      
      
      
      {
        const curSession = stmts.getSession.get(sessionId);
        if (curSession && curSession.status === "error" && !isErrorAtTail(result)) {
          stmts.reactivateSession.run(sessionId);
          broadcast("session_updated", stmts.getSession.get(sessionId));
          const curMain = mainAgentId ? stmts.getAgent.get(mainAgentId) : null;
          if (curMain && curMain.status === "error") {
            stmts.reactivateAgent.run(mainAgentId);
            broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
          }
        }
      }

      
      if (result.turnDurations) {
        for (const td of result.turnDurations) {
          const tdTs = td.timestamp || new Date().toISOString();
          
          const existing = db
            .prepare(
              "SELECT 1 FROM events WHERE session_id = ? AND event_type = 'TurnDuration' AND created_at = ? LIMIT 1"
            )
            .get(sessionId, tdTs);
          if (existing) continue;

          const tdSummary = `Turn completed in ${(td.durationMs / 1000).toFixed(1)}s`;
          stmts.insertEvent.run(
            sessionId,
            mainAgentId,
            "TurnDuration",
            null,
            tdSummary,
            JSON.stringify({ durationMs: td.durationMs })
          );
          broadcast("new_event", {
            session_id: sessionId,
            agent_id: mainAgentId,
            event_type: "TurnDuration",
            tool_name: null,
            summary: tdSummary,
            created_at: tdTs,
          });
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
    summary,
    JSON.stringify(data)
    
  );

  const event = {
    session_id: sessionId,
    agent_id: agentId,
    event_type: eventType,
    tool_name: toolName,
    summary,
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
    
    
    
    
    
    
    
    let parentTokenModels = [];
    try {
      const mainResult = transcriptCache.extract(data.transcript_path);
      if (mainResult && mainResult.tokensByModel) {
        parentTokenModels = Object.values(mainResult.tokensByModel)
          .map((b) => b.model)
          .filter(Boolean);
      }
      if (mainResult && mainResult.latestModel) parentTokenModels.push(mainResult.latestModel);
    } catch {
      
    }
    scanAndImportSubagents(dbModule, data.session_id, data.transcript_path, {
      parentModels: parentTokenModels,
    })
      .then(({ created, reparented }) => {
        if (created > 0 || reparented > 0) {
          
          
          
          
          broadcast("new_event", {
            session_id: data.session_id,
            agent_id: null,
            event_type: "SubagentJsonlImported",
            tool_name: null,
            summary:
              created > 0 && reparented > 0
                ? `Imported ${created} subagent record(s) and re-parented ${reparented} nested subagent(s)`
                : created > 0
                  ? `Imported ${created} subagent record(s) from JSONL`
                  : `Re-parented ${reparented} nested subagent(s)`,
            created_at: new Date().toISOString(),
          });
        }
      })
      .catch(() => {
        
      });
  }

  
  
  
  
  if (
    ["Stop", "SubagentStop", "SessionEnd"].includes(hook_type) &&
    data.session_id &&
    data.transcript_path
  ) {
    ingestWorkflowsForSession(dbModule, {
      id: data.session_id,
      transcript_path: data.transcript_path,
    })
      .then((changed) => {
        if (!changed || changed.length === 0) return;
        for (const wf of changed) broadcast("workflow_upserted", wf);
        
        
        const sess = stmts.getSession.get(data.session_id);
        if (sess) broadcast("session_updated", sess);
      })
      .catch(() => {
        
      });
  }
});

const WATCHDOG_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 10_000; 

const WORKING_IDLE_MS = (() => {
  const raw = parseInt(process.env.DASHBOARD_WORKING_IDLE_SECONDS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 120_000; 
})();

const LIVENESS_IDLE_MS = (() => {
  const raw = parseInt(process.env.DASHBOARD_LIVENESS_IDLE_SECONDS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 60_000;
})();

function isErrorAtTail(result) {
  if (!result || !Array.isArray(result.errors) || result.errors.length === 0) return false;
  let lastErrorTs = null;
  for (const e of result.errors) {
    if (e && e.timestamp && (!lastErrorTs || e.timestamp > lastErrorTs)) lastErrorTs = e.timestamp;
  }
  if (!lastErrorTs) return false; 
  if (!result.lastTurnTs) return true; 
  return lastErrorTs >= result.lastTurnTs; 
}

function watchdogCheck() {
  try {
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    
    const staleSessions = db
      .prepare(
        `SELECT s.id, s.status, s.cwd,
                (SELECT MAX(e.created_at) FROM events e WHERE e.session_id = s.id) as last_event,
                (SELECT e.data FROM events e WHERE e.session_id = s.id
                 AND e.event_type IN ('SessionStart','UserPromptSubmit','PreToolUse','Stop','Notification')
                 ORDER BY e.created_at DESC LIMIT 1) as last_data
         FROM sessions s
         WHERE s.status IN ('active', 'error') AND s.updated_at < ?`
      )
      .all(cutoff);

    for (const sess of staleSessions) {
      
      let tPath = null;
      if (sess.last_data) {
        try {
          tPath = JSON.parse(sess.last_data).transcript_path;
        } catch {}
      }
      
      
      if (!tPath && sess.cwd) {
        const slug = sess.cwd.replace(/[\/\.]/g, "-");
        const candidate = path.join(os.homedir(), ".claude", "projects", slug, `${sess.id}.jsonl`);
        if (fs.existsSync(candidate)) tPath = candidate;
      }
      if (!tPath) continue;

      
      
      const result = transcriptCache.extract(tPath);
      if (!result) continue;

      
      
      
      
      
      const fullSess = stmts.getSession.get(sess.id);
      if (fullSess) {
        syncSessionName(fullSess, result);
        applyFirstUserDescriptor(sess.id, result);
      }

      const mainAgent = db
        .prepare("SELECT * FROM agents WHERE session_id = ? AND type = 'main' LIMIT 1")
        .get(sess.id);
      const mainAgentId = mainAgent?.id ?? null;

      
      
      
      
      
      
      
      if (sess.status === "error" && !isErrorAtTail(result)) {
        stmts.reactivateSession.run(sess.id);
        broadcast("session_updated", stmts.getSession.get(sess.id));
        if (mainAgent && mainAgent.status === "error") {
          stmts.reactivateAgent.run(mainAgentId);
          broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
        }
        continue; 
      }

      
      
      
      
      
      
      
      
      
      
      
      
      
      if (
        result.pendingInterrupt &&
        mainAgent &&
        mainAgent.status === "working" &&
        !mainAgent.awaiting_input_since
      ) {
        recoverInterruptedSession(sess.id, fullSess, mainAgentId, "interrupted by user");
        
        
        continue;
      }

      if (!result.errors || result.errors.length === 0) {
        
        
        
        
        
        
        
        
        if (
          mainAgent &&
          mainAgent.status === "working" &&
          !mainAgent.current_tool &&
          !mainAgent.awaiting_input_since
        ) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(tPath).mtimeMs;
          } catch {
            
          }
          const hookMs = Date.parse(sess.last_event) || 0;
          const idleMs = Date.now() - Math.max(mtimeMs, hookMs);
          if (idleMs > WORKING_IDLE_MS) {
            recoverInterruptedSession(sess.id, fullSess, mainAgentId, "interrupted by user");
          }
        }
        continue;
      }

      
      const existingErrorCount = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM events WHERE session_id = ? AND event_type = 'APIError'"
        )
        .get(sess.id).cnt;

      if (existingErrorCount < result.errors.length) {
        
        const existingSummaries = new Set(
          db
            .prepare(`SELECT summary FROM events WHERE session_id = ? AND event_type = 'APIError'`)
            .all(sess.id)
            .map((r) => r.summary)
        );

        for (const apiErr of result.errors) {
          const summary = `${apiErr.type}: ${apiErr.message}`;
          if (existingSummaries.has(summary)) continue;

          stmts.insertEvent.run(
            sess.id,
            mainAgentId,
            "APIError",
            null,
            summary,
            JSON.stringify(apiErr)
          );
          broadcast("new_event", {
            session_id: sess.id,
            agent_id: mainAgentId,
            event_type: "APIError",
            tool_name: null,
            summary,
            created_at: apiErr.timestamp || new Date().toISOString(),
          });
        }

        
        
        
        
        
        
        if (isErrorAtTail(result)) {
          stmts.updateSession.run(null, "error", null, null, sess.id);
          broadcast("session_updated", stmts.getSession.get(sess.id));
          if (mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error") {
            stmts.updateAgent.run(null, "error", null, null, null, null, mainAgentId);
            if (mainAgentId) {
              stmts.clearAgentAwaitingInput.run(mainAgentId);
              broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
            }
          }
        }
      }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    livenessReap();
  } catch (err) {
    
    console.warn("[WATCHDOG] Error during check:", err?.message || err);
  }
}

function livenessReap({ ignoreIdleGate = false } = {}) {
  const fs = require("fs");
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
  const now = Date.now();
  for (const sess of activeSessions) {
    let resolvedCwd;
    try {
      resolvedCwd = path.resolve(sess.cwd);
    } catch {
      continue;
    }
    if (probe.cwds.has(resolvedCwd)) continue;

    
    
    
    
    
    
    
    
    
    
    if (!ignoreIdleGate) {
      let lastActivityMs = 0;
      if (sess.transcript_path) {
        try {
          lastActivityMs = fs.statSync(sess.transcript_path).mtimeMs;
        } catch {
          
        }
      }
      if (!lastActivityMs) lastActivityMs = Date.parse(sess.updated_at) || 0;
      if (now - lastActivityMs < LIVENESS_IDLE_MS) continue;
    }

    
    const ts = new Date().toISOString();
    clearAwaitingInput(sess.id, null, false);
    const agents = stmts.listAgentsBySession.all(sess.id);
    for (const agent of agents) {
      if (agent.status !== "completed" && agent.status !== "error") {
        stmts.updateAgent.run(null, "completed", null, null, ts, null, agent.id);
      }
    }
    stmts.updateSession.run(null, "completed", ts, null, sess.id);

    const label = sess.name || `Session ${sess.id.slice(0, 8)}`;
    const summary = `Session closed: ${label} (no running claude process)`;
    const mainAgentId = `${sess.id}-main`;
    stmts.insertEvent.run(
      sess.id,
      stmts.getAgent.get(mainAgentId) ? mainAgentId : null,
      "SessionEnd",
      null,
      summary,
      JSON.stringify({ session_id: sess.id, source: "liveness-probe" })
    );

    broadcast("session_updated", stmts.getSession.get(sess.id));
    for (const agent of agents) {
      if (agent.status !== "completed" && agent.status !== "error") {
        broadcast("agent_updated", stmts.getAgent.get(agent.id));
      }
    }
    broadcast("new_event", {
      session_id: sess.id,
      agent_id: stmts.getAgent.get(mainAgentId) ? mainAgentId : null,
      event_type: "SessionEnd",
      tool_name: null,
      summary,
      created_at: ts,
    });
    console.log(`[WATCHDOG] Liveness reap: completed dead session ${sess.id} (${label})`);
  }
}

const watchdogTimer = setInterval(watchdogCheck, WATCHDOG_INTERVAL_MS);

if (watchdogTimer.unref) watchdogTimer.unref();

router.transcriptCache = transcriptCache;
router.watchdogCheck = watchdogCheck;
router.livenessReap = livenessReap;
module.exports = router;
