// 数据库后端选择：优先 better-sqlite3（性能更好），不可用时回退到 node:sqlite（Node 22+）。
// 两者都不可用时给出明确安装/升级提示，避免运行时出现难以理解的 native 模块错误。
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  try {
    Database = require("./compat-sqlite");
  } catch {
    console.error(
      "\n" +
        "╔══════════════════════════════════════════════════════════════╗\n" +
        "║  SQLite backend not available                                ║\n" +
        "║                                                              ║\n" +
        "║  better-sqlite3 could not be loaded (native module) and      ║\n" +
        "║  node:sqlite is not available (requires Node.js >= 22).      ║\n" +
        "║                                                              ║\n" +
        "║  Fix options (pick one):                                     ║\n" +
        "║    1. Upgrade to Node.js 22+ (recommended)                   ║\n" +
        "║    2. Install Python 3 + C++ build tools, then               ║\n" +
        "║       run: npm rebuild better-sqlite3                        ║\n" +
        "╚══════════════════════════════════════════════════════════════╝\n"
    );
    process.exit(1);
  }
}
const path = require("path");
const fs = require("fs");
const { getDataDir } = require("./lib/claude-home");

// 数据库文件路径：优先使用环境变量，否则放在数据目录下。
const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(getDataDir(), "dashboard.db");
const DB_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL 模式：提高并发写入性能，避免长时间锁表。
// foreign_keys = ON：启用外键级联删除。
// busy_timeout = 5000：等待锁释放最多 5 秒，减少并发冲突。
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  -- 会话表：每个 Claude Code 会话一行。
  -- status 状态机：active -> (completed | error)。
  -- awaiting_input_since 用于 UI 显示"等待用户输入"，不表示会话终态。
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','error')),
    cwd TEXT,
    model TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    updated_at TEXT NOT NULL DEFAULT '',
    transcript_path TEXT,
    awaiting_input_since TEXT,
    metadata TEXT
  );

  -- Agent 表：每个会话有一个 main agent，可能有多个 subagent。
  -- parent_agent_id 构成嵌套调用链；ON DELETE SET NULL 避免父 agent 删除时级联误删子 agent。
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'main' CHECK(type IN ('main','subagent')),
    subagent_type TEXT,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('working','waiting','completed','error')),
    task TEXT,
    current_tool TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    updated_at TEXT NOT NULL DEFAULT '',
    parent_agent_id TEXT,
    awaiting_input_since TEXT,
    metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  -- 事件表：记录 Claude Code hook 事件。
  -- tool_use_id 用于配对 PreToolUse -> PostToolUse/PostToolUseFailure，计算工具调用成功率。
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    tool_use_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  -- Token 使用表：按 (session_id, model) 聚合，便于快速读取会话总 token。
  CREATE TABLE IF NOT EXISTS token_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'unknown',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, model),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- 基础索引：分别按单字段过滤/排序使用。
  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

  -- 复合索引：覆盖常用查询模式，减少回表。
  CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, event_type);

  -- 子 agent JSONL 导入时，需要按 agent_id + event_type 去重工具事件。
  -- 如果没有 agent_id 索引，每次去重都会触发全表扫描；在大量子 agent 重导入时
  -- 可能耗时数十秒并阻塞事件循环。该复合索引把扫描范围缩小到单个 agent 的同类事件。
  CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_agents_session_type ON agents(session_id, type);
  CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);

  -- 部分索引：只看 active 且有转录本路径的会话，供看门狗和同步扫描使用。
  CREATE INDEX IF NOT EXISTS idx_sessions_active_tp ON sessions(status, transcript_path)
    WHERE status='active' AND transcript_path IS NOT NULL;
`);

// 启动修复：如果某会话已经是 completed/error，但其下的 agent 仍标记为 working/waiting，
// 则把这些 agent 也改为 completed。防止服务异常退出后状态不一致。
db.prepare(
  `
  UPDATE agents SET
    status = 'completed',
    ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE status IN ('working', 'waiting')
    AND session_id IN (SELECT id FROM sessions WHERE status IN ('completed', 'error'))
`
).run();

const stmts = {
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  insertSession: db.prepare(
    "INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)"
  ),
  updateSession: db.prepare(
    "UPDATE sessions SET name = COALESCE(?, name), status = COALESCE(?, status), ended_at = COALESCE(?, ended_at), metadata = COALESCE(?, metadata), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  reactivateSession: db.prepare(
    "UPDATE sessions SET status = 'active', ended_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),

  updateSessionModel: db.prepare(
    "UPDATE sessions SET model = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND COALESCE(model, '') != ?"
  ),

  updateSessionName: db.prepare(
    "UPDATE sessions SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND COALESCE(name, '') != ?"
  ),

  setSessionTranscriptPath: db.prepare(
    "UPDATE sessions SET transcript_path = ? WHERE id = ? AND (transcript_path IS NULL OR transcript_path = '')"
  ),

  getAgent: db.prepare("SELECT * FROM agents WHERE id = ?"),
  listAgents: db.prepare("SELECT * FROM agents ORDER BY started_at DESC LIMIT ? OFFSET ?"),
  listAgentsBySession: db.prepare(
    "SELECT * FROM agents WHERE session_id = ? ORDER BY started_at DESC"
  ),
  listAgentsByStatus: db.prepare(
    "SELECT * FROM agents WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?"
  ),
  insertAgent: db.prepare(
    "INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, started_at, updated_at, parent_agent_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)"
  ),
  updateAgent: db.prepare(
    "UPDATE agents SET name = COALESCE(?, name), status = COALESCE(?, status), task = COALESCE(?, task), current_tool = ?, ended_at = COALESCE(?, ended_at), metadata = COALESCE(?, metadata), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  reactivateAgent: db.prepare(
    "UPDATE agents SET status = 'working', ended_at = NULL, current_tool = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),

  setAgentParent: db.prepare(
    "UPDATE agents SET parent_agent_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),

  setSessionAwaitingInput: db.prepare(
    "UPDATE sessions SET awaiting_input_since = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  clearSessionAwaitingInput: db.prepare(
    "UPDATE sessions SET awaiting_input_since = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND awaiting_input_since IS NOT NULL"
  ),
  setAgentAwaitingInput: db.prepare(
    "UPDATE agents SET awaiting_input_since = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),
  clearSessionAgentsAwaitingInput: db.prepare(
    "UPDATE agents SET awaiting_input_since = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ? AND awaiting_input_since IS NOT NULL"
  ),

  // 递归 CTE：从每个 session 的根 agent 出发，沿 parent_agent_id 找到嵌套最深的、
  // 状态为 working 的子 agent。用于把工具调用事件正确归因到实际执行的子 agent。
  findDeepestWorkingAgent: db.prepare(`
    WITH RECURSIVE agent_depth AS (
      SELECT id, parent_agent_id, 0 as depth
      FROM agents
      WHERE session_id = ? AND parent_agent_id IS NULL
      UNION ALL
      SELECT a.id, a.parent_agent_id, ad.depth + 1
      FROM agents a
      JOIN agent_depth ad ON a.parent_agent_id = ad.id
      WHERE a.session_id = ?
    )
    SELECT ad.id, ad.depth
    FROM agent_depth ad
    JOIN agents a ON a.id = ad.id
    WHERE a.status = 'working' AND a.type = 'subagent'
    ORDER BY ad.depth DESC, a.started_at DESC
    LIMIT 1
  `),

  touchSession: db.prepare(
    "UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ),

  insertEvent: db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ),
  listEventsBySession: db.prepare(
    "SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC, id DESC"
  ),

  countEventsToday: db.prepare(
    "SELECT COUNT(*) as count FROM events WHERE datetime(created_at) >= datetime('now', ?, 'start of day', ?)"
  ),

  countSessionsToday: db.prepare(
    "SELECT COUNT(*) as count FROM sessions WHERE datetime(started_at) >= datetime('now', ?, 'start of day', ?)"
  ),

  countTokensToday: db.prepare(
    `SELECT COALESCE(SUM(tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_write_tokens), 0) as total
     FROM token_usage tu JOIN sessions s ON s.id = tu.session_id
     WHERE datetime(s.started_at) >= datetime('now', ?, 'start of day', ?)`
  ),

  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) as total_sessions,
      (SELECT COUNT(*) FROM sessions WHERE status = 'active') as active_sessions,
      (SELECT COUNT(*) FROM agents WHERE status IN ('working', 'waiting')) as active_agents,
      (SELECT COUNT(*) FROM agents) as total_agents,
      (SELECT COUNT(*) FROM events) as total_events,
      (SELECT COUNT(DISTINCT cwd) FROM sessions WHERE cwd IS NOT NULL AND cwd != '') as total_projects,
      COALESCE(
        (SELECT AVG(CAST(strftime('%s', ended_at) - strftime('%s', started_at) AS REAL))
         FROM sessions
         WHERE ended_at IS NOT NULL AND started_at IS NOT NULL),
        0
      ) as avg_session_duration_seconds,
      CASE WHEN (SELECT COUNT(*) FROM sessions) > 0
        THEN CAST((SELECT COUNT(*) FROM agents) AS REAL) / (SELECT COUNT(*) FROM sessions)
        ELSE 0
      END as avg_agents_per_session
  `),
  agentStatusCounts: db.prepare("SELECT status, COUNT(*) as count FROM agents GROUP BY status"),
  agentTypeCounts: db.prepare("SELECT type, COUNT(*) as count FROM agents GROUP BY type"),
  subagentTypeCounts: db.prepare("SELECT subagent_type, COUNT(*) as count FROM agents WHERE subagent_type IS NOT NULL AND subagent_type != '' GROUP BY subagent_type ORDER BY count DESC"),
  sessionStatusCounts: db.prepare("SELECT status, COUNT(*) as count FROM sessions GROUP BY status"),

  replaceTokenUsage: db.prepare(`
    INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, model) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens
  `),
  getTokenTotals: db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_write_tokens), 0) as total_cache_write
    FROM token_usage
  `),

  toolUsageCounts: db.prepare(`
    SELECT
      COALESCE(p.tool_name, f.tool_name) as tool_name,
      COALESCE(p.count, 0) as count,
      COALESCE(f.failures, 0) as failures
    FROM (
      SELECT tool_name, COUNT(*) as count
      FROM events
      WHERE event_type = 'PreToolUse' AND tool_name IS NOT NULL
      GROUP BY tool_name
    ) p
    LEFT JOIN (
      SELECT tool_name, COUNT(*) as failures
      FROM events
      WHERE event_type = 'PostToolUseFailure' AND tool_name IS NOT NULL
      GROUP BY tool_name
    ) f ON p.tool_name = f.tool_name
    ORDER BY count DESC
    LIMIT 20
  `),

  // 工具平均耗时：为每个 PreToolUse 找到同一 session 中同 tool_name 的下一个
  // PostToolUse/PostToolUseFailure 事件，用 julianday 差值计算毫秒耗时。
  // HAVING 过滤 0~300000ms（5 分钟）避免异常数据影响平均值。
  toolAvgDurations: db.prepare(`
    SELECT tool_name,
           AVG(duration_ms) as avg_duration_ms
    FROM (
      SELECT p.tool_name,
             CAST(
               (julianday(MIN(e.created_at)) - julianday(p.created_at)) * 86400000
               AS INTEGER
             ) as duration_ms
      FROM events p
      JOIN events e ON e.session_id = p.session_id
        AND e.event_type IN ('PostToolUse', 'PostToolUseFailure')
        AND e.tool_name = p.tool_name
        AND e.created_at > p.created_at
      WHERE p.event_type = 'PreToolUse'
        AND p.tool_name IS NOT NULL AND p.tool_name != ''
      GROUP BY p.id
      HAVING duration_ms BETWEEN 0 AND 300000
    )
    GROUP BY tool_name
  `),

  dailySessionCounts: db.prepare(`
    SELECT DATE(started_at, ?) as date, COUNT(*) as count
    FROM sessions
    WHERE started_at >= DATE('now', '-365 days')
    GROUP BY 1
    ORDER BY date ASC
  `),
  dailySessionStatusCounts: db.prepare(`
    SELECT DATE(started_at, ?) as date, status, COUNT(*) as count
    FROM sessions
    WHERE started_at >= DATE('now', '-365 days')
    GROUP BY 1, 2
    ORDER BY date ASC
  `),
  dailyTokenCounts: db.prepare(`
    SELECT DATE(s.started_at, ?) as date,
      COALESCE(SUM(tu.input_tokens), 0) as input_tokens,
      COALESCE(SUM(tu.output_tokens), 0) as output_tokens,
      COALESCE(SUM(tu.cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(tu.cache_write_tokens), 0) as cache_write_tokens
    FROM sessions s
    LEFT JOIN token_usage tu ON tu.session_id = s.id
    WHERE s.started_at >= DATE('now', '-30 days')
    GROUP BY 1
    ORDER BY date ASC
  `),

  sessionEventCount: db.prepare("SELECT COUNT(*) as count FROM events WHERE session_id = ?"),
  sessionUserPromptCount: db.prepare(
    "SELECT COUNT(*) as count FROM events WHERE session_id = ? AND event_type = 'UserPromptSubmit'",
  ),
  sessionToolUsageCounts: db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM events
    WHERE session_id = ? AND event_type = 'PreToolUse' AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
  `),

  // 工具调用统计：以 PreToolUse 为"尝试"，用 tool_use_id 左连接对应的
  // PostToolUse（成功）和 PostToolUseFailure（失败）。
  // 使用 COUNT(DISTINCT tool_use_id) 避免同一 tool_use_id 出现多个 PostToolUse 时重复计数。
  sessionToolCallCounts: db.prepare(`
    SELECT
      COUNT(DISTINCT p.tool_use_id) as attempts,
      COUNT(DISTINCT CASE WHEN s.event_type IS NOT NULL THEN p.tool_use_id END) as success,
      COUNT(DISTINCT CASE WHEN f.event_type IS NOT NULL THEN p.tool_use_id END) as failed
    FROM events p
    LEFT JOIN events s ON s.tool_use_id = p.tool_use_id AND s.event_type = 'PostToolUse'
    LEFT JOIN events f ON f.tool_use_id = p.tool_use_id AND f.event_type = 'PostToolUseFailure'
    WHERE p.session_id = ? AND p.event_type = 'PreToolUse' AND p.tool_use_id IS NOT NULL
  `),

  sessionEventTimeRange: db.prepare(`
    SELECT MIN(created_at) as first_at, MAX(created_at) as last_at
    FROM events
    WHERE session_id = ?
  `),
  sessionAgentStatusCounts: db.prepare(`
    SELECT status, COUNT(*) as count
    FROM agents
    WHERE session_id = ?
    GROUP BY status
  `),
  sessionTokenTotals: db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens
    FROM token_usage
    WHERE session_id = ?
  `),
};

/**
 * 清理孤儿会话：当会话的转录本或 cwd 目录已经不存在时，认为该会话已被用户外部删除，
 * 从数据库中移除并清理相关文件。同时删除 ~/.claude/projects 下的空目录。
 *
 * 注意：该函数在每个 /api 请求（除 hooks 外）时被调用，作为轻量级清理。
 */
function cleanupOrphanedSessions() {
  const fs = require("fs");
  const path = require("path");
  try {
    const rows = db
      .prepare("SELECT id, cwd, transcript_path FROM sessions")
      .all()
      .filter((row) => {
        if (row.transcript_path && !fs.existsSync(row.transcript_path)) return true;
        if (row.cwd && !fs.existsSync(row.cwd)) return true;
        return false;
      });

    let removed = 0;
    const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
    for (const row of rows) {
      deleteSession.run(row.id);
      if (row.transcript_path) {
        try { fs.unlinkSync(row.transcript_path); } catch {}
        const sessDir = path.join(path.dirname(row.transcript_path), row.id);
        try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch {}
      }
      removed++;
    }
    if (removed > 0) console.log(`[cleanup] removed ${removed} orphaned session(s)`);

    // 删除空 project 目录，保持 ~/.claude/projects 整洁。
    const { getProjectsDir } = require("./lib/claude-home");
    const projectsDir = getProjectsDir();
    if (fs.existsSync(projectsDir)) {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(projectsDir, entry.name);
        try {
          if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
        } catch {}
      }
    }
  } catch {
    // 清理失败不影响主业务，静默忽略。
  }
}

module.exports = { db, stmts, DB_PATH, cleanupOrphanedSessions };
