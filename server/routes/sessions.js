/**
 * 会话（Session）API 路由。
 *
 * 提供：
 * - 会话列表查询、搜索、过滤、排序。
 * - 单会话详情（含 agents、events）。
 * - 会话统计（工具调用、token、agent 分布等）。
 * - 转录本列表与转录本消息读取（用于会话详情页对话视图）。
 */

const { Router } = require("express");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { stmts, db } = require("../db");

const {
  getClaudeHome,
  getProjectsDir,
  getTranscriptPath,
  getSubagentTranscriptPath,
  findTranscriptPath,
  findSubagentTranscriptPath,
} = require("../lib/claude-home");

const router = Router();

// 转录本中需要渲染为对话消息的行类型。其他类型（如 compact-title、tool 事件等）直接忽略。
const TRANSCRIPT_RENDER_TYPES = new Set(["user", "assistant", "custom-title", "system"]);

/**
 * 将单条 JSONL 转录本条目归一化为前端展示所需的发送者类型。
 *
 * 难点：Claude Code 的 user 条目有时是真正的用户输入，有时是 tool_result、
 * 系统通知（<task-notification>）或子 agent 返回给父 agent 的结果。
 * 需要结合 entry.type、content 结构和 isSubagentFile 才能正确区分。
 *
 * 返回值：assistant | user | tool | system | orchestrator
 *   - orchestrator：子 agent 转录本中由父 agent 下发的任务指令。
 */
function classifyTranscriptSender(entry, isSubagentFile) {
  if (entry.type === "assistant") return "assistant";

  if (entry.type !== "user") return "user";

  const content = entry.message ? entry.message.content : undefined;
  // 如果 content 全是 tool_result 块，说明这是某次 tool_use 的结果回显，不是用户说的话。
  const onlyToolResults =
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => b && b.type === "tool_result");
  if (entry.toolUseResult !== undefined || onlyToolResults) return "tool";

  // 从 content 中提取可读的文本片段，用于后续判断是否是系统通知。
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content.find((b) => b && b.type === "text") || {}).text || ""
        : "";
  const trimmedText = text.replace(/^\s+/, "");

  if (entry.isMeta === true) return "system";
  if (trimmedText.startsWith("<task-notification>") || trimmedText.startsWith("<task-notification ")) {
    return "system";
  }

  // 子 agent 的转录本中，没有 promptSource/origin 的 user 条目实际上是父 agent 给它的任务描述。
  if (isSubagentFile && entry.promptSource === undefined && entry.origin === undefined) {
    return "orchestrator";
  }

  return "user";
}

/**
 * 查询会话列表，并聚合每个会话的 agent 数量及是否存在工作中的子 agent。
 *
 * 注意：
 * - 使用 LEFT JOIN 是因为会话可能没有子 agent，但仍需显示。
 * - MAX(CASE WHEN ...) 用于把多行聚合为一个布尔标志 has_working_subagent，
 *   避免在应用层二次遍历 agents 表。
 * - 当按 tokens/turns 排序时，外层会先查出全部行再内存排序，
 *   因为这两个字段分别来自 token_usage 表和 sessions.metadata，无法单纯靠 SQL 简单排序。
 */
function fetchSessionRows(whereSql, params, options = {}) {
  const { orderSql, limit, offset } = options;
  const orderClause = orderSql ? ` ORDER BY ${orderSql}` : "";
  const limitClause = limit !== undefined ? " LIMIT ? OFFSET ?" : "";
  const sql = `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity,
               MAX(CASE WHEN a.type = 'subagent' AND a.status = 'working' THEN 1 ELSE 0 END) as has_working_subagent
        FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
        ${whereSql}
        GROUP BY s.id${orderClause}${limitClause}`;
  const queryParams = [...params];
  if (limit !== undefined) queryParams.push(limit, offset);
  return db.prepare(sql).all(...queryParams);
}

/**
 * 为会话行附加 turn_count 字段。
 *
 * turn_count 来自 sessions.metadata，由转录本中的 turn_duration 系统事件累加得到。
 */
function attachTurnCounts(rows) {
  for (const row of rows) {
    row.turn_count = extractTurnCount(row);
  }
  return rows;
}

/**
 * 为会话行附加 total_tokens 字段。
 *
 * 实现细节：
 * - token_usage 表按 (session_id, model) 聚合，因此需要按 session_id 汇总所有 model 的分桶。
 * - 每次查询最多 900 个会话 id，避免 SQLite 的 IN 占位符数量超过编译限制（默认 999）。
 * - 先一次性查出 token_usage，再用 tokensBySession 做内存分组，减少数据库往返。
 */
function attachTotalTokens(rows) {
  if (rows.length === 0) return rows;
  for (let i = 0; i < rows.length; i += 900) {
    const chunk = rows.slice(i, i + 900);
    const ids = chunk.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const chunkTokens = db
      .prepare(
        `SELECT session_id, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
        FROM token_usage WHERE session_id IN (${placeholders})`
      )
      .all(...ids);

    const tokensBySession = {};
    for (const tokenRow of chunkTokens) {
      if (!tokensBySession[tokenRow.session_id]) tokensBySession[tokenRow.session_id] = [];
      tokensBySession[tokenRow.session_id].push(tokenRow);
    }

    for (const row of chunk) {
      const sessionTokens = tokensBySession[row.id];
      row.total_tokens = sessionTokens
        ? sessionTokens.reduce((sum, tokenRow) => sum + tokenRow.input_tokens + tokenRow.output_tokens + tokenRow.cache_read_tokens + tokenRow.cache_write_tokens, 0)
        : 0;
    }
  }
  return rows;
}

/**
 * 读取文件第一行并立即关闭流。
 *
 * 用于从子 agent JSONL 首行提取时间戳，做转录本与数据库 agent 的顺序对齐。
 */
async function readFirstLine(filePath) {
  const lineReader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lineReader) {
    lineReader.close();
    lineReader.removeAllListeners();
    return line;
  }
  return null;
}

/**
 * GET /api/sessions
 *
 * 查询会话列表，支持：
 * - q: 按 id/name/cwd 模糊搜索。
 * - status: 按状态过滤。
 * - cwd: 按工作目录过滤。
 * - sort_by: time | tokens | turns | duration。
 * - sort_desc: true/false。
 * - limit / offset: 分页。
 */
router.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 10000);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;
  const searchQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const cwd = req.query.cwd;
  const sortBy = req.query.sort_by || "time";
  const sortDesc = req.query.sort_desc !== "false";

  let where = [];
  let params = [];

  if (searchQuery) {
    const like = `%${searchQuery}%`;
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

  // tokens/turns 字段无法直接在 SQL ORDER BY 中使用，需要先查出全部行再内存排序。
  if (sortBy === "tokens") {
    const allRows = attachTurnCounts(fetchSessionRows(whereSql, params));
    attachTotalTokens(allRows);
    allRows.sort((a, b) => (sortDesc ? b.total_tokens - a.total_tokens : a.total_tokens - b.total_tokens));
    rows = allRows.slice(offset, offset + limit);
  } else if (sortBy === "turns") {
    const allRows = attachTurnCounts(fetchSessionRows(whereSql, params));
    allRows.sort((a, b) => (sortDesc ? b.turn_count - a.turn_count : a.turn_count - b.turn_count));
    rows = allRows.slice(offset, offset + limit);
  } else {
    let orderSql = "s.updated_at DESC";
    if (sortBy === "time") {
      orderSql = `s.updated_at ${sortDesc ? "DESC" : "ASC"}`;
    } else if (sortBy === "duration") {
      orderSql = `(julianday(COALESCE(s.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) - julianday(s.started_at)) ${sortDesc ? "DESC" : "ASC"}`;
    }

    rows = attachTurnCounts(fetchSessionRows(whereSql, params, { orderSql, limit, offset }));
    attachTotalTokens(rows);
  }

  res.json({ sessions: rows, limit, offset, total });
});

/**
 * GET /api/sessions/facets
 *
 * 返回所有磁盘上仍然存在的 distinct cwd，用于前端过滤下拉框。
 */
router.get("/facets", (req, res) => {
  const rows = db
    .prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != '' ORDER BY cwd")
    .all();
  const cwds = rows.map((row) => row.cwd).filter((cwdPath) => fs.existsSync(cwdPath));
  res.json({ cwds });
});

/**
 * GET /api/sessions/:id
 *
 * 返回单个会话详情，包括会话本身、其下所有 agents 和事件列表。
 */
router.get("/:id", (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  session.turn_count = extractTurnCount(session);

  const agents = stmts.listAgentsBySession.all(req.params.id);
  const events = stmts.listEventsBySession.all(req.params.id);
  res.json({ session, agents, events });
});

/**
 * GET /api/sessions/:id/stats
 *
 * 返回单个会话的统计信息：事件总数、工具调用次数、agent 状态分布、token 用量等。
 */
router.get("/:id/stats", (req, res) => {
  const sessionId = req.params.id;
  const session = stmts.getSession.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  const totalEvents = stmts.sessionEventCount.get(sessionId)?.count ?? 0;
  const tools = stmts.sessionToolUsageCounts.all(sessionId);
  const toolCallCounts = stmts.sessionToolCallCounts.get(sessionId) || { attempts: 0, success: 0, failed: 0 };
  const timeRange = stmts.sessionEventTimeRange.get(sessionId) || {};
  const userPromptCount = stmts.sessionUserPromptCount.get(sessionId)?.count ?? 0;
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
    tools_used: tools,
    tool_call_attempts: toolCallCounts.attempts,
    tool_call_success: toolCallCounts.success,
    tool_call_failed: toolCallCounts.failed,
    first_event_at: timeRange.first_at ?? null,
    last_event_at: timeRange.last_at ?? null,
    agents: agentCounts,
    user_prompt_count: userPromptCount,
    tokens,
  });
});

/**
 * GET /api/sessions/:id/transcripts
 *
 * 返回该会话可用的转录本列表（main + subagents）。
 *
 * 子 agent 转录本文件名中只有短 id，没有稳定 uuid，因此需要按 subagent_type
 * 分组后按创建时间与数据库中的 agents 做最佳-effort 对齐。
 */
router.get("/:id/transcripts", async (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  const result = [];

  
  const dbAgents = stmts.listAgentsBySession.all(req.params.id) || [];

  
  const mainPath =
    getTranscriptPath(req.params.id, session.cwd) ||
    findTranscriptPath(req.params.id);
  if (mainPath && fs.existsSync(mainPath)) {
    
    const mainDbAgent = dbAgents.find((agent) => agent.type === "main");
    result.push({
      id: "main",
      name: "Main Agent",
      type: "main",
      has_transcript: true,
      db_agent_id: mainDbAgent ? mainDbAgent.id : null,
    });
  }

  
  // 将 cwd 编码为 Claude Code 在 ~/.claude/projects 下使用的目录名：非字母数字字符替换为 "-"。
  const encoded = session.cwd ? session.cwd.replace(/[^a-zA-Z0-9]/g, "-") : null;
  const subagentDirs = [];

  // 优先按会话 cwd 对应的 project slug 查找 subagents 目录。
  if (encoded) {
    const directDir = path.join(getProjectsDir(), encoded, req.params.id, "subagents");
    if (fs.existsSync(directDir)) subagentDirs.push(directDir);
  }

  // 如果按 cwd 没找到（例如会话被重命名、或 cwd 已不存在），
  // 则遍历整个 ~/.claude/projects 目录，按 session id 再搜索一次。
  if (subagentDirs.length === 0) {
    const projectsDir = path.join(getClaudeHome(), "projects");
    if (fs.existsSync(projectsDir)) {
      try {
        for (const projectDirEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
          if (!projectDirEntry.isDirectory()) continue;
          const candidate = path.join(projectsDir, projectDirEntry.name, req.params.id, "subagents");
          if (fs.existsSync(candidate)) subagentDirs.push(candidate);
        }
      } catch {
        // 目录遍历失败不影响主流程，继续返回已找到的转录本。
      }
    }
  }

  for (const dir of subagentDirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        
        const shortId = file.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        
        let subagentMeta = null;
        const metaPath = path.join(dir, file.replace(".jsonl", ".subagentMeta.json"));
        if (fs.existsSync(metaPath)) {
          try {
            subagentMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          } catch {
            
          }
        }

        const isCompact = shortId.startsWith("acompact-");
        const transcriptName = isCompact
          ? "Context Compaction"
          : subagentMeta?.description || subagentMeta?.agentType || shortId;
        const transcriptSubagentType = subagentMeta?.agentType || null;

        
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
          _sortTime: transcriptTimestamp ? new Date(transcriptTimestamp).getTime() : Infinity,
        });
      }
    } catch {
    }
  }

  // 按 subagent_type 对数据库中的 agents 分组并按 started_at 排序，
  // 后续用于把磁盘上的子 agent 转录本与数据库记录按创建顺序一一对应。
  const agentsByType = {};
  for (const agent of dbAgents) {
    const key = agent.subagent_type || agent.type;
    if (!agentsByType[key]) agentsByType[key] = [];
    agentsByType[key].push(agent);
  }
  for (const key of Object.keys(agentsByType)) {
    agentsByType[key].sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
  }

  // 同样按 subagent_type 对磁盘转录本分组，并按 JSONL 首行时间戳排序。
  const transcriptsByType = {};
  for (const transcriptEntry of result) {
    if (transcriptEntry.type === "main") continue;

    const key = transcriptEntry.subagent_type || transcriptEntry.type;
    if (!transcriptsByType[key]) transcriptsByType[key] = [];
    transcriptsByType[key].push(transcriptEntry);
  }

  for (const key of Object.keys(transcriptsByType)) {
    transcriptsByType[key].sort((a, b) => (a._sortTime || Infinity) - (b._sortTime || Infinity));
  }

  // 将同一 subagent_type 的转录本与数据库 agents 按顺序对齐。
  // 已有 db_agent_id（如 compaction 的已知映射）则跳过；否则按索引直接分配。
  // 这是一种最佳-effort 关联：子 agent 的 JSONL 文件名里只有 shortId，
  // 没有稳定 uuid，因此用时间顺序作为关联启发式。
  for (const key of Object.keys(transcriptsByType)) {
    const transcriptsByTypeGroup = transcriptsByType[key];
    const agentsByTypeGroup = agentsByType[key] || [];
    const usedAgentIds = new Set();

    for (let i = 0; i < transcriptsByTypeGroup.length; i++) {
      const transcriptEntry = transcriptsByTypeGroup[i];

      // 该转录本已通过其他途径（如 compaction 特殊处理）关联到 agent，无需再次分配。
      if (transcriptEntry.db_agent_id) {
        usedAgentIds.add(transcriptEntry.db_agent_id);
        continue;
      }

      // 同一类型的第 i 个未使用 agent 与第 i 个转录本对应。
      if (i < agentsByTypeGroup.length && !usedAgentIds.has(agentsByTypeGroup[i].id)) {
        transcriptEntry.db_agent_id = agentsByTypeGroup[i].id;
        usedAgentIds.add(agentsByTypeGroup[i].id);
      }
    }
  }

  
  for (const transcriptEntry of result) {
    delete transcriptEntry._sortTime;
  }

  
  result.sort((a, b) => {
    if (a.type === "main") return -1;
    if (b.type === "main") return 1;
    const aAgent = dbAgents.find((agent) => agent.id === a.db_agent_id);
    const bAgent = dbAgents.find((agent) => agent.id === b.db_agent_id);
    const aTime = aAgent?.started_at ? new Date(aAgent.started_at).getTime() : 0;
    const bTime = bAgent?.started_at ? new Date(bAgent.started_at).getTime() : 0;
    if (aTime && bTime) return aTime - bTime;
    if (aTime) return -1;
    if (bTime) return 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  res.json({ transcripts: result });
});

/**
 * GET /api/sessions/:id/transcript
 *
 * 读取指定会话（或子 agent）的 JSONL 转录本，返回前端可渲染的消息列表。
 *
 * 查询参数：
 * - agent_id: "main" 或子 agent id；为空时默认 main。
 * - run_id: 子 agent 的 workflow run id，用于定位嵌套目录。
 * - limit: 每次最多返回消息数，默认 50，最大 200。
 * - after / before / offset: 分页参数，按 JSONL 行号控制。
 */
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
      findSubagentTranscriptPath(req.params.id, agentId, runId);
  } else {
    jsonlPath =
      getTranscriptPath(req.params.id, session.cwd) ||
      findTranscriptPath(req.params.id);
  }

  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return res.json({ messages: [], total: 0, has_more: false, last_line: 0, first_line: 0 });
  }

  try {
    
    
    
    const messages = [];
    let lineNum = 0;
    let total = 0; 
    let hasMore = false;

    const lineReader = readline.createInterface({
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
        const systemText = typeof entry.content === "string" ? entry.content : "";
        if (!systemText.trim()) return null;
        return {
          type: "user",
          sender: "user", 
          timestamp: entry.timestamp || null,
          content: [{ type: "text", text: truncate(systemText, 10240) }],
          line: num,
        };
      }

      const assistantMessage = entry.type === "assistant" ? entry.message || {} : {};
      const content = [];

      if (entry.type === "user") {
        const messageContent = entry.message?.content;
        if (typeof messageContent === "string") {
          content.push({ type: "text", text: truncate(messageContent, 10240) });
        } else if (Array.isArray(messageContent)) {
          for (const block of messageContent) {
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
        } else if (messageContent === undefined || messageContent === null) {
          return null;
        }
      } else {
        const messageContent = assistantMessage.content || [];
        if (Array.isArray(messageContent)) {
          for (const block of messageContent) {
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
        if (assistantMessage.model) message.model = assistantMessage.model;
        if (assistantMessage.usage) {
          message.usage = {
            input_tokens: assistantMessage.usage.input_tokens || 0,
            output_tokens: assistantMessage.usage.output_tokens || 0,
            cache_read_input_tokens: assistantMessage.usage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: assistantMessage.usage.cache_creation_input_tokens || 0,
          };
        }
      }

      return message;
    }

    if (afterLine !== null) {
      // "after" 模式：返回指定行号之后的消息，用于"加载更多/新消息"。
      // foundStart 确保跳过所有 <= afterLine 的行，避免重复返回客户端已持有的内容。
      let foundStart = false;
      for await (const line of lineReader) {
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
          lineReader.close();
          lineReader.removeAllListeners();
          break;
        }
      }
      
    } else if (beforeLine !== null) {
      // "before" 模式：返回指定行号之前的消息，用于"向上翻页"查看历史。
      // 先把所有可用消息读入缓冲区，超过 limit 时保留最后 limit 条（即最接近 beforeLine 的）。
      for await (const line of lineReader) {
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
          
          lineReader.close();
          lineReader.removeAllListeners();
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
      // "offset" 模式：按消息维度跳过前 offset 条，用于无行号参考时的分页。
      let skipped = 0;
      for await (const line of lineReader) {
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
          lineReader.close();
          lineReader.removeAllListeners();
          break;
        }
      }
    } else {
      // 默认模式：返回转录本末尾的 limit 条消息（类似 tail -n limit）。
      // 超过 limit 时通过 shift() 丢弃旧消息，最终 has_more 由 total 决定。
      for await (const line of lineReader) {
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

    
    for (const message of messages) {
      delete message.line;
    }

    res.json({
      messages,
      total,
      has_more: hasMore,
      last_line: lastLine,
      first_line: firstLine,
    });
  } catch {
    res.json({ messages: [], total: 0, has_more: false, last_line: 0, first_line: 0 });
  }
});

/**
 * 从会话 metadata 中解析 turn_count。
 */
function extractTurnCount(row) {
  if (!row?.metadata) return 0;
  try {
    const metadata = JSON.parse(row.metadata);
    return typeof metadata?.turn_count === "number" ? metadata.turn_count : 0;
  } catch {
    return 0;
  }
}

/**
 * 截断长文本并在末尾追加 "[truncated]"。
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "[truncated]";
}

/**
 * 截断对象 JSON 表示，避免超大 tool_input 等污染响应。
 */
function truncateObj(obj, maxLen) {
  if (!obj) return obj;
  const json = JSON.stringify(obj);
  if (json.length <= maxLen) return obj;
  return { _truncated: truncate(json, maxLen) };
}

module.exports = router;
