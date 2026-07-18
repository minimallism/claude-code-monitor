const { Router } = require("express");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { stmts, db } = require("../db");
const { broadcast } = require("../websocket");
const { calculateCost, attachAgentCosts } = require("./pricing");
const {
  getClaudeHome,
  getProjectsDir,
  getTranscriptPath,
  getSubagentTranscriptPath,
  getSnapshotTranscriptPath,
  getSnapshotSubagentTranscriptPath,
  findTranscriptPath,
  findSubagentTranscriptPath,
} = require("../lib/claude-home");

const router = Router();

const TRANSCRIPT_RENDER_TYPES = new Set(["user", "assistant", "custom-title", "system"]);

function classifyTranscriptSender(entry, isSubagentFile) {
  if (entry.type === "assistant") return "assistant";
  
  if (entry.type !== "user") return "user";

  const content = entry.message ? entry.message.content : undefined;
  const onlyToolResults =
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => b && b.type === "tool_result");
  if (entry.toolUseResult !== undefined || onlyToolResults) return "tool";

  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content.find((b) => b && b.type === "text") || {}).text || ""
        : "";
  const lead = text.replace(/^\s+/, "");

  
  if (entry.isMeta === true) return "system";
  if (lead.startsWith("<task-notification>") || lead.startsWith("<task-notification ")) {
    return "system";
  }

  
  
  
  if (isSubagentFile && entry.promptSource === undefined && entry.origin === undefined) {
    return "orchestrator";
  }

  return "user";
}

async function readFirstLine(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    rl.close();
    rl.removeAllListeners();
    return line;
  }
  return null;
}

router.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 10000);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const cwd = req.query.cwd;
  const sortBy = req.query.sort_by || "time"; 
  const sortDesc = req.query.sort_desc !== "false";

  let where = [];
  let params = [];

  if (q) {
    const like = `%${q}%`;
    where.push("(s.id LIKE ? OR s.name LIKE ? OR s.cwd LIKE ?)");
    params.push(like, like, like);
  }
  if (status) {
    where.push("s.status = ?");
    params.push(status);
  }
  if (cwd) {
    where.push("s.cwd = ?");
    params.push(cwd);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) as c FROM sessions s ${whereSql}`).get(...params).c;

  let rows = [];

  if (sortBy === "price") {
    const allRows = db
      .prepare(
        `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity
         FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
         ${whereSql}
         GROUP BY s.id`
      )
      .all(...params);

    if (allRows.length > 0) {
      const rules = stmts.listPricing.all();

      for (let i = 0; i < allRows.length; i += 900) {
        const chunk = allRows.slice(i, i + 900);
        const ids = chunk.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        const chunkTokens = db
          .prepare(
            `SELECT session_id, model,
              input_tokens + baseline_input as input_tokens,
              output_tokens + baseline_output as output_tokens,
              cache_read_tokens + baseline_cache_read as cache_read_tokens,
              cache_write_tokens + baseline_cache_write as cache_write_tokens
            FROM token_usage WHERE session_id IN (${placeholders})`
          )
          .all(...ids);

        const tokensBySession = {};
        for (const t of chunkTokens) {
          if (!tokensBySession[t.session_id]) tokensBySession[t.session_id] = [];
          tokensBySession[t.session_id].push(t);
        }

        for (const row of chunk) {
          const sessionTokens = tokensBySession[row.id];
          row.cost = sessionTokens
            ? calculateCost(sessionTokens, rules, row.started_at).total_cost
            : 0;
        }
      }

      allRows.sort((a, b) => {
        return sortDesc ? b.cost - a.cost : a.cost - b.cost;
      });
      rows = allRows.slice(offset, offset + limit);
    }
  } else {
    let orderSql = "s.updated_at DESC";
    if (sortBy === "time") {
      orderSql = `s.updated_at ${sortDesc ? "DESC" : "ASC"}`;
    } else if (sortBy === "duration") {
      orderSql = `(julianday(COALESCE(s.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) - julianday(s.started_at)) ${sortDesc ? "DESC" : "ASC"}`;
    }

    rows = db
      .prepare(
        `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity
         FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
         ${whereSql}
         GROUP BY s.id ORDER BY ${orderSql} LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const allTokens = db
        .prepare(
          `SELECT session_id, model,
            input_tokens + baseline_input as input_tokens,
            output_tokens + baseline_output as output_tokens,
            cache_read_tokens + baseline_cache_read as cache_read_tokens,
            cache_write_tokens + baseline_cache_write as cache_write_tokens
          FROM token_usage WHERE session_id IN (${placeholders})`
        )
        .all(...ids);

      const rules = stmts.listPricing.all();
      const tokensBySession = {};
      for (const t of allTokens) {
        if (!tokensBySession[t.session_id]) tokensBySession[t.session_id] = [];
        tokensBySession[t.session_id].push(t);
      }

      for (const row of rows) {
        const sessionTokens = tokensBySession[row.id];
        row.cost = sessionTokens
          ? calculateCost(sessionTokens, rules, row.started_at).total_cost
          : 0;
      }
    }
  }

  res.json({ sessions: rows, limit, offset, total });
});

router.get("/facets", (req, res) => {
  const rows = db
    .prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != '' ORDER BY cwd")
    .all();
  res.json({ cwds: rows.map((r) => r.cwd) });
});

router.get("/:id", (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }
  
  
  const agents = attachAgentCosts(stmts.listAgentsBySession.all(req.params.id));
  const events = stmts.listEventsBySession.all(req.params.id);
  
  
  const workflows = stmts.listWorkflowsBySession.all(req.params.id).map((w) => {
    let phases = [];
    let progress = [];
    try {
      phases = w.phases ? JSON.parse(w.phases) : [];
    } catch {
      phases = [];
    }
    try {
      progress = w.progress ? JSON.parse(w.progress) : [];
    } catch {
      progress = [];
    }
    return { ...w, phases, progress };
  });
  res.json({ session, agents, events, workflows });
});

router.get("/:id/stats", (req, res) => {
  const sessionId = req.params.id;
  const session = stmts.getSession.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  const totalEvents = stmts.sessionEventCount.get(sessionId)?.count ?? 0;
  const eventsByType = stmts.sessionEventTypeCounts.all(sessionId);
  const tools = stmts.sessionToolUsageCounts.all(sessionId);
  const errors = stmts.sessionErrorCount.get(sessionId)?.count ?? 0;
  const timeRange = stmts.sessionEventTimeRange.get(sessionId) || {};
  const subagentTypes = stmts.sessionAgentTypeCounts.all(sessionId);
  const agentStatusRows = stmts.sessionAgentStatusCounts.all(sessionId);
  const tokens = stmts.sessionTokenTotals.get(sessionId) || {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  
  const agentCounts = {
    total: 0,
    main: 0,
    subagent: 0,
    compaction: 0,
    by_status: {},
  };
  for (const row of agentStatusRows) {
    agentCounts.total += row.count;
    agentCounts.by_status[row.status] = row.count;
  }
  
  const compactionRow = subagentTypes.find((r) => r.subagent_type === "compaction");
  agentCounts.compaction = compactionRow?.count ?? 0;
  
  const typeCounts = db
    .prepare(`SELECT type, COUNT(*) as count FROM agents WHERE session_id = ? GROUP BY type`)
    .all(sessionId);
  for (const row of typeCounts) {
    if (row.type === "main") agentCounts.main = row.count;
    else if (row.type === "subagent") agentCounts.subagent = row.count;
  }

  res.json({
    session_id: sessionId,
    total_events: totalEvents,
    events_by_type: eventsByType,
    tools_used: tools,
    error_count: errors,
    first_event_at: timeRange.first_at ?? null,
    last_event_at: timeRange.last_at ?? null,
    agents: agentCounts,
    subagent_types: subagentTypes.filter((r) => r.subagent_type !== "compaction"),
    tokens,
  });
});

router.post("/", (req, res) => {
  const { id, name, cwd, model, metadata } = req.body;
  if (!id) {
    return res.status(400).json({ error: { code: "INVALID_INPUT", message: "id is required" } });
  }

  const existing = stmts.getSession.get(id);
  if (existing) {
    return res.json({ session: existing, created: false });
  }

  stmts.insertSession.run(
    id,
    name || null,
    "active",
    cwd || null,
    model || null,
    metadata ? JSON.stringify(metadata) : null
  );
  const session = stmts.getSession.get(id);
  broadcast("session_created", session);
  res.status(201).json({ session, created: true });
});

router.patch("/:id", (req, res) => {
  const { name, status, ended_at, metadata } = req.body;
  const existing = stmts.getSession.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  stmts.updateSession.run(
    name || null,
    status || null,
    ended_at || null,
    metadata ? JSON.stringify(metadata) : null,
    req.params.id
  );

  const session = stmts.getSession.get(req.params.id);
  broadcast("session_updated", session);
  res.json({ session });
});

router.get("/:id/transcripts", async (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  const result = [];

  
  const dbAgents = stmts.listAgentsBySession.all(req.params.id) || [];

  
  const mainPath =
    getTranscriptPath(req.params.id, session.cwd) ||
    findTranscriptPath(req.params.id) ||
    getSnapshotTranscriptPath(req.params.id);
  if (mainPath && fs.existsSync(mainPath)) {
    
    const mainDbAgent = dbAgents.find((a) => a.type === "main");
    result.push({
      id: "main",
      name: "Main Agent",
      type: "main",
      has_transcript: true,
      db_agent_id: mainDbAgent ? mainDbAgent.id : null,
    });
  }

  
  const encoded = session.cwd ? session.cwd.replace(/[^a-zA-Z0-9]/g, "-") : null;
  const subagentDirs = [];

  
  if (encoded) {
    const directDir = path.join(getProjectsDir(), encoded, req.params.id, "subagents");
    if (fs.existsSync(directDir)) subagentDirs.push(directDir);
  }

  
  if (subagentDirs.length === 0) {
    const projectsDir = path.join(getClaudeHome(), "projects");
    if (fs.existsSync(projectsDir)) {
      try {
        for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const candidate = path.join(projectsDir, d.name, req.params.id, "subagents");
          if (fs.existsSync(candidate)) subagentDirs.push(candidate);
        }
      } catch {
        
      }
    }
  }

  for (const dir of subagentDirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        
        const shortId = file.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        
        let meta = null;
        const metaPath = path.join(dir, file.replace(".jsonl", ".meta.json"));
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          } catch {
            
          }
        }

        const isCompact = shortId.startsWith("acompact-");
        const transcriptName = isCompact
          ? "Context Compaction"
          : meta?.description || meta?.agentType || shortId;
        const transcriptSubagentType = meta?.agentType || null;

        
        let transcriptTimestamp = null;
        try {
          const jsonlPath = path.join(dir, file);
          const firstLine = await readFirstLine(jsonlPath);
          if (firstLine) {
            const entry = JSON.parse(firstLine);
            transcriptTimestamp = entry.timestamp || null;
          }
        } catch {
          
        }

        result.push({
          id: shortId,
          name: transcriptName,
          type: isCompact ? "compaction" : "subagent",
          subagent_type: transcriptSubagentType,
          has_transcript: true,
          db_agent_id: null, 
          _timestamp: transcriptTimestamp,
        });
      }
    } catch {
      
    }
  }

  
  
  

  
  for (const t of result) {
    if (t.type === "main") continue;
    
    t._sortTime = t._timestamp ? new Date(t._timestamp).getTime() : Infinity;
  }

  
  const agentsByType = {};
  for (const a of dbAgents) {
    const key = a.subagent_type || a.type;
    if (!agentsByType[key]) agentsByType[key] = [];
    agentsByType[key].push(a);
  }
  for (const key of Object.keys(agentsByType)) {
    agentsByType[key].sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
  }

  
  
  const transcriptsByType = {};
  for (const t of result) {
    if (t.type === "main") continue;
    
    const key = t.subagent_type || t.type;
    if (!transcriptsByType[key]) transcriptsByType[key] = [];
    transcriptsByType[key].push(t);
  }
  
  for (const key of Object.keys(transcriptsByType)) {
    transcriptsByType[key].sort((a, b) => (a._sortTime || Infinity) - (b._sortTime || Infinity));
  }

  
  
  for (const key of Object.keys(transcriptsByType)) {
    const tGroup = transcriptsByType[key];
    const aGroup = agentsByType[key] || [];
    const usedAgentIds = new Set();

    for (let i = 0; i < tGroup.length; i++) {
      const t = tGroup[i];

      
      if (t.db_agent_id) {
        usedAgentIds.add(t.db_agent_id);
        continue;
      }

      
      if (i < aGroup.length && !usedAgentIds.has(aGroup[i].id)) {
        t.db_agent_id = aGroup[i].id;
        usedAgentIds.add(aGroup[i].id);
      }
      
    }
  }

  
  for (const t of result) {
    delete t._timestamp;
    delete t._sortTime;
  }

  
  result.sort((a, b) => {
    if (a.type === "main") return -1;
    if (b.type === "main") return 1;
    const aAgent = dbAgents.find((ag) => ag.id === a.db_agent_id);
    const bAgent = dbAgents.find((ag) => ag.id === b.db_agent_id);
    const aTime = aAgent?.started_at ? new Date(aAgent.started_at).getTime() : 0;
    const bTime = bAgent?.started_at ? new Date(bAgent.started_at).getTime() : 0;
    if (aTime && bTime) return aTime - bTime;
    if (aTime) return -1;
    if (bTime) return 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  res.json({ transcripts: result });
});

router.get("/:id/transcript", async (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  const agentId = req.query.agent_id || null;
  const runId = req.query.run_id || null;
  
  
  const isSubagentFile = !!(agentId && agentId !== "main");
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const afterLine = req.query.after ? parseInt(req.query.after) : null;
  const beforeLine = req.query.before ? parseInt(req.query.before) : null;
  const offset = parseInt(req.query.offset) || 0;

  
  
  
  
  let jsonlPath;
  if (agentId && agentId !== "main") {
    jsonlPath =
      getSubagentTranscriptPath(req.params.id, session.cwd, agentId, runId) ||
      findSubagentTranscriptPath(req.params.id, agentId, runId) ||
      getSnapshotSubagentTranscriptPath(req.params.id, agentId, runId);
  } else {
    jsonlPath =
      getTranscriptPath(req.params.id, session.cwd) ||
      findTranscriptPath(req.params.id) ||
      getSnapshotTranscriptPath(req.params.id);
  }

  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return res.json({ messages: [], total: 0, has_more: false, last_line: 0, first_line: 0 });
  }

  try {
    
    
    
    const messages = [];
    let lineNum = 0;
    let total = 0; 
    let hasMore = false;

    const rl = readline.createInterface({
      input: fs.createReadStream(jsonlPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    
    
    
    let lastRenameTitle = null;

    
    function parseMessage(entry, num) {
      
      
      
      if (entry.type === "custom-title") {
        const title = typeof entry.customTitle === "string" ? entry.customTitle.trim() : "";
        if (!title || title === lastRenameTitle) return null;
        lastRenameTitle = title;
        return {
          type: "session_event",
          event_kind: "rename",
          title,
          timestamp: entry.timestamp || null,
          content: [],
          line: num,
        };
      }

      
      
      
      
      
      
      
      
      if (entry.type === "system") {
        if (entry.subtype !== "local_command") return null;
        const sysText = typeof entry.content === "string" ? entry.content : "";
        if (!sysText.trim()) return null;
        return {
          type: "user",
          sender: "user", 
          timestamp: entry.timestamp || null,
          content: [{ type: "text", text: truncate(sysText, 10240) }],
          line: num,
        };
      }

      const msg = entry.type === "assistant" ? entry.message || {} : {};
      const content = [];

      if (entry.type === "user") {
        const msgContent = entry.message?.content;
        if (typeof msgContent === "string") {
          content.push({ type: "text", text: truncate(msgContent, 10240) });
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === "text" && block.text) {
              content.push({ type: "text", text: truncate(block.text, 10240) });
            } else if (block.type === "tool_result") {
              content.push({
                type: "tool_result",
                id: block.tool_use_id || null,
                output: truncate(
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content || ""),
                  10240
                ),
                is_error: !!block.is_error,
              });
            }
          }
        } else if (msgContent === undefined || msgContent === null) {
          return null;
        }
      } else {
        const msgContent = msg.content || [];
        if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === "text" && block.text) {
              content.push({ type: "text", text: truncate(block.text, 10240) });
            } else if (block.type === "thinking" && block.thinking) {
              content.push({ type: "thinking", text: truncate(block.thinking, 10240) });
            } else if (block.type === "tool_use") {
              content.push({
                type: "tool_use",
                name: block.name || "unknown",
                id: block.id || null,
                input: truncateObj(block.input, 10240),
              });
            }
          }
        }
      }

      if (content.length === 0) return null;

      const message = {
        type: entry.type,
        sender: classifyTranscriptSender(entry, isSubagentFile),
        timestamp: entry.timestamp
          ? typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString()
            : entry.timestamp
          : null,
        content,
        line: num,
      };

      if (entry.type === "assistant") {
        if (msg.model) message.model = msg.model;
        if (msg.usage) {
          message.usage = {
            input_tokens: msg.usage.input_tokens || 0,
            output_tokens: msg.usage.output_tokens || 0,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens || 0,
          };
        }
      }

      return message;
    }

    if (afterLine !== null) {
      
      let foundStart = false;
      for await (const line of rl) {
        lineNum++;
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!TRANSCRIPT_RENDER_TYPES.has(entry.type)) continue;

        if (!foundStart) {
          if (lineNum <= afterLine) continue;
          foundStart = true;
        }

        const message = parseMessage(entry, lineNum);
        if (!message) continue;
        total++;
        messages.push(message);
        if (messages.length >= limit) {
          
          hasMore = true;
          rl.close();
          rl.removeAllListeners();
          break;
        }
      }
      
    } else if (beforeLine !== null) {
      
      
      
      
      for await (const line of rl) {
        lineNum++;
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!TRANSCRIPT_RENDER_TYPES.has(entry.type)) continue;
        if (lineNum >= beforeLine) {
          
          rl.close();
          rl.removeAllListeners();
          break;
        }

        const message = parseMessage(entry, lineNum);
        if (!message) continue;
        total++;
        messages.push(message);
        
        if (messages.length > limit) {
          messages.shift();
        }
      }
      if (total > limit) hasMore = true;
    } else if (offset > 0) {
      
      let skipped = 0;
      for await (const line of rl) {
        lineNum++;
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!TRANSCRIPT_RENDER_TYPES.has(entry.type)) continue;

        const message = parseMessage(entry, lineNum);
        if (!message) continue;
        total++;

        if (skipped < offset) {
          skipped++;
          continue;
        }
        messages.push(message);
        if (messages.length >= limit) {
          hasMore = true; 
          rl.close();
          rl.removeAllListeners();
          break;
        }
      }
    } else {
      
      for await (const line of rl) {
        lineNum++;
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!TRANSCRIPT_RENDER_TYPES.has(entry.type)) continue;

        const message = parseMessage(entry, lineNum);
        if (!message) continue;
        total++;
        messages.push(message);
        
        if (messages.length > limit) {
          messages.shift();
        }
      }
      
      hasMore = total > limit;
    }

    const lastLine = messages.length > 0 ? messages[messages.length - 1].line : 0;
    const firstLine = messages.length > 0 ? messages[0].line : 0;

    
    for (const m of messages) {
      delete m.line;
    }

    res.json({
      messages,
      total,
      has_more: hasMore,
      last_line: lastLine,
      first_line: firstLine,
    });
  } catch (err) {
    res.json({ messages: [], total: 0, has_more: false, last_line: 0, first_line: 0 });
  }
});

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "[truncated]";
}

function truncateObj(obj, maxLen) {
  if (!obj) return obj;
  const json = JSON.stringify(obj);
  if (json.length <= maxLen) return obj;
  return { _truncated: truncate(json, maxLen) };
}

module.exports = router;

module.exports.classifyTranscriptSender = classifyTranscriptSender;
