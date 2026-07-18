#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  bucketKey,
  emptyBucket,
  extractUsageFields,
  normalizeSpeed,
  normalizeGeo,
  normalizeTier,
  accumulateBucket,
} = require("../server/lib/token-usage");

const {
  getClaudeHome,
  getProjectsDir,
  getTranscriptSnapshotDir,
} = require("../server/lib/claude-home");
const { extractFirstUserText } = require("../server/lib/transcript-cache");
const CLAUDE_DIR = getClaudeHome();
const PROJECTS_DIR = getProjectsDir();

function snapshotTranscript(sourceJsonlPath, sessionId) {
  try {
    const srcMain = path.resolve(sourceJsonlPath);
    const snapDir = getTranscriptSnapshotDir();
    const destMain = path.join(snapDir, `${sessionId}.jsonl`);
    if (path.resolve(destMain) !== srcMain) {
      copyIfNewer(srcMain, destMain);
    }

    
    for (const subPath of findSessionSubagents(sourceJsonlPath)) {
      const destSub = path.join(snapDir, sessionId, "subagents", path.basename(subPath));
      if (path.resolve(destSub) === path.resolve(subPath)) continue;
      copyIfNewer(subPath, destSub);
    }

    
    
    
    
    for (const sub of findSessionWorkflowSubagents(sourceJsonlPath)) {
      const destSub = path.join(snapDir, sessionId, "subagents", sub.rel);
      if (path.resolve(destSub) === path.resolve(sub.abs)) continue;
      copyIfNewer(sub.abs, destSub);
    }
  } catch {
    
  }
}

function copyIfNewer(src, dest) {
  let srcSize;
  try {
    srcSize = fs.statSync(src).size;
  } catch {
    return; 
  }
  let destSize = -1;
  try {
    destSize = fs.statSync(dest).size;
  } catch {
    
  }
  if (destSize >= srcSize) return; 
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function firstUserLabel(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return null;
  return t.length > 60 ? t.slice(0, 57) + "..." : t;
}

async function parseSessionFile(filePath) {
  const sessionId = path.basename(filePath, ".jsonl");

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let cwd = null;
  let model = null;
  let version = null;
  let slug = null;
  let gitBranch = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  const teams = new Set();
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  const tokensByModel = {};
  const messageTimestamps = [];
  const toolUses = [];
  const compactions = [];
  const apiErrors = [];
  const turnDurations = [];
  let entrypoint = null;
  let permissionMode = null;
  let thinkingBlockCount = 0;
  const toolResultErrors = [];
  const usageExtras = { service_tiers: new Set(), speeds: new Set(), inference_geos: new Set() };
  
  
  
  let customTitle = null;
  let aiTitle = null;
  
  
  let firstUserMessage = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      if (entry.customTitle.trim()) customTitle = entry.customTitle.trim();
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
      if (entry.aiTitle.trim()) aiTitle = entry.aiTitle.trim();
      continue;
    }

    if (entry.isCompactSummary) {
      compactions.push({ uuid: entry.uuid || null, timestamp: entry.timestamp || null });
    }

    
    if (entry.type === "system" && entry.subtype === "turn_duration" && entry.durationMs) {
      const turnTs = entry.timestamp
        ? typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString()
          : entry.timestamp
        : null;
      turnDurations.push({ durationMs: entry.durationMs, timestamp: turnTs });
    }

    
    if (entry.isApiErrorMessage) {
      const errContent = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const errText = errContent[0]?.text ? errContent[0].text.slice(0, 500) : "Unknown error";
      apiErrors.push({
        type: entry.error || "unknown_error",
        message: errText,
        timestamp: entry.timestamp
          ? typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString()
            : entry.timestamp
          : null,
      });
    }
    
    const rawMsg = entry.message || entry;
    if (rawMsg.type === "error" && rawMsg.error) {
      apiErrors.push({
        type: rawMsg.error.type || "unknown_error",
        message: rawMsg.error.message || "Unknown API error",
        timestamp: entry.timestamp
          ? typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString()
            : entry.timestamp
          : null,
      });
    }

    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!slug && entry.slug) slug = entry.slug;
    if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
    if (!version && entry.version) version = entry.version;
    if (!entrypoint && entry.entrypoint) entrypoint = entry.entrypoint;
    if (!permissionMode && entry.permissionMode) permissionMode = entry.permissionMode;

    const ts = entry.timestamp;
    if (ts) {
      const isoTs = typeof ts === "number" ? new Date(ts).toISOString() : ts;
      if (!firstTimestamp || isoTs < firstTimestamp) firstTimestamp = isoTs;
      if (!lastTimestamp || isoTs > lastTimestamp) lastTimestamp = isoTs;
    }

    if (entry.teamName) teams.add(entry.teamName);

    if (entry.type === "user") {
      userMessageCount++;
      if (firstUserMessage === null) {
        const firstText = extractFirstUserText(entry);
        if (firstText) firstUserMessage = firstText;
      }
      if (
        entry.toolUseResult &&
        typeof entry.toolUseResult === "object" &&
        entry.toolUseResult.is_error
      ) {
        const content =
          typeof entry.toolUseResult.content === "string"
            ? entry.toolUseResult.content.slice(0, 500)
            : JSON.stringify(entry.toolUseResult.content || "").slice(0, 500);
        const errTs = entry.timestamp
          ? typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString()
            : entry.timestamp
          : null;
        toolResultErrors.push({ content, timestamp: errTs });
      }
    }
    if (entry.type === "assistant") {
      assistantMessageCount++;
      const isoTs = ts ? (typeof ts === "number" ? new Date(ts).toISOString() : ts) : null;
      if (isoTs) messageTimestamps.push(isoTs);
      const msg = entry.message || {};
      const msgModel = msg.model || null;
      if (!model && msgModel && msgModel !== "<synthetic>") model = msgModel;
      if (msgModel && msgModel !== "<synthetic>" && msg.usage) {
        const usage = msg.usage;
        const key = bucketKey(
          msgModel,
          normalizeSpeed(usage),
          normalizeGeo(usage),
          normalizeTier(usage)
        );
        if (tokensByModel[key] === undefined) {
          tokensByModel[key] = emptyBucket(
            msgModel,
            normalizeSpeed(usage),
            normalizeGeo(usage),
            normalizeTier(usage)
          );
        }
        accumulateBucket(tokensByModel[key], extractUsageFields(usage));
      }
      if (msg.usage) {
        if (msg.usage.service_tier) usageExtras.service_tiers.add(msg.usage.service_tier);
        if (msg.usage.speed) usageExtras.speeds.add(msg.usage.speed);
        if (msg.usage.inference_geo && msg.usage.inference_geo !== "not_available")
          usageExtras.inference_geos.add(msg.usage.inference_geo);
      }
      
      const content = msg.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            toolUses.push({
              name: block.name,
              timestamp: isoTs || firstTimestamp,
              input: block.input || null,
            });
          }
          if (block.type === "thinking") thinkingBlockCount++;
        }
      }
    }
  }

  if (!firstTimestamp) return null;

  const projectName = cwd ? path.basename(cwd) : slug || `Session ${sessionId.slice(0, 8)}`;
  
  
  
  
  const fallbackName = slug
    ? `${projectName} (${slug})`
    : `${projectName} - ${sessionId.slice(0, 8)}`;
  const sessionName = customTitle || aiTitle || firstUserLabel(firstUserMessage) || fallbackName;

  
  let fileModifiedAt = null;
  try {
    const stat = fs.statSync(filePath);
    fileModifiedAt = stat.mtimeMs;
  } catch {
    
  }

  return {
    sessionId,
    name: sessionName,
    customTitle,
    aiTitle,
    firstUserMessage,
    cwd,
    model,
    version,
    slug,
    gitBranch,
    
    
    
    
    transcriptPath: filePath,
    startedAt: firstTimestamp,
    endedAt: lastTimestamp,
    teams: [...teams],
    userMessages: userMessageCount,
    assistantMessages: assistantMessageCount,
    tokensByModel,
    messageTimestamps,
    toolUses,
    compactions,
    apiErrors,
    fileModifiedAt,
    turnDurations,
    entrypoint,
    permissionMode,
    thinkingBlockCount,
    toolResultErrors,
    usageExtras: {
      service_tiers: [...usageExtras.service_tiers],
      speeds: [...usageExtras.speeds],
      inference_geos: [...usageExtras.inference_geos],
    },
  };
}

async function parseSubagentFile(filePath) {
  const agentId = path.basename(filePath, ".jsonl").replace(/^agent-/, "");

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let task = null;
  let model = null;
  let agentType = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  const tokensByModel = {};
  const toolNames = new Set();
  let thinkingBlockCount = 0;
  
  
  
  const toolCalls = []; 
  const toolResults = new Map(); 
  
  
  
  
  
  const spawnedChildren = new Set();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.toolUseResult && entry.toolUseResult.agentId) {
      spawnedChildren.add(entry.toolUseResult.agentId);
    }

    const ts = entry.timestamp;
    let isoTs = null;
    if (ts) {
      isoTs = typeof ts === "number" ? new Date(ts).toISOString() : ts;
      if (!firstTimestamp || isoTs < firstTimestamp) firstTimestamp = isoTs;
      if (!lastTimestamp || isoTs > lastTimestamp) lastTimestamp = isoTs;
    }

    if (entry.type === "user") {
      userMessageCount++;
      const msgContent = entry.message?.content;
      if (!task) {
        if (typeof msgContent === "string") {
          task = msgContent.slice(0, 500);
        } else if (Array.isArray(msgContent)) {
          const textBlock = msgContent.find((b) => b && b.type === "text");
          if (textBlock) task = (textBlock.text || "").slice(0, 500);
        }
      }
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block && block.type === "tool_result" && block.tool_use_id) {
            toolResults.set(block.tool_use_id, {
              content: block.content,
              is_error: !!block.is_error,
              timestamp: isoTs,
            });
          }
        }
      }
    }

    if (entry.type === "assistant") {
      assistantMessageCount++;
      const msg = entry.message || {};
      const msgModel = msg.model || null;
      if (!model && msgModel && msgModel !== "<synthetic>") model = msgModel;
      if (msgModel && msgModel !== "<synthetic>" && msg.usage) {
        const usage = msg.usage;
        const key = bucketKey(
          msgModel,
          normalizeSpeed(usage),
          normalizeGeo(usage),
          normalizeTier(usage)
        );
        if (!tokensByModel[key]) {
          tokensByModel[key] = emptyBucket(
            msgModel,
            normalizeSpeed(usage),
            normalizeGeo(usage),
            normalizeTier(usage)
          );
        }
        accumulateBucket(tokensByModel[key], extractUsageFields(usage));
      }
      const content = msg.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            toolNames.add(block.name);
            if (block.id) {
              toolCalls.push({
                id: block.id,
                name: block.name,
                input: block.input || null,
                timestamp: isoTs,
              });
            }
          }
          if (block.type === "thinking") thinkingBlockCount++;
        }
      }
    }

    
    if (entry.type === "progress" && entry.data?.hookEvent) {
      
    }
  }

  
  const toolEvents = toolCalls.map((call) => {
    const result = toolResults.get(call.id) || null;
    return {
      tool_use_id: call.id,
      tool_name: call.name,
      tool_input: call.input,
      pre_timestamp: call.timestamp,
      tool_response: result ? result.content : null,
      is_error: result ? result.is_error : false,
      post_timestamp: result ? result.timestamp : null,
    };
  });

  if (!firstTimestamp) return null;

  
  const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.agentType) agentType = meta.agentType;
    }
  } catch {
    
  }

  return {
    agentId,
    agentType,
    task,
    model,
    startedAt: firstTimestamp,
    endedAt: lastTimestamp,
    userMessages: userMessageCount,
    assistantMessages: assistantMessageCount,
    tokensByModel,
    toolNames: [...toolNames],
    thinkingBlockCount,
    toolEvents,
    spawnedChildren: [...spawnedChildren],
  };
}

function importCompactions(dbModule, sessionId, mainAgentId, compactions) {
  if (!compactions || compactions.length === 0) return 0;
  const { db, stmts } = dbModule;
  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let created = 0;
  for (let i = 0; i < compactions.length; i++) {
    const c = compactions[i];
    if (!c.uuid) continue;
    const compactId = `${sessionId}-compact-${c.uuid}`;
    if (stmts.getAgent.get(compactId)) continue;

    const ts = c.timestamp || new Date().toISOString();
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
    db.prepare("UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(
      ts,
      ts,
      ts,
      compactId
    );

    const summary = `Context compacted - conversation history compressed (#${i + 1})`;
    insertEvent.run(
      sessionId,
      compactId,
      "Compaction",
      null,
      summary,
      JSON.stringify({
        uuid: c.uuid,
        timestamp: ts,
        compaction_number: i + 1,
        total_compactions: compactions.length,
        imported: true,
      }),
      ts
    );
    created++;
  }
  return created;
}

function importSubagents(dbModule, sessionId, mainAgentId, toolUses) {
  if (!toolUses || toolUses.length === 0) return 0;
  const { stmts } = dbModule;
  const insertEvent = dbModule.db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  let created = 0;
  let agentIndex = 0;

  for (const tu of toolUses) {
    if (tu.name !== "Agent" || !tu.input) continue;
    const input = tu.input;
    agentIndex++;

    const subId = `${sessionId}-subagent-${agentIndex}`;
    if (stmts.getAgent.get(subId)) continue;

    const rawName =
      input.description ||
      input.subagent_type ||
      (input.prompt ? input.prompt.split("\n")[0].slice(0, 60) : null) ||
      "Subagent";
    const subName = rawName.length > 60 ? rawName.slice(0, 57) + "..." : rawName;
    const ts = tu.timestamp || new Date().toISOString();

    stmts.insertAgent.run(
      subId,
      sessionId,
      subName,
      "subagent",
      input.subagent_type || null,
      "completed",
      input.prompt ? input.prompt.slice(0, 500) : null,
      mainAgentId,
      null
    );
    dbModule.db
      .prepare("UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(ts, ts, ts, subId);

    insertEvent.run(
      sessionId,
      subId,
      "PreToolUse",
      "Agent",
      `Subagent spawned: ${subName} (imported)`,
      JSON.stringify({ imported: true, subagent_type: input.subagent_type || null }),
      ts
    );
    created++;
  }
  return created;
}

function importApiErrors(dbModule, sessionId, mainAgentId, apiErrors) {
  if (!apiErrors || apiErrors.length === 0) return 0;
  const { db } = dbModule;
  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let created = 0;
  for (const err of apiErrors) {
    const summary = `${err.type}: ${err.message}`;
    const ts = err.timestamp || new Date().toISOString();
    const existing = db
      .prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND event_type = 'APIError' AND summary = ? LIMIT 1"
      )
      .get(sessionId, summary);
    if (existing) continue;

    insertEvent.run(sessionId, mainAgentId, "APIError", null, summary, JSON.stringify(err), ts);
    created++;
  }
  return created;
}

const SUBAGENT_EVENT_VALUE_CAP = 50_000; 
function truncateForEvent(value) {
  if (value == null) return value;
  let serialized;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized.length <= SUBAGENT_EVENT_VALUE_CAP) return value;
  if (typeof value === "string") {
    return value.slice(0, SUBAGENT_EVENT_VALUE_CAP) + "\n…[truncated]";
  }
  return {
    _truncated: true,
    _original_length: serialized.length,
    preview: serialized.slice(0, SUBAGENT_EVENT_VALUE_CAP),
  };
}

const SUBAGENT_LIVE_MATCH_TOLERANCE_MS = 30_000;
function findLiveSubagentForJsonl(dbModule, sessionId, subData) {
  if (!subData.agentType || !subData.startedAt) return null;
  return dbModule.db
    .prepare(
      `SELECT id FROM agents
       WHERE session_id = ?
         AND type = 'subagent'
         AND subagent_type = ?
         AND id NOT LIKE ?
         AND ABS(CAST(strftime('%s', started_at) AS INTEGER) -
                 CAST(strftime('%s', ?) AS INTEGER)) <= ?
       ORDER BY ABS(CAST(strftime('%s', started_at) AS INTEGER) -
                    CAST(strftime('%s', ?) AS INTEGER)) ASC
       LIMIT 1`
    )
    .get(
      sessionId,
      subData.agentType,
      `${sessionId}-jsonl-%`,
      subData.startedAt,
      SUBAGENT_LIVE_MATCH_TOLERANCE_MS / 1000,
      subData.startedAt
    );
}

function combineSessionTokens(session) {
  const combined = {};
  const merge = (src) => {
    if (!src) return;
    for (const [key, tok] of Object.entries(src)) {
      if (!combined[key]) {
        combined[key] = emptyBucket(tok.model, tok.speed, tok.geo, tok.tier);
      }
      accumulateBucket(combined[key], tok);
    }
  };
  merge(session.tokensByModel);
  if (Array.isArray(session.parsedSubagents)) {
    for (const sub of session.parsedSubagents) merge(sub.tokensByModel);
  }
  return combined;
}

function writeSessionTokens(dbModule, sessionId, tokensByModel) {
  const { stmts } = dbModule;
  let written = 0;
  for (const tokens of Object.values(tokensByModel || {})) {
    if (
      (tokens.input || 0) > 0 ||
      (tokens.output || 0) > 0 ||
      (tokens.cacheRead || 0) > 0 ||
      (tokens.cacheWrite || 0) > 0 ||
      (tokens.webSearch || 0) > 0 ||
      (tokens.webFetch || 0) > 0 ||
      (tokens.codeExec || 0) > 0
    ) {
      stmts.replaceTokenUsage.run(
        sessionId,
        tokens.model,
        tokens.speed,
        tokens.geo,
        tokens.tier,
        tokens.input || 0,
        tokens.output || 0,
        tokens.cacheRead || 0,
        tokens.cacheWrite || 0,
        tokens.cacheWrite1h || 0,
        tokens.webSearch || 0,
        tokens.webFetch || 0,
        tokens.codeExec || 0
      );
      written++;
    }
  }
  return written;
}

function subagentTokenRows(tokensByModel) {
  const rows = [];
  for (const b of Object.values(tokensByModel || {})) {
    if (!b || !b.model) continue;
    const row = {
      model: b.model,
      speed: b.speed,
      inference_geo: b.geo,
      service_tier: b.tier,
      input_tokens: b.input || 0,
      output_tokens: b.output || 0,
      cache_read_tokens: b.cacheRead || 0,
      cache_write_tokens: b.cacheWrite || 0,
      cache_write_1h_tokens: b.cacheWrite1h || 0,
      web_search_requests: b.webSearch || 0,
      web_fetch_requests: b.webFetch || 0,
      code_execution_requests: b.codeExec || 0,
    };
    const hasUsage =
      row.input_tokens ||
      row.output_tokens ||
      row.cache_read_tokens ||
      row.cache_write_tokens ||
      row.web_search_requests ||
      row.code_execution_requests;
    if (hasUsage) rows.push(row);
  }
  return rows;
}

function importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subData) {
  if (!subData) return 0;
  const { db, stmts } = dbModule;

  const jsonlSubId = `${sessionId}-jsonl-${subData.agentId}`;
  const liveSub = findLiveSubagentForJsonl(dbModule, sessionId, subData);
  const targetAgentId = liveSub ? liveSub.id : jsonlSubId;
  const existingJsonl = stmts.getAgent.get(jsonlSubId);

  const subName = subData.agentType ? subData.agentType : `Subagent ${subData.agentId.slice(0, 8)}`;
  
  
  const tokenRows = subagentTokenRows(subData.tokensByModel);
  let created = 0;

  
  
  
  
  if (!liveSub && !existingJsonl) {
    stmts.insertAgent.run(
      jsonlSubId,
      sessionId,
      subName,
      "subagent",
      subData.agentType || null,
      "completed",
      subData.task,
      mainAgentId,
      JSON.stringify({
        imported: true,
        source: "jsonl",
        model: subData.model,
        tools: subData.toolNames,
        user_messages: subData.userMessages,
        assistant_messages: subData.assistantMessages,
        thinking_blocks: subData.thinkingBlockCount,
        tokens: tokenRows,
      })
    );
    db.prepare("UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(
      subData.startedAt,
      subData.endedAt,
      subData.endedAt,
      jsonlSubId
    );
    created++;
  }

  
  
  
  
  
  
  
  
  
  
  {
    const row = stmts.getAgent.get(targetAgentId);
    if (row) {
      let meta = {};
      try {
        meta = row.metadata ? JSON.parse(row.metadata) : {};
      } catch {
        meta = {};
      }
      let changed = false;
      if (subData.model && !meta.model) {
        meta.model = subData.model;
        changed = true;
      }
      
      
      
      
      
      if (subData.toolNames && subData.toolNames.length > 0 && !meta.tools) {
        meta.tools = subData.toolNames;
        changed = true;
      }
      if (meta.user_messages == null && subData.userMessages != null) {
        meta.user_messages = subData.userMessages;
        changed = true;
      }
      if (meta.assistant_messages == null && subData.assistantMessages != null) {
        meta.assistant_messages = subData.assistantMessages;
        changed = true;
      }
      if (meta.thinking_blocks == null && subData.thinkingBlockCount != null) {
        meta.thinking_blocks = subData.thinkingBlockCount;
        changed = true;
      }
      
      
      
      
      const hasTokensKey = Object.prototype.hasOwnProperty.call(meta, "tokens");
      const tokensChanged =
        tokenRows.length > 0 && JSON.stringify(meta.tokens || []) !== JSON.stringify(tokenRows);
      if (tokensChanged || !hasTokensKey) {
        meta.tokens = tokenRows;
        changed = true;
      }
      if (changed) {
        db.prepare("UPDATE agents SET metadata = ? WHERE id = ?").run(
          JSON.stringify(meta),
          targetAgentId
        );
      }
    }
  }

  
  
  
  

  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  
  
  if (!liveSub) {
    const spawnExists = db
      .prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND agent_id = ? AND event_type = 'PreToolUse' AND tool_name = 'Agent' AND data LIKE ? LIMIT 1"
      )
      .get(sessionId, mainAgentId, `%"subagent_id":${JSON.stringify(targetAgentId)}%`);
    if (!spawnExists) {
      insertEvent.run(
        sessionId,
        mainAgentId,
        "PreToolUse",
        "Agent",
        `Subagent spawned: ${subName} (from JSONL)`,
        JSON.stringify({
          imported: true,
          subagent_type: subData.agentType,
          subagent_id: targetAgentId,
          source: "subagent_jsonl",
        }),
        subData.startedAt
      );
      created++;
    }
  }

  
  
  if (Array.isArray(subData.toolEvents) && subData.toolEvents.length > 0) {
    const eventExists = db.prepare(
      "SELECT 1 FROM events WHERE agent_id = ? AND event_type = ? AND data LIKE ? LIMIT 1"
    );
    for (const tev of subData.toolEvents) {
      if (!tev.tool_use_id) continue;
      const useIdMarker = `%"tool_use_id":${JSON.stringify(tev.tool_use_id)}%`;
      const ts = tev.pre_timestamp || subData.startedAt;
      const truncatedInput = truncateForEvent(tev.tool_input);

      if (!eventExists.get(targetAgentId, "PreToolUse", useIdMarker)) {
        insertEvent.run(
          sessionId,
          targetAgentId,
          "PreToolUse",
          tev.tool_name,
          `Using tool: ${tev.tool_name}`,
          JSON.stringify({
            imported: true,
            source: "subagent_jsonl",
            tool_use_id: tev.tool_use_id,
            tool_name: tev.tool_name,
            tool_input: truncatedInput,
          }),
          ts
        );
        created++;
      }

      if (tev.post_timestamp && !eventExists.get(targetAgentId, "PostToolUse", useIdMarker)) {
        insertEvent.run(
          sessionId,
          targetAgentId,
          "PostToolUse",
          tev.tool_name,
          `Tool completed: ${tev.tool_name}`,
          JSON.stringify({
            imported: true,
            source: "subagent_jsonl",
            tool_use_id: tev.tool_use_id,
            tool_name: tev.tool_name,
            tool_input: truncatedInput,
            tool_response: truncateForEvent(tev.tool_response),
            is_error: tev.is_error,
          }),
          tev.post_timestamp
        );
        created++;
      }
    }
  }

  return created;
}

function resolveSubagentDbId(dbModule, sessionId, subData) {
  const live = findLiveSubagentForJsonl(dbModule, sessionId, subData);
  return live ? live.id : `${sessionId}-jsonl-${subData.agentId}`;
}

function reconcileSubagentParents(dbModule, sessionId, mainAgentId, parsedSubagents) {
  if (!Array.isArray(parsedSubagents) || parsedSubagents.length < 2) return 0;
  const { stmts } = dbModule;

  const byAgentId = new Map();
  for (const s of parsedSubagents) if (s && s.agentId) byAgentId.set(s.agentId, s);

  
  
  const parentOf = new Map();
  for (const s of parsedSubagents) {
    if (!s || !Array.isArray(s.spawnedChildren)) continue;
    for (const childId of s.spawnedChildren) {
      if (childId && childId !== s.agentId && byAgentId.has(childId)) {
        parentOf.set(childId, s.agentId);
      }
    }
  }
  if (parentOf.size === 0) return 0;

  let updated = 0;
  for (const s of parsedSubagents) {
    const parentTid = parentOf.get(s.agentId);
    if (!parentTid) continue; 
    const parentData = byAgentId.get(parentTid);
    if (!parentData) continue;

    const childDbId = resolveSubagentDbId(dbModule, sessionId, s);
    const parentDbId = resolveSubagentDbId(dbModule, sessionId, parentData);
    if (!childDbId || !parentDbId || childDbId === parentDbId) continue;

    const childRow = stmts.getAgent.get(childDbId);
    const parentRow = stmts.getAgent.get(parentDbId);
    if (!childRow || !parentRow) continue;
    if (childRow.parent_agent_id === parentDbId) continue; 

    
    
    
    
    
    let cursor = parentDbId;
    const seen = new Set([childDbId]);
    let createsCycle = false;
    while (cursor) {
      if (seen.has(cursor)) {
        createsCycle = true;
        break;
      }
      seen.add(cursor);
      cursor = stmts.getAgent.get(cursor)?.parent_agent_id || null;
    }
    if (createsCycle) continue;

    stmts.setAgentParent.run(parentDbId, childDbId);
    updated++;
  }
  return updated;
}

function importSession(dbModule, session) {
  const { db, stmts } = dbModule;
  const existing = stmts.getSession.get(session.sessionId);
  if (existing) {
    const meta = existing.metadata ? JSON.parse(existing.metadata) : {};
    if (!meta.imported) return { skipped: true };

    const mainAgentId = `${session.sessionId}-main`;
    const insertEvent = db.prepare(
      "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const importedData = JSON.stringify({ imported: true });
    let backfilled = false;

    
    
    
    
    
    
    
    
    const cutoffRows = db
      .prepare(
        "SELECT event_type, MAX(created_at) AS m FROM events WHERE session_id = ? GROUP BY event_type"
      )
      .all(session.sessionId);
    const cutoff = Object.create(null);
    for (const r of cutoffRows) cutoff[r.event_type] = r.m;
    const isNewer = (type, ts) => {
      if (!ts) return false;
      const c = cutoff[type];
      return !c || ts > c;
    };

    
    if (session.messageTimestamps && session.messageTimestamps.length > 0) {
      let added = 0;
      for (const ts of session.messageTimestamps) {
        if (!isNewer("Stop", ts)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "Stop",
          null,
          `${session.name} - response`,
          importedData,
          ts
        );
        added++;
      }
      if (added > 0) backfilled = true;
    } else if (!cutoff.Stop) {
      
      
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        `Session: ${session.name} (${session.userMessages} user / ${session.assistantMessages} assistant msgs)`,
        importedData,
        session.startedAt
      );
      backfilled = true;
    }

    
    if (session.toolUses && session.toolUses.length > 0) {
      let added = 0;
      for (const tu of session.toolUses) {
        if (!isNewer("PostToolUse", tu.timestamp)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "PostToolUse",
          tu.name,
          `${tu.name} (imported)`,
          importedData,
          tu.timestamp
        );
        added++;
      }
      if (added > 0) backfilled = true;
    }

    
    const compactCount = importCompactions(
      dbModule,
      session.sessionId,
      mainAgentId,
      session.compactions
    );
    if (compactCount > 0) backfilled = true;

    
    
    
    if (session.transcriptPath) {
      stmts.setSessionTranscriptPath.run(session.transcriptPath, session.sessionId);
    }

    
    
    
    
    
    
    
    
    const hasParsedSubs = session.parsedSubagents && session.parsedSubagents.length > 0;
    if (!hasParsedSubs) {
      const subagentCount = importSubagents(
        dbModule,
        session.sessionId,
        mainAgentId,
        session.toolUses
      );
      if (subagentCount > 0) backfilled = true;
    }

    
    const apiErrCount = importApiErrors(
      dbModule,
      session.sessionId,
      mainAgentId,
      session.apiErrors
    );
    if (apiErrCount > 0) backfilled = true;

    
    if (session.parsedSubagents && session.parsedSubagents.length > 0) {
      for (const subData of session.parsedSubagents) {
        if (importSubagentFromJsonl(dbModule, session.sessionId, mainAgentId, subData) > 0)
          backfilled = true;
      }
      
      if (
        reconcileSubagentParents(
          dbModule,
          session.sessionId,
          mainAgentId,
          session.parsedSubagents
        ) > 0
      )
        backfilled = true;
    }

    
    if (session.turnDurations && session.turnDurations.length > 0) {
      let added = 0;
      for (const td of session.turnDurations) {
        const ts = td.timestamp || session.startedAt;
        if (!isNewer("TurnDuration", ts)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "TurnDuration",
          null,
          `Turn completed in ${(td.durationMs / 1000).toFixed(1)}s`,
          JSON.stringify({ durationMs: td.durationMs, imported: true }),
          ts
        );
        added++;
      }
      if (added > 0) backfilled = true;
    }

    
    if (session.toolResultErrors && session.toolResultErrors.length > 0) {
      let added = 0;
      for (const tre of session.toolResultErrors) {
        const ts = tre.timestamp || session.startedAt;
        if (!isNewer("ToolError", ts)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "ToolError",
          null,
          `Tool execution failed: ${tre.content.slice(0, 100)}`,
          JSON.stringify({ ...tre, imported: true }),
          ts
        );
        added++;
      }
      if (added > 0) backfilled = true;
    }

    
    
    
    
    const metaChanged =
      meta.user_messages !== session.userMessages ||
      meta.assistant_messages !== session.assistantMessages ||
      (!meta.entrypoint && (session.entrypoint || session.turnDurations?.length > 0)) ||
      
      
      
      (session.turnDurations && (meta.turn_count || 0) !== session.turnDurations.length) ||
      (session.thinkingBlockCount || 0) > (meta.thinking_blocks || 0);
    if (metaChanged) {
      meta.user_messages = session.userMessages;
      meta.assistant_messages = session.assistantMessages;
      meta.entrypoint = meta.entrypoint || session.entrypoint || null;
      meta.permission_mode = meta.permission_mode || session.permissionMode || null;
      meta.thinking_blocks = Math.max(meta.thinking_blocks || 0, session.thinkingBlockCount || 0);
      meta.usage_extras = session.usageExtras || meta.usage_extras || null;
      meta.turn_count = session.turnDurations ? session.turnDurations.length : meta.turn_count || 0;
      meta.total_turn_duration_ms = session.turnDurations
        ? session.turnDurations.reduce((s, t) => s + t.durationMs, 0)
        : meta.total_turn_duration_ms || 0;
      stmts.updateSession.run(null, null, null, JSON.stringify(meta), session.sessionId);
      backfilled = true;
    }

    
    
    
    
    
    
    
    const descriptorName = firstUserLabel(session.firstUserMessage);
    const transcriptTitle = session.customTitle || session.aiTitle || descriptorName || null;
    if (transcriptTitle) {
      const base = session.cwd ? path.basename(session.cwd) : null;
      const stored = existing.name || "";
      const isAuto =
        !stored.trim() ||
        stored === `Session ${session.sessionId.slice(0, 8)}` ||
        (descriptorName !== null && stored === descriptorName) ||
        (base &&
          (stored === base || stored.startsWith(`${base} - `) || stored.startsWith(`${base} (`)));
      if (isAuto && stored !== transcriptTitle) {
        stmts.updateSession.run(transcriptTitle, null, null, null, session.sessionId);
        backfilled = true;
      }
    }

    
    
    
    
    
    if (descriptorName) {
      const mainRow = stmts.getAgent.get(`${session.sessionId}-main`);
      if (mainRow) {
        const base = session.cwd ? path.basename(session.cwd) : null;
        const storedAgent = mainRow.name || "";
        const suffix = storedAgent.startsWith("Main Agent - ")
          ? storedAgent.slice("Main Agent - ".length)
          : null;
        const suffixIsAuto =
          suffix !== null &&
          (!suffix.trim() ||
            suffix === `Session ${session.sessionId.slice(0, 8)}` ||
            (base &&
              (suffix === base ||
                suffix.startsWith(`${base} - `) ||
                suffix.startsWith(`${base} (`))));
        const agentNameIsAuto = !storedAgent.trim() || storedAgent === "Main Agent" || suffixIsAuto;
        const desiredAgentName = `Main Agent - ${descriptorName}`;
        const fillName = agentNameIsAuto && storedAgent !== desiredAgentName;
        const fillTask = !mainRow.task || !String(mainRow.task).trim();
        if (fillName || fillTask) {
          
          
          stmts.updateAgent.run(
            fillName ? desiredAgentName : null,
            null,
            fillTask ? session.firstUserMessage : null,
            mainRow.current_tool,
            null,
            null,
            mainRow.id
          );
          backfilled = true;
        }
      }
    }
    if (
      session.endedAt &&
      (!existing.ended_at || session.endedAt > existing.ended_at) &&
      existing.status !== "active"
    ) {
      db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(
        session.endedAt,
        session.sessionId
      );
      backfilled = true;
    }

    
    
    
    
    if (
      session.parsedSubagents &&
      session.parsedSubagents.some(
        (s) =>
          s.tokensByModel &&
          Object.values(s.tokensByModel).some(
            (t) => (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) > 0
          )
      )
    ) {
      const written = writeSessionTokens(
        dbModule,
        session.sessionId,
        combineSessionTokens(session)
      );
      if (written > 0) backfilled = true;
    }

    return backfilled ? { skipped: false, backfilled: true } : { skipped: true };
  }

  
  
  const RECENT_THRESHOLD_MS = 10 * 60 * 1000;
  const isRecentlyActive =
    session.fileModifiedAt && Date.now() - session.fileModifiedAt < RECENT_THRESHOLD_MS;
  const sessionStatus = isRecentlyActive ? "active" : "completed";
  const agentStatus = isRecentlyActive ? "waiting" : "completed";

  const metadata = JSON.stringify({
    version: session.version,
    slug: session.slug,
    git_branch: session.gitBranch,
    user_messages: session.userMessages,
    assistant_messages: session.assistantMessages,
    imported: true,
    entrypoint: session.entrypoint || null,
    permission_mode: session.permissionMode || null,
    thinking_blocks: session.thinkingBlockCount || 0,
    usage_extras: session.usageExtras || null,
    turn_count: session.turnDurations ? session.turnDurations.length : 0,
    total_turn_duration_ms: session.turnDurations
      ? session.turnDurations.reduce((s, t) => s + t.durationMs, 0)
      : 0,
  });

  stmts.insertSession.run(
    session.sessionId,
    session.name,
    sessionStatus,
    session.cwd,
    session.model,
    metadata
  );

  db.prepare("UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?").run(
    session.startedAt,
    isRecentlyActive ? null : session.endedAt,
    session.sessionId
  );

  
  
  if (session.transcriptPath) {
    stmts.setSessionTranscriptPath.run(session.transcriptPath, session.sessionId);
  }

  const mainAgentId = `${session.sessionId}-main`;
  const agentLabel = `Main Agent - ${session.name}`;
  stmts.insertAgent.run(
    mainAgentId,
    session.sessionId,
    agentLabel,
    "main",
    null,
    agentStatus,
    
    
    session.firstUserMessage || null,
    null,
    null
  );
  db.prepare("UPDATE agents SET started_at = ?, ended_at = ? WHERE id = ?").run(
    session.startedAt,
    isRecentlyActive ? null : session.endedAt,
    mainAgentId
  );

  for (const teamName of session.teams) {
    const subId = `${session.sessionId}-team-${teamName}`;
    stmts.insertAgent.run(
      subId,
      session.sessionId,
      teamName,
      "subagent",
      "team",
      "completed",
      null,
      mainAgentId,
      null
    );
    db.prepare("UPDATE agents SET started_at = ?, ended_at = ? WHERE id = ?").run(
      session.startedAt,
      session.endedAt,
      subId
    );
  }

  
  
  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const importedData = JSON.stringify({ imported: true });

  if (session.messageTimestamps && session.messageTimestamps.length > 0) {
    
    for (const ts of session.messageTimestamps) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        `${session.name} - response`,
        importedData,
        ts
      );
    }
  } else {
    
    insertEvent.run(
      session.sessionId,
      mainAgentId,
      "Stop",
      null,
      `Session: ${session.name} (${session.userMessages} user / ${session.assistantMessages} assistant msgs)`,
      importedData,
      session.startedAt
    );
    if (session.endedAt && session.endedAt !== session.startedAt) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        `Session ended: ${session.name}`,
        importedData,
        session.endedAt
      );
    }
  }

  
  if (session.toolUses && session.toolUses.length > 0) {
    for (const tu of session.toolUses) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "PostToolUse",
        tu.name,
        `${tu.name} (imported)`,
        importedData,
        tu.timestamp
      );
    }
  }

  
  importCompactions(dbModule, session.sessionId, mainAgentId, session.compactions);

  
  
  
  
  
  if (!(session.parsedSubagents && session.parsedSubagents.length > 0)) {
    importSubagents(dbModule, session.sessionId, mainAgentId, session.toolUses);
  }

  
  importApiErrors(dbModule, session.sessionId, mainAgentId, session.apiErrors);

  
  if (session.turnDurations && session.turnDurations.length > 0) {
    for (const td of session.turnDurations) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "TurnDuration",
        null,
        `Turn completed in ${(td.durationMs / 1000).toFixed(1)}s`,
        JSON.stringify({ durationMs: td.durationMs, imported: true }),
        td.timestamp || session.startedAt
      );
    }
  }

  
  if (session.toolResultErrors && session.toolResultErrors.length > 0) {
    for (const tre of session.toolResultErrors) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "ToolError",
        null,
        `Tool execution failed: ${tre.content.slice(0, 100)}`,
        JSON.stringify({ ...tre, imported: true }),
        tre.timestamp || session.startedAt
      );
    }
  }

  
  if (session.parsedSubagents && session.parsedSubagents.length > 0) {
    for (const subData of session.parsedSubagents) {
      importSubagentFromJsonl(dbModule, session.sessionId, mainAgentId, subData);
    }
    
    reconcileSubagentParents(dbModule, session.sessionId, mainAgentId, session.parsedSubagents);
  }

  writeSessionTokens(dbModule, session.sessionId, combineSessionTokens(session));

  return { skipped: false };
}

async function backfillCompactions(dbModule) {
  if (!fs.existsSync(PROJECTS_DIR)) return { backfilled: 0 };
  const { stmts } = dbModule;

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let backfilled = 0;

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    const files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const sessionId = path.basename(file, ".jsonl");
      const session = stmts.getSession.get(sessionId);
      if (!session) continue;

      const filePath = path.join(projPath, file);
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      const compactions = [];
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.isCompactSummary) {
            compactions.push({ uuid: entry.uuid || null, timestamp: entry.timestamp || null });
          }
        } catch {
          continue;
        }
      }

      if (compactions.length === 0) continue;
      const mainAgentId = `${sessionId}-main`;
      backfilled += importCompactions(dbModule, sessionId, mainAgentId, compactions);
    }
  }

  return { backfilled };
}

async function parseSessionForImport(projPath, sourcePath) {
  const session = await parseSessionFile(sourcePath);
  if (!session) return null;

  
  const subDir = path.join(projPath, session.sessionId, "subagents");
  if (fs.existsSync(subDir)) {
    const subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
    session.parsedSubagents = [];
    for (const sf of subFiles) {
      try {
        const subData = await parseSubagentFile(path.join(subDir, sf));
        if (subData) session.parsedSubagents.push(subData);
      } catch {
        
      }
    }
  }

  session._sourceJsonlPath = sourcePath;
  return session;
}

async function importAllSessions(dbModule) {
  if (!fs.existsSync(PROJECTS_DIR)) return { imported: 0, skipped: 0, errors: 0 };

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const importBatch = dbModule.db.transaction((sessions) => {
    for (const session of sessions) {
      const result = importSession(dbModule, session);
      if (result.skipped) skipped++;
      else imported++;
    }
  });

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    const files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) continue;

    const batch = [];
    for (const file of files) {
      try {
        const sourcePath = path.join(projPath, file);
        const session = await parseSessionForImport(projPath, sourcePath);
        if (!session) {
          skipped++;
          continue;
        }
        batch.push(session);
      } catch {
        errors++;
      }
    }

    if (batch.length > 0) {
      importBatch(batch);
      
      
      for (const session of batch) {
        snapshotTranscript(session._sourceJsonlPath, session.sessionId);
      }
    }
  }

  return { imported, skipped, errors };
}

async function syncDefaultProjects(dbModule, options = {}) {
  const mtimeCache = options.mtimeCache instanceof Map ? options.mtimeCache : new Map();
  const changed = [];
  if (!fs.existsSync(PROJECTS_DIR)) return { changed };

  let projectDirs;
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { changed };
  }

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    let files;
    try {
      files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sourcePath = path.join(projPath, file);
      let mtime;
      try {
        mtime = fs.statSync(sourcePath).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeCache.get(sourcePath) === mtime) continue; 

      try {
        const sessionId = path.basename(file, ".jsonl");
        const existingRow = dbModule.stmts.getSession.get(sessionId);
        
        
        
        
        
        
        
        
        
        if (existingRow) {
          const seenMs = Date.parse(existingRow.updated_at);
          if (Number.isFinite(seenMs) && mtime <= seenMs) {
            mtimeCache.set(sourcePath, mtime);
            continue;
          }
        }
        const existed = !!existingRow;
        const session = await parseSessionForImport(projPath, sourcePath);
        
        
        mtimeCache.set(sourcePath, mtime);
        if (!session) continue;

        const result = importSession(dbModule, session);
        snapshotTranscript(session._sourceJsonlPath, session.sessionId);
        
        
        if (!existed || !result.skipped) {
          changed.push({ sessionId: session.sessionId, isNew: !existed });
        }
        
        
        
        
        
        
        
        await new Promise((resolve) => setImmediate(resolve));
      } catch {
        
      }
    }
  }

  return { changed };
}

async function reconcileTokens(dbModule, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const counters = { reconciled: 0, sessionsTouched: 0, modelsWritten: 0, missingFiles: 0 };
  if (!fs.existsSync(PROJECTS_DIR)) return counters;

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  
  
  const sessionPaths = new Map();
  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    let files;
    try {
      files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const sid = path.basename(f, ".jsonl");
      sessionPaths.set(sid, path.join(projPath, f));
    }
  }

  const known = dbModule.db
    .prepare("SELECT id FROM sessions WHERE metadata LIKE '%\"imported\":true%'")
    .all();

  const total = known.length;
  let processed = 0;

  const tx = dbModule.db.transaction((batch) => {
    for (const { sessionId, tokens } of batch) {
      const written = writeSessionTokens(dbModule, sessionId, tokens);
      if (written > 0) {
        counters.sessionsTouched++;
        counters.modelsWritten += written;
      }
      counters.reconciled++;
    }
  });

  let batch = [];
  const FLUSH = 50;

  for (const { id: sessionId } of known) {
    processed++;
    const jsonlPath = sessionPaths.get(sessionId);
    if (!jsonlPath) {
      counters.missingFiles++;
      if (processed % 25 === 0) onProgress({ processed, total, counters });
      continue;
    }

    try {
      const session = await parseSessionFile(jsonlPath);
      if (!session) {
        if (processed % 25 === 0) onProgress({ processed, total, counters });
        continue;
      }

      
      const subPaths = findSessionSubagents(jsonlPath);
      if (subPaths.length > 0) {
        session.parsedSubagents = [];
        for (const sp of subPaths) {
          try {
            const subData = await parseSubagentFile(sp);
            if (subData) session.parsedSubagents.push(subData);
          } catch {
            
          }
        }
      }

      const tokens = combineSessionTokens(session);
      if (Object.keys(tokens).length > 0) {
        batch.push({ sessionId, tokens });
        if (batch.length >= FLUSH) {
          tx(batch);
          batch = [];
        }
      } else {
        counters.reconciled++;
      }
    } catch {
      
    }

    if (processed % 25 === 0) onProgress({ processed, total, counters });
  }
  if (batch.length > 0) tx(batch);

  onProgress({ processed, total, counters });
  return counters;
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  const reconcile = process.argv.includes("--reconcile-tokens");
  const projectIdx = process.argv.indexOf("--project");
  const projectFilter = projectIdx !== -1 ? process.argv[projectIdx + 1] : null;

  (async () => {
    console.log("Claude Code Session Importer");
    console.log("============================");
    if (dryRun) console.log("DRY RUN - no data will be written\n");
    if (reconcile)
      console.log("RECONCILE — refreshing token totals for already-imported sessions\n");
    if (projectFilter) console.log(`Filtering to project: ${projectFilter}\n`);

    if (!fs.existsSync(PROJECTS_DIR)) {
      console.error(`Projects directory not found: ${PROJECTS_DIR}`);
      process.exit(1);
    }

    if (reconcile) {
      const dbModule = require("../server/db");
      const before = dbModule.db
        .prepare(
          `SELECT
             COALESCE(SUM(input_tokens + baseline_input), 0) AS i,
             COALESCE(SUM(output_tokens + baseline_output), 0) AS o,
             COALESCE(SUM(cache_read_tokens + baseline_cache_read), 0) AS cr,
             COALESCE(SUM(cache_write_tokens + baseline_cache_write), 0) AS cw
           FROM token_usage`
        )
        .get();
      const result = await reconcileTokens(dbModule, {
        onProgress: ({ processed, total, counters }) => {
          process.stdout.write(
            `  reconciling ${processed}/${total} (touched: ${counters.sessionsTouched}, models: ${counters.modelsWritten})\r`
          );
        },
      });
      const after = dbModule.db
        .prepare(
          `SELECT
             COALESCE(SUM(input_tokens + baseline_input), 0) AS i,
             COALESCE(SUM(output_tokens + baseline_output), 0) AS o,
             COALESCE(SUM(cache_read_tokens + baseline_cache_read), 0) AS cr,
             COALESCE(SUM(cache_write_tokens + baseline_cache_write), 0) AS cw
           FROM token_usage`
        )
        .get();
      console.log(`\nReconciled ${result.reconciled} sessions.`);
      console.log(`Sessions whose tokens changed: ${result.sessionsTouched}`);
      console.log(`Token rows written: ${result.modelsWritten}`);
      if (result.missingFiles > 0) {
        console.log(`Sessions with no JSONL on disk (skipped): ${result.missingFiles}`);
      }
      const fmt = (n) => Number(n).toLocaleString();
      console.log("");
      console.log("Token totals (before → after):");
      console.log(
        `  input:       ${fmt(before.i)}  →  ${fmt(after.i)}  (Δ ${fmt(after.i - before.i)})`
      );
      console.log(
        `  output:      ${fmt(before.o)}  →  ${fmt(after.o)}  (Δ ${fmt(after.o - before.o)})`
      );
      console.log(
        `  cache_read:  ${fmt(before.cr)}  →  ${fmt(after.cr)}  (Δ ${fmt(after.cr - before.cr)})`
      );
      console.log(
        `  cache_write: ${fmt(before.cw)}  →  ${fmt(after.cw)}  (Δ ${fmt(after.cw - before.cw)})`
      );
      console.log("\nDone.");
      return;
    }

    if (dryRun) {
      const projectDirs = fs
        .readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      let total = 0;
      for (const projDir of projectDirs) {
        if (projectFilter && !projDir.includes(projectFilter)) continue;
        const projPath = path.join(PROJECTS_DIR, projDir);
        const files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
        if (files.length === 0) continue;

        const label = projDir.replace(/^C--/, "").replace(/-/g, "/");
        console.log(`\nProject: ${label} (${files.length} sessions)`);

        for (const file of files) {
          total++;
          try {
            const session = await parseSessionFile(path.join(projPath, file));
            if (!session) {
              console.log(`  SKIP ${file} (empty)`);
              continue;
            }
            const totalTok = Object.values(session.tokensByModel).reduce(
              (s, t) => s + t.input + t.output,
              0
            );
            console.log(
              `  ${session.sessionId.slice(0, 12)}... | ${session.name.slice(0, 40).padEnd(40)} | msgs: ${session.userMessages}/${session.assistantMessages} | teams: ${session.teams.length} | models: ${[...new Set(Object.values(session.tokensByModel).map((t) => t.model))].join(",")} | tokens: ${totalTok}`
            );
          } catch (err) {
            console.error(`  ERROR ${file}: ${err.message}`);
          }
        }
      }
      console.log(`\nTotal: ${total} session files`);
    } else {
      const dbModule = require("../server/db");
      const result = await importAllSessions(dbModule);
      console.log(`Imported: ${result.imported}`);
      console.log(`Skipped: ${result.skipped}`);
      if (result.errors > 0) console.log(`Errors: ${result.errors}`);
    }
    console.log("Done.");
  })().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

function findCompactionsInFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const compactions = [];
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.isCompactSummary) {
        compactions.push({ uuid: entry.uuid || null, timestamp: entry.timestamp || null });
      }
    } catch {
      continue;
    }
  }
  return compactions;
}

function collectJsonlFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  const seen = new Set();
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        out.push(full);
      } else if (ent.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) stack.push(full);
          else if (st.isFile() && full.endsWith(".jsonl")) out.push(full);
        } catch {
          
        }
      }
    }
  }
  return out;
}

function classifyJsonl(filePath) {
  
  
  
  
  
  
  
  const segments = path.dirname(filePath).split(path.sep);
  if (segments.includes("subagents")) return "subagent";
  return "session";
}

function findSessionSubagents(sessionJsonlPath) {
  const dir = path.dirname(sessionJsonlPath);
  const sessionId = path.basename(sessionJsonlPath, ".jsonl");
  const candidates = [
    path.join(dir, sessionId, "subagents"),
    path.join(dir, "subagents", sessionId),
  ];
  const result = [];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const files = fs.readdirSync(c).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) result.push(path.join(c, f));
    } catch {
      
    }
  }
  return result;
}

function findSessionWorkflowSubagents(sessionJsonlPath) {
  const dir = path.dirname(sessionJsonlPath);
  const sessionId = path.basename(sessionJsonlPath, ".jsonl");
  const subagentRoots = [
    path.join(dir, sessionId, "subagents"),
    path.join(dir, "subagents", sessionId),
  ];
  const result = [];
  for (const root of subagentRoots) {
    const workflowsDir = path.join(root, "workflows");
    try {
      if (!fs.existsSync(workflowsDir)) continue;
      for (const d of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const runDir = path.join(workflowsDir, d.name);
        for (const f of fs.readdirSync(runDir).filter((x) => x.endsWith(".jsonl"))) {
          result.push({
            abs: path.join(runDir, f),
            rel: path.join("workflows", d.name, f),
          });
        }
      }
    } catch {
      
    }
  }
  return result;
}

async function importFromDirectory(dbModule, rootDir, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const counters = {
    imported: 0,
    skipped: 0,
    backfilled: 0,
    errors: 0,
    sessionsSeen: 0,
    filesScanned: 0,
  };

  if (!fs.existsSync(rootDir)) return counters;
  const st = fs.statSync(rootDir);
  if (!st.isDirectory()) return counters;

  onProgress({ phase: "scan", processed: 0, total: 0, counters });
  const jsonlFiles = collectJsonlFiles(rootDir);
  counters.filesScanned = jsonlFiles.length;
  onProgress({ phase: "parse", processed: 0, total: jsonlFiles.length, counters });

  const sessionFiles = [];
  const standaloneSubagentFiles = [];
  for (const f of jsonlFiles) {
    if (classifyJsonl(f) === "subagent") standaloneSubagentFiles.push(f);
    else sessionFiles.push(f);
  }

  const parsedSessions = [];
  for (let i = 0; i < sessionFiles.length; i++) {
    const f = sessionFiles[i];
    try {
      const session = await parseSessionFile(f);
      if (!session) {
        counters.skipped++;
        onProgress({
          phase: "parse",
          processed: i + 1,
          total: sessionFiles.length,
          current: f,
          counters,
        });
        continue;
      }

      
      const subPaths = findSessionSubagents(f);
      if (subPaths.length > 0) {
        session.parsedSubagents = [];
        for (const sp of subPaths) {
          try {
            const subData = await parseSubagentFile(sp);
            if (subData) session.parsedSubagents.push(subData);
          } catch {
            
          }
        }
      }

      
      
      
      session._sourceJsonlPath = f;
      parsedSessions.push(session);
      counters.sessionsSeen++;
    } catch {
      counters.errors++;
    }
    if ((i + 1) % 5 === 0 || i === sessionFiles.length - 1) {
      onProgress({
        phase: "parse",
        processed: i + 1,
        total: sessionFiles.length,
        current: f,
        counters,
      });
    }
  }

  if (parsedSessions.length > 0) {
    const importBatch = dbModule.db.transaction((sessions) => {
      for (const session of sessions) {
        try {
          const result = importSession(dbModule, session);
          if (result.skipped && !result.backfilled) counters.skipped++;
          else if (result.backfilled) counters.backfilled++;
          else counters.imported++;
        } catch {
          counters.errors++;
        }
      }
    });
    importBatch(parsedSessions);

    
    
    
    for (const session of parsedSessions) {
      if (session._sourceJsonlPath) {
        snapshotTranscript(session._sourceJsonlPath, session.sessionId);
      }
    }
  }

  
  
  
  
  
  
  
  if (standaloneSubagentFiles.length > 0) {
    for (const sf of standaloneSubagentFiles) {
      try {
        const subData = await parseSubagentFile(sf);
        if (!subData) continue;
        const parts = sf.split(path.sep);
        const idx = parts.lastIndexOf("subagents");
        if (idx < 0) continue;
        const candidates = [];
        if (idx - 1 >= 0) candidates.push(parts[idx - 1]);
        if (idx + 1 < parts.length) candidates.push(parts[idx + 1]);
        let sessionId = null;
        for (const c of candidates) {
          if (!c) continue;
          if (dbModule.stmts.getSession.get(c)) {
            sessionId = c;
            break;
          }
        }
        if (!sessionId) continue;
        const mainAgentId = `${sessionId}-main`;
        if (importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subData) > 0) {
          counters.backfilled++;
        }
      } catch {
        counters.errors++;
      }
    }
  }

  onProgress({
    phase: "complete",
    processed: sessionFiles.length,
    total: sessionFiles.length,
    counters,
  });
  return counters;
}

async function scanAndImportSubagents(dbModule, sessionId, transcriptPath, opts = {}) {
  if (!sessionId || !transcriptPath) return { imported: 0, created: 0 };
  const subDir = path.join(path.dirname(transcriptPath), sessionId, "subagents");
  try {
    await fs.promises.access(subDir);
  } catch {
    return { imported: 0, created: 0 };
  }

  const subFiles = (await fs.promises.readdir(subDir)).filter((f) => f.endsWith(".jsonl"));
  if (subFiles.length === 0) return { imported: 0, created: 0 };

  const { db } = dbModule;
  const mainAgentId = `${sessionId}-main`;
  let created = 0;
  const parsedSubagents = [];
  for (const sf of subFiles) {
    try {
      const subData = await parseSubagentFile(path.join(subDir, sf));
      if (!subData) continue;
      parsedSubagents.push(subData);
      created += importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subData);
    } catch {
      
    }
  }

  
  
  
  let reparented = 0;
  try {
    reparented = reconcileSubagentParents(dbModule, sessionId, mainAgentId, parsedSubagents);
  } catch {
    
  }

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (parsedSubagents.length > 0) {
    try {
      const parentModels = new Set();
      const sessionRow = db.prepare("SELECT model FROM sessions WHERE id = ?").get(sessionId);
      if (sessionRow && sessionRow.model) parentModels.add(sessionRow.model);
      if (Array.isArray(opts.parentModels)) {
        for (const m of opts.parentModels) if (m) parentModels.add(m);
      }
      const combined = combineSessionTokens({ tokensByModel: null, parsedSubagents });
      const subOnly = {};
      for (const [key, tok] of Object.entries(combined)) {
        
        
        
        
        
        
        
        if (tok.model && !parentModels.has(tok.model)) subOnly[key] = tok;
      }
      writeSessionTokens(dbModule, sessionId, subOnly);
    } catch {
      
    }
  }

  return { imported: subFiles.length, created, reparented };
}

async function backfillSubagentTokenMetadata(dbModule) {
  const { db } = dbModule;
  let sessions;
  try {
    
    
    
    
    sessions = db
      .prepare(
        `SELECT DISTINCT s.id AS session_id, s.transcript_path AS tp,
                s.metadata AS meta
         FROM agents a JOIN sessions s ON s.id = a.session_id
         WHERE a.type = 'subagent'
           AND (a.subagent_type IS NULL OR a.subagent_type != 'compaction')
           AND (a.metadata IS NULL OR a.metadata NOT LIKE '%"tokens":%')`
      )
      .all();
  } catch {
    return { sessions: 0, stamped: 0 };
  }
  let stamped = 0;
  let scanned = 0;
  for (const s of sessions) {
    
    
    
    
    let transcriptPath = s.tp && fs.existsSync(s.tp) ? s.tp : null;
    if (!transcriptPath) {
      let slug = null;
      try {
        slug = s.meta ? JSON.parse(s.meta).slug : null;
      } catch {
        slug = null;
      }
      if (slug) {
        const candidate = path.join(PROJECTS_DIR, slug, `${s.session_id}.jsonl`);
        
        
        
        if (fs.existsSync(path.dirname(candidate))) transcriptPath = candidate;
      }
    }
    if (!transcriptPath) continue; 
    let subFiles;
    try {
      subFiles = findSessionSubagents(transcriptPath);
    } catch {
      continue;
    }
    if (!subFiles || subFiles.length === 0) continue;
    scanned++;
    const mainAgentId = `${s.session_id}-main`;
    for (const file of subFiles) {
      try {
        const subData = await parseSubagentFile(file);
        if (!subData) continue;
        importSubagentFromJsonl(dbModule, s.session_id, mainAgentId, subData);
        stamped++;
      } catch {
        
      }
    }
  }
  return { sessions: scanned, stamped };
}

module.exports = {
  importAllSessions,
  syncDefaultProjects,
  importFromDirectory,
  backfillCompactions,
  importCompactions,
  importSubagents,
  importApiErrors,
  importSubagentFromJsonl,
  backfillSubagentTokenMetadata,
  reconcileSubagentParents,
  parseSessionFile,
  parseSubagentFile,
  findCompactionsInFile,
  collectJsonlFiles,
  classifyJsonl,
  findSessionSubagents,
  findSessionWorkflowSubagents,
  snapshotTranscript,
  importSession,
  scanAndImportSubagents,
  combineSessionTokens,
  writeSessionTokens,
  reconcileTokens,
};
