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

const { getProjectsDir } = require("../server/lib/claude-home");
const { extractFirstUserText } = require("../server/lib/transcript-cache");
const PROJECTS_DIR = getProjectsDir();

function firstUserLabel(text) {
  const trimmedText = typeof text === "string" ? text.trim() : "";
  if (!trimmedText) return null;
  return trimmedText.length > 60 ? trimmedText.slice(0, 57) + "..." : trimmedText;
}

async function parseSessionFile(filePath) {
  const sessionId = path.basename(filePath, ".jsonl");

  const lineReader = readline.createInterface({
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
  const assistantMessageTimestamps = [];
  const assistantToolUses = [];
  const turnDurationRecords = [];
  let entrypoint = null;
  let permissionMode = null;
  let thinkingBlockCount = 0;
  const toolResultErrors = [];
  const toolResultById = new Map();
  const usageMetadata = { service_tiers: new Set(), speeds: new Set(), inference_geos: new Set() };
  
  
  
  let customTitle = null;
  let aiTitle = null;
  
  
  let firstUserMessage = null;

  for await (const line of lineReader) {
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

    
    if (entry.type === "system" && entry.subtype === "turn_duration" && entry.durationMs) {
      const turnTimestamp = entry.timestamp
        ? typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString()
          : entry.timestamp
        : null;
      turnDurationRecords.push({ durationMs: entry.durationMs, timestamp: turnTimestamp });
    }

    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!slug && entry.slug) slug = entry.slug;
    if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
    if (!version && entry.version) version = entry.version;
    if (!entrypoint && entry.entrypoint) entrypoint = entry.entrypoint;
    if (!permissionMode && entry.permissionMode) permissionMode = entry.permissionMode;

    const ts = entry.timestamp;
    if (ts) {
      const isoTimestamp = typeof ts === "number" ? new Date(ts).toISOString() : ts;
      if (!firstTimestamp || isoTimestamp < firstTimestamp) firstTimestamp = isoTimestamp;
      if (!lastTimestamp || isoTimestamp > lastTimestamp) lastTimestamp = isoTimestamp;
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
      const messageContent = entry.message?.content;
      if (Array.isArray(messageContent)) {
        const resultTs = ts ? (typeof ts === "number" ? new Date(ts).toISOString() : ts) : null;
        for (const block of messageContent) {
          if (block && block.type === "tool_result" && block.tool_use_id) {
            toolResultById.set(block.tool_use_id, {
              content: block.content,
              is_error: !!block.is_error,
              timestamp: resultTs,
            });
          }
        }
      }
    }
    if (entry.type === "assistant") {
      assistantMessageCount++;
      const isoTimestamp = ts ? (typeof ts === "number" ? new Date(ts).toISOString() : ts) : null;
      if (isoTimestamp) assistantMessageTimestamps.push(isoTimestamp);
      const message = entry.message || {};
      const messageModel = message.model || null;
      if (!model && messageModel && messageModel !== "<synthetic>") model = messageModel;
      if (messageModel && messageModel !== "<synthetic>" && message.usage) {
        const usage = message.usage;
        const key = bucketKey(
          messageModel,
          normalizeSpeed(usage),
          normalizeGeo(usage),
          normalizeTier(usage)
        );
        if (tokensByModel[key] === undefined) {
          tokensByModel[key] = emptyBucket(
            messageModel,
            normalizeSpeed(usage),
            normalizeGeo(usage),
            normalizeTier(usage)
          );
        }
        accumulateBucket(tokensByModel[key], extractUsageFields(usage));
      }
      if (message.usage) {
        if (message.usage.service_tier) usageMetadata.service_tiers.add(message.usage.service_tier);
        if (message.usage.speed) usageMetadata.speeds.add(message.usage.speed);
        if (message.usage.inference_geo && message.usage.inference_geo !== "not_available")
          usageMetadata.inference_geos.add(message.usage.inference_geo);
      }
      
      const content = message.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            assistantToolUses.push({
              id: block.id || null,
              name: block.name,
              timestamp: isoTimestamp || firstTimestamp,
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
    assistantMessageTimestamps,
    assistantToolUses,
    toolResultById,
    fileModifiedAt,
    turnDurationRecords,
    entrypoint,
    permissionMode,
    thinkingBlockCount,
    toolResultErrors,
    usageMetadata: {
      service_tiers: [...usageMetadata.service_tiers],
      speeds: [...usageMetadata.speeds],
      inference_geos: [...usageMetadata.inference_geos],
    },
  };
}

async function parseSubagentFile(filePath) {
  const agentId = path.basename(filePath, ".jsonl").replace(/^agent-/, "");

  const lineReader = readline.createInterface({
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
  
  
  
  const subagentToolCalls = []; 
  const toolResultById = new Map(); 
  
  
  
  
  
  const spawnedChildAgentIds = new Set();

  for await (const line of lineReader) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.toolUseResult && entry.toolUseResult.agentId) {
      spawnedChildAgentIds.add(entry.toolUseResult.agentId);
    }

    const ts = entry.timestamp;
    let isoTimestamp = null;
    if (ts) {
      isoTimestamp = typeof ts === "number" ? new Date(ts).toISOString() : ts;
      if (!firstTimestamp || isoTimestamp < firstTimestamp) firstTimestamp = isoTimestamp;
      if (!lastTimestamp || isoTimestamp > lastTimestamp) lastTimestamp = isoTimestamp;
    }

    if (entry.type === "user") {
      userMessageCount++;
      const messageContent = entry.message?.content;
      if (!task) {
        if (typeof messageContent === "string") {
          task = messageContent.slice(0, 500);
        } else if (Array.isArray(messageContent)) {
          const textBlock = messageContent.find((tokenBucket) => tokenBucket && tokenBucket.type === "text");
          if (textBlock) task = (textBlock.text || "").slice(0, 500);
        }
      }
      if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (block && block.type === "tool_result" && block.tool_use_id) {
            toolResultById.set(block.tool_use_id, {
              content: block.content,
              is_error: !!block.is_error,
              timestamp: isoTimestamp,
            });
          }
        }
      }
    }

    if (entry.type === "assistant") {
      assistantMessageCount++;
      const message = entry.message || {};
      const messageModel = message.model || null;
      if (!model && messageModel && messageModel !== "<synthetic>") model = messageModel;
      if (messageModel && messageModel !== "<synthetic>" && message.usage) {
        const usage = message.usage;
        const key = bucketKey(
          messageModel,
          normalizeSpeed(usage),
          normalizeGeo(usage),
          normalizeTier(usage)
        );
        if (!tokensByModel[key]) {
          tokensByModel[key] = emptyBucket(
            messageModel,
            normalizeSpeed(usage),
            normalizeGeo(usage),
            normalizeTier(usage)
          );
        }
        accumulateBucket(tokensByModel[key], extractUsageFields(usage));
      }
      const content = message.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            toolNames.add(block.name);
            if (block.id) {
              subagentToolCalls.push({
                id: block.id,
                name: block.name,
                input: block.input || null,
                timestamp: isoTimestamp,
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

  
  const normalizedToolEvents = subagentToolCalls.map((call) => {
    const result = toolResultById.get(call.id) || null;
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

  
  const metaPath = filePath.replace(/\.jsonl$/, ".existingMetadata.json");
  try {
    if (fs.existsSync(metaPath)) {
      const existingMetadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (existingMetadata.agentType) agentType = existingMetadata.agentType;
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
    normalizedToolEvents,
    spawnedChildAgentIds: [...spawnedChildAgentIds],
  };
}

function importSubagents(dbModule, sessionId, mainAgentId, assistantToolUses) {
  if (!assistantToolUses || assistantToolUses.length === 0) return 0;
  const { stmts } = dbModule;
  const insertEvent = dbModule.db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  let created = 0;
  let agentIndex = 0;

  for (const toolUse of assistantToolUses) {
    if (toolUse.name !== "Agent" || !toolUse.input) continue;
    const input = toolUse.input;
    agentIndex++;

    const subagentId = `${sessionId}-subagent-${agentIndex}`;
    if (stmts.getAgent.get(subagentId)) continue;

    const rawSubagentName =
      input.description ||
      input.subagent_type ||
      (input.prompt ? input.prompt.split("\n")[0].slice(0, 60) : null) ||
      "Subagent";
    const subagentName = rawSubagentName.length > 60 ? rawSubagentName.slice(0, 57) + "..." : rawSubagentName;
    const timestamp = toolUse.timestamp || new Date().toISOString();

    stmts.insertAgent.run(
      subagentId,
      sessionId,
      subagentName,
      "subagent",
      input.subagent_type || null,
      "completed",
      input.prompt ? input.prompt.slice(0, 500) : null,
      mainAgentId,
      null
    );
    dbModule.db
      .prepare("UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, timestamp, subagentId);

    insertEvent.run(
      sessionId,
      subagentId,
      "PreToolUse",
      "Agent",
      null,
      timestamp
    );
    created++;
  }
  return created;
}

const SUBAGENT_LIVE_MATCH_TOLERANCE_MS = 30_000;
function findLiveSubagentForJsonl(dbModule, sessionId, subagentData) {
  if (!subagentData.agentType || !subagentData.startedAt) return null;
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
      subagentData.agentType,
      `${sessionId}-jsonl-%`,
      subagentData.startedAt,
      SUBAGENT_LIVE_MATCH_TOLERANCE_MS / 1000,
      subagentData.startedAt
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
    for (const subagent of session.parsedSubagents) merge(subagent.tokensByModel);
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
      (tokens.cacheWrite || 0) > 0
    ) {
      stmts.replaceTokenUsage.run(
        sessionId,
        tokens.model,
        tokens.input || 0,
        tokens.output || 0,
        tokens.cacheRead || 0,
        tokens.cacheWrite || 0
      );
      written++;
    }
  }
  return written;
}

function subagentTokenRows(tokensByModel) {
  const rows = [];
  for (const tokenBucket of Object.values(tokensByModel || {})) {
    if (!tokenBucket || !tokenBucket.model) continue;
    const row = {
      model: tokenBucket.model,
      speed: tokenBucket.speed,
      inference_geo: tokenBucket.geo,
      service_tier: tokenBucket.tier,
      input_tokens: tokenBucket.input || 0,
      output_tokens: tokenBucket.output || 0,
      cache_read_tokens: tokenBucket.cacheRead || 0,
      cache_write_tokens: tokenBucket.cacheWrite || 0,
      cache_write_1h_tokens: tokenBucket.cacheWrite1h || 0,
    };
    const hasUsage =
      row.input_tokens ||
      row.output_tokens ||
      row.cache_read_tokens ||
      row.cache_write_tokens;
    if (hasUsage) rows.push(row);
  }
  return rows;
}

function importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subagentData) {
  if (!subagentData) return 0;
  const { db, stmts } = dbModule;

  const jsonlDerivedSubagentId = `${sessionId}-jsonl-${subagentData.agentId}`;
  const liveSubagentMatch = findLiveSubagentForJsonl(dbModule, sessionId, subagentData);
  const targetAgentId = liveSubagentMatch ? liveSubagentMatch.id : jsonlDerivedSubagentId;
  const existingJsonlAgent = stmts.getAgent.get(jsonlDerivedSubagentId);

  const subName = subagentData.agentType ? subagentData.agentType : `Subagent ${subagentData.agentId.slice(0, 8)}`;
  
  
  const tokenRows = subagentTokenRows(subagentData.tokensByModel);
  let created = 0;
  let updated = 0;

  
  
  
  
  if (!liveSubagentMatch && !existingJsonlAgent) {
    stmts.insertAgent.run(
      jsonlDerivedSubagentId,
      sessionId,
      subName,
      "subagent",
      subagentData.agentType || null,
      "completed",
      subagentData.task,
      mainAgentId,
      JSON.stringify({
        imported: true,
        source: "jsonl",
        model: subagentData.model,
        tools: subagentData.toolNames,
        user_messages: subagentData.userMessages,
        assistant_messages: subagentData.assistantMessages,
        thinking_blocks: subagentData.thinkingBlockCount,
        tokens: tokenRows,
      })
    );
    db.prepare("UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(
      subagentData.startedAt,
      subagentData.endedAt,
      subagentData.endedAt,
      jsonlDerivedSubagentId
    );
    created++;
  }

  
  
  
  
  
  
  
  
  
  
  {
    const row = stmts.getAgent.get(targetAgentId);
    if (row) {
      let existingMetadata = {};
      try {
        existingMetadata = row.metadata ? JSON.parse(row.metadata) : {};
      } catch {
        existingMetadata = {};
      }
      let changed = false;
      if (subagentData.model && !existingMetadata.model) {
        existingMetadata.model = subagentData.model;
        changed = true;
      }
      
      
      
      
      
      if (subagentData.toolNames && subagentData.toolNames.length > 0 && !existingMetadata.tools) {
        existingMetadata.tools = subagentData.toolNames;
        changed = true;
      }
      if (existingMetadata.user_messages == null && subagentData.userMessages != null) {
        existingMetadata.user_messages = subagentData.userMessages;
        changed = true;
      }
      if (existingMetadata.assistant_messages == null && subagentData.assistantMessages != null) {
        existingMetadata.assistant_messages = subagentData.assistantMessages;
        changed = true;
      }
      if (existingMetadata.thinking_blocks == null && subagentData.thinkingBlockCount != null) {
        existingMetadata.thinking_blocks = subagentData.thinkingBlockCount;
        changed = true;
      }
      
      
      
      
      const hasTokensKey = Object.prototype.hasOwnProperty.call(existingMetadata, "tokens");
      const tokensChanged =
        tokenRows.length > 0 && JSON.stringify(existingMetadata.tokens || []) !== JSON.stringify(tokenRows);
      if (tokensChanged || !hasTokensKey) {
        existingMetadata.tokens = tokenRows;
        changed = true;
      }
      if (changed) {
        db.prepare("UPDATE agents SET metadata = ? WHERE id = ?").run(
          JSON.stringify(existingMetadata),
          targetAgentId
        );
        updated++;
      }
    }
  }

  
  
  
  

  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  
  
  if (!liveSubagentMatch) {
    const spawnExists = db
      .prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND agent_id = ? AND event_type = 'PreToolUse' AND tool_name = 'Agent' AND tool_use_id = ? LIMIT 1"
      )
      .get(sessionId, mainAgentId, targetAgentId);
    if (!spawnExists) {
      insertEvent.run(
        sessionId,
        mainAgentId,
        "PreToolUse",
        "Agent",
        targetAgentId,
        subagentData.startedAt
      );
      created++;
    }
  }

  
  
  if (Array.isArray(subagentData.normalizedToolEvents) && subagentData.normalizedToolEvents.length > 0) {
    const eventExists = db.prepare(
      "SELECT 1 FROM events WHERE agent_id = ? AND event_type = ? AND tool_use_id = ? LIMIT 1"
    );
    for (const toolEvent of subagentData.normalizedToolEvents) {
      if (!toolEvent.tool_use_id) continue;
      const timestamp = toolEvent.pre_timestamp || subagentData.startedAt;

      if (!eventExists.get(targetAgentId, "PreToolUse", toolEvent.tool_use_id)) {
        insertEvent.run(
          sessionId,
          targetAgentId,
          "PreToolUse",
          toolEvent.tool_name,
          toolEvent.tool_use_id,
          timestamp
        );
        created++;
      }

      if (toolEvent.post_timestamp && !eventExists.get(targetAgentId, toolEvent.is_error ? "PostToolUseFailure" : "PostToolUse", toolEvent.tool_use_id)) {
        insertEvent.run(
          sessionId,
          targetAgentId,
          toolEvent.is_error ? "PostToolUseFailure" : "PostToolUse",
          toolEvent.tool_name,
          toolEvent.tool_use_id,
          toolEvent.post_timestamp
        );
        created++;
      }
    }
  }

  return { created, updated };
}

function resolveSubagentDbId(dbModule, sessionId, subagentData) {
  const liveSubagentRow = findLiveSubagentForJsonl(dbModule, sessionId, subagentData);
  return liveSubagentRow ? liveSubagentRow.id : `${sessionId}-jsonl-${subagentData.agentId}`;
}

function reconcileSubagentParents(dbModule, sessionId, mainAgentId, parsedSubagents) {
  if (!Array.isArray(parsedSubagents) || parsedSubagents.length < 2) return 0;
  const { stmts } = dbModule;

  const subagentById = new Map();
  for (const subagent of parsedSubagents) if (subagent && subagent.agentId) subagentById.set(subagent.agentId, subagent);

  
  
  const childToParentMap = new Map();
  for (const subagent of parsedSubagents) {
    if (!subagent || !Array.isArray(subagent.spawnedChildAgentIds)) continue;
    for (const childId of subagent.spawnedChildAgentIds) {
      if (childId && childId !== subagent.agentId && subagentById.has(childId)) {
        childToParentMap.set(childId, subagent.agentId);
      }
    }
  }
  if (childToParentMap.size === 0) return 0;

  let updated = 0;
  for (const subagent of parsedSubagents) {
    const parentAgentId = childToParentMap.get(subagent.agentId);
    if (!parentAgentId) continue; 
    const parentData = subagentById.get(parentAgentId);
    if (!parentData) continue;

    const childDbId = resolveSubagentDbId(dbModule, sessionId, subagent);
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
    const existingMetadata = existing.metadata ? JSON.parse(existing.metadata) : {};
    if (!existingMetadata.imported) return { skipped: true };

    const mainAgentId = `${session.sessionId}-main`;
    const insertEvent = db.prepare(
      "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    let wasModified = false;

    
    
    
    
    
    
    
    
    const latestEventByTypeRows = db
      .prepare(
        "SELECT event_type, MAX(created_at) AS m FROM events WHERE session_id = ? GROUP BY event_type"
      )
      .all(session.sessionId);
    const latestEventTimeByType = Object.create(null);
    for (const result of latestEventByTypeRows) latestEventTimeByType[result.event_type] = result.m;
    const isTimestampNewerThanLatest = (type, timestamp) => {
      if (!timestamp) return false;
      const candidate = latestEventTimeByType[type];
      return !candidate || timestamp > candidate;
    };

    
    if (session.assistantMessageTimestamps && session.assistantMessageTimestamps.length > 0) {
      let added = 0;
      for (const timestamp of session.assistantMessageTimestamps) {
        if (!isTimestampNewerThanLatest("Stop", timestamp)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "Stop",
          null,
          null,
          timestamp
        );
        added++;
      }
      if (added > 0) wasModified = true;
    } else if (!latestEventTimeByType.Stop) {
      
      
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        null,
        session.startedAt
      );
      wasModified = true;
    }

    
    if (session.assistantToolUses && session.assistantToolUses.length > 0) {
      const toolExists = db.prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND agent_id = ? AND event_type = ? AND tool_use_id = ? LIMIT 1"
      );
      let added = 0;
      for (const toolUse of session.assistantToolUses) {
        if (!toolUse.id || !toolUse.timestamp) continue;
        const result = session.toolResultById && session.toolResultById.get(toolUse.id);
        const postType = result && result.is_error ? "PostToolUseFailure" : "PostToolUse";

        if (!toolExists.get(session.sessionId, mainAgentId, "PreToolUse", toolUse.id)) {
          insertEvent.run(
            session.sessionId,
            mainAgentId,
            "PreToolUse",
            toolUse.name,
            toolUse.id,
            toolUse.timestamp
          );
          added++;
        }

        if (!toolExists.get(session.sessionId, mainAgentId, postType, toolUse.id)) {
          insertEvent.run(
            session.sessionId,
            mainAgentId,
            postType,
            toolUse.name,
            toolUse.id,
            result && result.timestamp ? result.timestamp : toolUse.timestamp
          );
          added++;
        }
      }
      if (added > 0) wasModified = true;
    }

    
    if (session.transcriptPath) {
      stmts.setSessionTranscriptPath.run(session.transcriptPath, session.sessionId);
    }

    
    
    
    
    
    
    
    
    const hasParsedSubs = session.parsedSubagents && session.parsedSubagents.length > 0;
    if (!hasParsedSubs) {
      const subagentCount = importSubagents(
        dbModule,
        session.sessionId,
        mainAgentId,
        session.assistantToolUses
      );
      if (subagentCount > 0) wasModified = true;
    }

    
    if (session.parsedSubagents && session.parsedSubagents.length > 0) {
      for (const subagentData of session.parsedSubagents) {
        const result = importSubagentFromJsonl(dbModule, session.sessionId, mainAgentId, subagentData);
        if (result.created > 0 || result.updated > 0) wasModified = true;
      }
      
      if (
        reconcileSubagentParents(
          dbModule,
          session.sessionId,
          mainAgentId,
          session.parsedSubagents
        ) > 0
      )
        wasModified = true;
    }

    
    
    if (session.toolResultErrors && session.toolResultErrors.length > 0) {
      let added = 0;
      for (const toolResultError of session.toolResultErrors) {
        const timestamp = toolResultError.timestamp || session.startedAt;
        if (!isTimestampNewerThanLatest("ToolError", timestamp)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "ToolError",
          null,
          null,
          timestamp
        );
        added++;
      }
      if (added > 0) wasModified = true;
    }

    
    
    
    
    const metaChanged =
      existingMetadata.user_messages !== session.userMessages ||
      existingMetadata.assistant_messages !== session.assistantMessages ||
      (!existingMetadata.entrypoint && (session.entrypoint || session.turnDurationRecords?.length > 0)) ||
      
      
      
      (session.turnDurationRecords && (existingMetadata.turn_count || 0) !== session.turnDurationRecords.length) ||
      (session.thinkingBlockCount || 0) > (existingMetadata.thinking_blocks || 0);
    if (metaChanged) {
      existingMetadata.user_messages = session.userMessages;
      existingMetadata.assistant_messages = session.assistantMessages;
      existingMetadata.entrypoint = existingMetadata.entrypoint || session.entrypoint || null;
      existingMetadata.permission_mode = existingMetadata.permission_mode || session.permissionMode || null;
      existingMetadata.thinking_blocks = Math.max(existingMetadata.thinking_blocks || 0, session.thinkingBlockCount || 0);
      existingMetadata.usage_extras = session.usageMetadata || existingMetadata.usage_extras || null;
      existingMetadata.turn_count = session.turnDurationRecords ? session.turnDurationRecords.length : existingMetadata.turn_count || 0;
      existingMetadata.total_turn_duration_ms = session.turnDurationRecords
        ? session.turnDurationRecords.reduce((sum, durationRecord) => sum + durationRecord.durationMs, 0)
        : existingMetadata.total_turn_duration_ms || 0;
      stmts.updateSession.run(null, null, null, JSON.stringify(existingMetadata), session.sessionId);
      wasModified = true;
    }

    
    
    
    
    
    
    
    const firstUserMessagePreview = firstUserLabel(session.firstUserMessage);
    const transcriptTitle = session.customTitle || session.aiTitle || firstUserMessagePreview || null;
    if (transcriptTitle) {
      const base = session.cwd ? path.basename(session.cwd) : null;
      const storedSessionName = existing.name || "";
      const isAutoGeneratedName =
        !storedSessionName.trim() ||
        storedSessionName === `Session ${session.sessionId.slice(0, 8)}` ||
        (firstUserMessagePreview !== null && storedSessionName === firstUserMessagePreview) ||
        (base &&
          (storedSessionName === base || storedSessionName.startsWith(`${base} - `) || storedSessionName.startsWith(`${base} (`)));
      if (isAutoGeneratedName && storedSessionName !== transcriptTitle) {
        stmts.updateSession.run(transcriptTitle, null, null, null, session.sessionId);
        wasModified = true;
      }
    }

    
    
    
    
    
    if (firstUserMessagePreview) {
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
        const desiredAgentName = `Main Agent - ${firstUserMessagePreview}`;
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
          wasModified = true;
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
      wasModified = true;
    }

    
    
    
    
    if (
      session.parsedSubagents &&
      session.parsedSubagents.some(
        (subagent) =>
          subagent.tokensByModel &&
          Object.values(subagent.tokensByModel).some(
            (tokenBucket) => (tokenBucket.input || 0) + (tokenBucket.output || 0) + (tokenBucket.cacheRead || 0) + (tokenBucket.cacheWrite || 0) > 0
          )
      )
    ) {
      const written = writeSessionTokens(
        dbModule,
        session.sessionId,
        combineSessionTokens(session)
      );
      if (written > 0) wasModified = true;
    }

    return wasModified ? { skipped: false, wasModified: true } : { skipped: true };
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
    usage_extras: session.usageMetadata || null,
    turn_count: session.turnDurationRecords ? session.turnDurationRecords.length : 0,
    total_turn_duration_ms: session.turnDurationRecords
      ? session.turnDurationRecords.reduce((sum, durationRecord) => sum + durationRecord.durationMs, 0)
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
    const teamAgentId = `${session.sessionId}-team-${teamName}`;
    stmts.insertAgent.run(
      teamAgentId,
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
      teamAgentId
    );
  }

  
  
  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  if (session.assistantMessageTimestamps && session.assistantMessageTimestamps.length > 0) {
    for (const timestamp of session.assistantMessageTimestamps) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        null,
        timestamp
      );
    }
  } else {
    insertEvent.run(
      session.sessionId,
      mainAgentId,
      "Stop",
      null,
      null,
      session.startedAt
    );
    if (session.endedAt && session.endedAt !== session.startedAt) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        null,
        session.endedAt
      );
    }
  }

  if (session.assistantToolUses && session.assistantToolUses.length > 0) {
    for (const toolUse of session.assistantToolUses) {
      if (!toolUse.id || !toolUse.timestamp) continue;
      const result = session.toolResultById && session.toolResultById.get(toolUse.id);
      const postType = result && result.is_error ? "PostToolUseFailure" : "PostToolUse";
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "PreToolUse",
        toolUse.name,
        toolUse.id,
        toolUse.timestamp
      );
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        postType,
        toolUse.name,
        toolUse.id,
        result && result.timestamp ? result.timestamp : toolUse.timestamp
      );
    }
  }

  if (!(session.parsedSubagents && session.parsedSubagents.length > 0)) {
    importSubagents(dbModule, session.sessionId, mainAgentId, session.assistantToolUses);
  }

  if (session.toolResultErrors && session.toolResultErrors.length > 0) {
    for (const toolResultError of session.toolResultErrors) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "ToolError",
        null,
        null,
        toolResultError.timestamp || session.startedAt
      );
    }
  }

  
  if (session.parsedSubagents && session.parsedSubagents.length > 0) {
    for (const subagentData of session.parsedSubagents) {
      importSubagentFromJsonl(dbModule, session.sessionId, mainAgentId, subagentData);
    }
    
    reconcileSubagentParents(dbModule, session.sessionId, mainAgentId, session.parsedSubagents);
  }

  writeSessionTokens(dbModule, session.sessionId, combineSessionTokens(session));

  return { skipped: false };
}

async function parseSessionForImport(projectPath, sourcePath) {
  const session = await parseSessionFile(sourcePath);
  if (!session) return null;

  
  const subDir = path.join(projectPath, session.sessionId, "subagents");
  if (fs.existsSync(subDir)) {
    const subFiles = fs.readdirSync(subDir).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    session.parsedSubagents = [];
    for (const subagentFile of subFiles) {
      try {
        const subagentData = await parseSubagentFile(path.join(subDir, subagentFile));
        if (subagentData) session.parsedSubagents.push(subagentData);
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
    .filter((directoryEntry) => directoryEntry.isDirectory())
    .map((directoryEntry) => directoryEntry.name);

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

  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    const files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    if (files.length === 0) continue;

    const tokenUpdateBatch = [];
    for (const file of files) {
      try {
        const sourcePath = path.join(projectPath, file);
        const session = await parseSessionForImport(projectPath, sourcePath);
        if (!session) {
          skipped++;
          continue;
        }
        tokenUpdateBatch.push(session);
      } catch {
        errors++;
      }
    }

    if (tokenUpdateBatch.length > 0) {
      importBatch(tokenUpdateBatch);
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
      .filter((directoryEntry) => directoryEntry.isDirectory())
      .map((directoryEntry) => directoryEntry.name);
  } catch {
    return { changed };
  }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sourcePath = path.join(projectPath, file);
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
        const session = await parseSessionForImport(projectPath, sourcePath);
        
        
        mtimeCache.set(sourcePath, mtime);
        if (!session) continue;

        const result = importSession(dbModule, session);
        
        
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
    .filter((directoryEntry) => directoryEntry.isDirectory())
    .map((directoryEntry) => directoryEntry.name);

  
  
  const sessionPaths = new Map();
  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const sessionFile of files) {
      const sessionId = path.basename(sessionFile, ".jsonl");
      sessionPaths.set(sessionId, path.join(projectPath, sessionFile));
    }
  }

  const importedSessionIds = dbModule.db
    .prepare("SELECT id FROM sessions WHERE metadata LIKE '%\"imported\":true%'")
    .all();

  const total = importedSessionIds.length;
  let processed = 0;

  const tx = dbModule.db.transaction((tokenUpdateBatch) => {
    for (const { sessionId, tokens } of tokenUpdateBatch) {
      const written = writeSessionTokens(dbModule, sessionId, tokens);
      if (written > 0) {
        counters.sessionsTouched++;
        counters.modelsWritten += written;
      }
      counters.reconciled++;
    }
  });

  let tokenUpdateBatch = [];
  const FLUSH = 50;

  for (const { id: sessionId } of importedSessionIds) {
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
        for (const subagentPath of subPaths) {
          try {
            const subagentData = await parseSubagentFile(subagentPath);
            if (subagentData) session.parsedSubagents.push(subagentData);
          } catch {
            
          }
        }
      }

      const tokens = combineSessionTokens(session);
      if (Object.keys(tokens).length > 0) {
        tokenUpdateBatch.push({ sessionId, tokens });
        if (tokenUpdateBatch.length >= FLUSH) {
          tx(tokenUpdateBatch);
          tokenUpdateBatch = [];
        }
      } else {
        counters.reconciled++;
      }
    } catch {
      
    }

    if (processed % 25 === 0) onProgress({ processed, total, counters });
  }
  if (tokenUpdateBatch.length > 0) tx(tokenUpdateBatch);

  onProgress({ processed, total, counters });
  return counters;
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  const reconcile = process.argv.includes("--reconcile-tokens");
  const projectArgIndex = process.argv.indexOf("--project");
  const projectFilter = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

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
             COALESCE(SUM(input_tokens), 0) AS i,
             COALESCE(SUM(output_tokens), 0) AS o,
             COALESCE(SUM(cache_read_tokens), 0) AS cr,
             COALESCE(SUM(cache_write_tokens), 0) AS cw
           FROM token_usage`
        )
        .get();
      const result = await reconcileTokens(dbModule, {
        onProgress: ({ processed, total, counters }) => {
          process.stdout.write(
            `  reconciling ${processed}/${total} (touched: ${counters.sessionsTouched}, models: ${counters.modelsWritten})\result`
          );
        },
      });
      const after = dbModule.db
        .prepare(
          `SELECT
             COALESCE(SUM(input_tokens), 0) AS i,
             COALESCE(SUM(output_tokens), 0) AS o,
             COALESCE(SUM(cache_read_tokens), 0) AS cr,
             COALESCE(SUM(cache_write_tokens), 0) AS cw
           FROM token_usage`
        )
        .get();
      console.log(`\nReconciled ${result.reconciled} sessions.`);
      console.log(`Sessions whose tokens changed: ${result.sessionsTouched}`);
      console.log(`Token rows written: ${result.modelsWritten}`);
      if (result.missingFiles > 0) {
        console.log(`Sessions with no JSONL on disk (skipped): ${result.missingFiles}`);
      }
      const formatNumber = (n) => Number(n).toLocaleString();
      console.log("");
      console.log("Token totals (before → after):");
      console.log(
        `  input:       ${formatNumber(before.i)}  →  ${formatNumber(after.i)}  (Δ ${formatNumber(after.i - before.i)})`
      );
      console.log(
        `  output:      ${formatNumber(before.o)}  →  ${formatNumber(after.o)}  (Δ ${formatNumber(after.o - before.o)})`
      );
      console.log(
        `  cache_read:  ${formatNumber(before.cr)}  →  ${formatNumber(after.cr)}  (Δ ${formatNumber(after.cr - before.cr)})`
      );
      console.log(
        `  cache_write: ${formatNumber(before.cw)}  →  ${formatNumber(after.cw)}  (Δ ${formatNumber(after.cw - before.cw)})`
      );
      console.log("\nDone.");
      return;
    }

    if (dryRun) {
      const projectDirs = fs
        .readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((directoryEntry) => directoryEntry.isDirectory())
        .map((directoryEntry) => directoryEntry.name);

      let total = 0;
      for (const projectDir of projectDirs) {
        if (projectFilter && !projectDir.includes(projectFilter)) continue;
        const projectPath = path.join(PROJECTS_DIR, projectDir);
        const files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
        if (files.length === 0) continue;

        const label = projectDir.replace(/^C--/, "").replace(/-/g, "/");
        console.log(`\nProject: ${label} (${files.length} sessions)`);

        for (const file of files) {
          total++;
          try {
            const session = await parseSessionFile(path.join(projectPath, file));
            if (!session) {
              console.log(`  SKIP ${file} (empty)`);
              continue;
            }
            const totalTokens = Object.values(session.tokensByModel).reduce(
              (sum, tokenBucket) => sum + tokenBucket.input + tokenBucket.output,
              0
            );
            console.log(
              `  ${session.sessionId.slice(0, 12)}... | ${session.name.slice(0, 40).padEnd(40)} | msgs: ${session.userMessages}/${session.assistantMessages} | teams: ${session.teams.length} | models: ${[...new Set(Object.values(session.tokensByModel).map((tokenBucket) => tokenBucket.model))].join(",")} | tokens: ${totalTokens}`
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

function collectJsonlFiles(rootDir) {
  const jsonlFilePaths = [];
  const stack = [rootDir];
  const seen = new Set();
  while (stack.length) {
    const dir = stack.pop();
    let realPath;
    try {
      realPath = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const directoryEntry of entries) {
      const fullPath = path.join(dir, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        stack.push(fullPath);
      } else if (directoryEntry.isFile() && directoryEntry.name.endsWith(".jsonl")) {
        jsonlFilePaths.push(fullPath);
      } else if (directoryEntry.isSymbolicLink()) {
        try {
          const rootStats = fs.statSync(fullPath);
          if (rootStats.isDirectory()) stack.push(fullPath);
          else if (rootStats.isFile() && fullPath.endsWith(".jsonl")) jsonlFilePaths.push(fullPath);
        } catch {
          
        }
      }
    }
  }
  return jsonlFilePaths;
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
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const files = fs.readdirSync(candidate).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
      for (const sessionFile of files) result.push(path.join(candidate, sessionFile));
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
    wasModified: 0,
    errors: 0,
    sessionsSeen: 0,
    filesScanned: 0,
  };

  if (!fs.existsSync(rootDir)) return counters;
  const rootStats = fs.statSync(rootDir);
  if (!rootStats.isDirectory()) return counters;

  onProgress({ phase: "scan", processed: 0, total: 0, counters });
  const jsonlFiles = collectJsonlFiles(rootDir);
  counters.filesScanned = jsonlFiles.length;
  onProgress({ phase: "parse", processed: 0, total: jsonlFiles.length, counters });

  const sessionFiles = [];
  const standaloneSubagentFiles = [];
  for (const sessionFile of jsonlFiles) {
    if (classifyJsonl(sessionFile) === "subagent") standaloneSubagentFiles.push(sessionFile);
    else sessionFiles.push(sessionFile);
  }

  const parsedSessions = [];
  for (let i = 0; i < sessionFiles.length; i++) {
    const sessionFile = sessionFiles[i];
    try {
      const session = await parseSessionFile(sessionFile);
      if (!session) {
        counters.skipped++;
        onProgress({
          phase: "parse",
          processed: i + 1,
          total: sessionFiles.length,
          current: sessionFile,
          counters,
        });
        continue;
      }

      
      const subPaths = findSessionSubagents(sessionFile);
      if (subPaths.length > 0) {
        session.parsedSubagents = [];
        for (const subagentPath of subPaths) {
          try {
            const subagentData = await parseSubagentFile(subagentPath);
            if (subagentData) session.parsedSubagents.push(subagentData);
          } catch {
            
          }
        }
      }

      
      
      
      session._sourceJsonlPath = sessionFile;
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
        current: sessionFile,
        counters,
      });
    }
  }

  if (parsedSessions.length > 0) {
    const importBatch = dbModule.db.transaction((sessions) => {
      for (const session of sessions) {
        try {
          const result = importSession(dbModule, session);
          if (result.skipped && !result.wasModified) counters.skipped++;
          else if (result.wasModified) counters.wasModified++;
          else counters.imported++;
        } catch {
          counters.errors++;
        }
      }
    });
    importBatch(parsedSessions);
  }

  
  
  
  
  
  
  
  if (standaloneSubagentFiles.length > 0) {
    for (const subagentFile of standaloneSubagentFiles) {
      try {
        const subagentData = await parseSubagentFile(subagentFile);
        if (!subagentData) continue;
        const parts = subagentFile.split(path.sep);
        const subagentsDirIndex = parts.lastIndexOf("subagents");
        if (subagentsDirIndex < 0) continue;
        const candidates = [];
        if (subagentsDirIndex - 1 >= 0) candidates.push(parts[subagentsDirIndex - 1]);
        if (subagentsDirIndex + 1 < parts.length) candidates.push(parts[subagentsDirIndex + 1]);
        let sessionId = null;
        for (const candidate of candidates) {
          if (!candidate) continue;
          if (dbModule.stmts.getSession.get(candidate)) {
            sessionId = candidate;
            break;
          }
        }
        if (!sessionId) continue;
        const mainAgentId = `${sessionId}-main`;
        const result = importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subagentData);
        if (result.created > 0 || result.updated > 0) {
          counters.wasModified++;
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

  const subFiles = (await fs.promises.readdir(subDir)).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
  if (subFiles.length === 0) return { imported: 0, created: 0 };

  const { db } = dbModule;
  const mainAgentId = `${sessionId}-main`;
  let created = 0;
  const parsedSubagents = [];
  for (const subagentFile of subFiles) {
    try {
      const subagentData = await parseSubagentFile(path.join(subDir, subagentFile));
      if (!subagentData) continue;
      parsedSubagents.push(subagentData);
      created += importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subagentData).created;
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
        for (const model of opts.parentModels) if (model) parentModels.add(model);
      }
      const combined = combineSessionTokens({ tokensByModel: null, parsedSubagents });
      const subOnly = {};
      for (const [key, tokenBucket] of Object.entries(combined)) {
        
        
        
        
        
        
        
        if (tokenBucket.model && !parentModels.has(tokenBucket.model)) subOnly[key] = tokenBucket;
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
                s.metadata AS existingMetadata
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
  for (const sessionRow of sessions) {
    
    
    
    
    let transcriptPath = sessionRow.tp && fs.existsSync(sessionRow.tp) ? sessionRow.tp : null;
    if (!transcriptPath) {
      let slug = null;
      try {
        slug = sessionRow.existingMetadata ? JSON.parse(sessionRow.existingMetadata).slug : null;
      } catch {
        slug = null;
      }
      if (slug) {
        const candidate = path.join(PROJECTS_DIR, slug, `${sessionRow.session_id}.jsonl`);
        
        
        
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
    const mainAgentId = `${sessionRow.session_id}-main`;
    for (const subagentFile of subFiles) {
      try {
        const subagentData = await parseSubagentFile(subagentFile);
        if (!subagentData) continue;
        const result = importSubagentFromJsonl(dbModule, sessionRow.session_id, mainAgentId, subagentData);
        if (result.updated > 0) stamped++;
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
  importSubagents,
  importSubagentFromJsonl,
  backfillSubagentTokenMetadata,
  reconcileSubagentParents,
  parseSessionFile,
  parseSubagentFile,
  collectJsonlFiles,
  classifyJsonl,
  findSessionSubagents,
  importSession,
  scanAndImportSubagents,
  combineSessionTokens,
  writeSessionTokens,
  reconcileTokens,
};
