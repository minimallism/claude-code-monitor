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

function migrateLegacyDatabase(targetPath) {
  try {
    
    if (process.env.DASHBOARD_DB_PATH || process.env.DASHBOARD_DATA_DIR) return;
    if (fs.existsSync(targetPath)) return; 

    const candidates = [
      path.join(__dirname, "..", "data", "dashboard.db"), 
    ].filter((p) => p && fs.existsSync(p));
    if (candidates.length === 0) return;

    const source = candidates
      .map((p) => ({ p, size: fs.statSync(p).size }))
      .sort((a, b) => b.size - a.size)[0].p;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    
    
    
    
    
    
    
    const src = new Database(source);
    try {
      src.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }

    const srcMarker = path.join(path.dirname(source), ".legacy-import.done");
    const dstMarker = path.join(path.dirname(targetPath), ".legacy-import.done");
    if (fs.existsSync(srcMarker) && !fs.existsSync(dstMarker)) {
      try {
        fs.copyFileSync(srcMarker, dstMarker);
      } catch {

      }
    }

    console.log(`[db] migrated existing database → ${targetPath} (from ${source})`);
  } catch (err) {
    
    
    
    
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(targetPath + suffix, { force: true });
      } catch {
        
      }
    }
    console.warn("[db] legacy database migration skipped:", err?.message || err);
  }
}

const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(getDataDir(), "dashboard.db");
const DB_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DB_DIR, { recursive: true });

migrateLegacyDatabase(DB_PATH);

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','error','abandoned')),
    cwd TEXT,
    model TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    metadata TEXT
  );

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
    parent_agent_id TEXT,
    metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    summary TEXT,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'unknown',
    -- Pricing dimensions: tokens are bucketed by these because each changes the
    -- per-token RATE (fast mode, US data residency, Batch API). Defaults match
    -- the standard/global/standard rate so historical rows price unchanged.
    speed TEXT NOT NULL DEFAULT 'standard',
    inference_geo TEXT NOT NULL DEFAULT 'global',
    service_tier TEXT NOT NULL DEFAULT 'standard',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    -- Subset of cache_write_tokens stored at the 1h tier; 5m = total - 1h.
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    -- Server-tool request counts (billed separately from tokens).
    web_search_requests INTEGER NOT NULL DEFAULT 0,
    web_fetch_requests INTEGER NOT NULL DEFAULT 0,
    code_execution_requests INTEGER NOT NULL DEFAULT 0,
    -- Compaction baselines preserve pre-rewrite totals (effective = current + baseline).
    baseline_input INTEGER NOT NULL DEFAULT 0,
    baseline_output INTEGER NOT NULL DEFAULT 0,
    baseline_cache_read INTEGER NOT NULL DEFAULT 0,
    baseline_cache_write INTEGER NOT NULL DEFAULT 0,
    baseline_cache_write_1h INTEGER NOT NULL DEFAULT 0,
    baseline_web_search INTEGER NOT NULL DEFAULT 0,
    baseline_web_fetch INTEGER NOT NULL DEFAULT 0,
    baseline_code_execution INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, model, speed, inference_geo, service_tier),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS model_pricing (
    model_pattern TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    input_per_mtok REAL NOT NULL DEFAULT 0,
    output_per_mtok REAL NOT NULL DEFAULT 0,
    cache_read_per_mtok REAL NOT NULL DEFAULT 0,
    cache_write_per_mtok REAL NOT NULL DEFAULT 0,
    cache_write_1h_per_mtok REAL NOT NULL DEFAULT 0,
    -- Fast mode (research preview) premium input/output rates; 0 = no fast pricing.
    -- Cache rates in fast mode are derived from fast_input via the standard
    -- caching multipliers (see server/lib/pricing-constants.js).
    fast_input_per_mtok REAL NOT NULL DEFAULT 0,
    fast_output_per_mtok REAL NOT NULL DEFAULT 0,
    -- Time-limited introductory rates. When intro_until is set, usage on/before
    -- that date (YYYY-MM-DD) is priced at the intro_* rates and usage after it at
    -- the standard rates — so promo pricing (e.g. Claude Sonnet 5's launch
    -- discount through 2026-08-31) stays correct for historical and future usage
    -- at all times. 0 / NULL means "no intro rate" → standard rates always apply.
    intro_input_per_mtok REAL NOT NULL DEFAULT 0,
    intro_output_per_mtok REAL NOT NULL DEFAULT 0,
    intro_cache_read_per_mtok REAL NOT NULL DEFAULT 0,
    intro_cache_write_per_mtok REAL NOT NULL DEFAULT 0,
    intro_cache_write_1h_per_mtok REAL NOT NULL DEFAULT 0,
    intro_until TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

  -- Composite indexes for frequent query patterns (columns that exist at table creation time)
  CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, event_type);
  -- Subagent JSONL import dedups each tool event with
  -- "WHERE agent_id = ? AND event_type = ? AND data LIKE '%tool_use_id%'".
  -- Without an agent_id index that is a full events-table scan per tool event;
  -- on a large DB a single re-import (e.g. the startup sync sweep re-touching a
  -- session with many subagents) becomes tens of seconds and blocks the event
  -- loop. This composite narrows each dedup to the agent's events of that type.
  CREATE INDEX IF NOT EXISTS idx_events_agent_type ON events(agent_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_agents_session_type ON agents(session_id, type);

  -- Workflow-tool runs: fleets of sub-agents spawned by the Claude Code
  -- "Workflow" tool (and self-paced /loop). These emit NO hooks; the source of
  -- truth is the on-disk run journal (~/.claude/projects/<enc-cwd>/<sessionId>/
  -- workflows/wf_<runId>.json), written at workflow COMPLETION. A row is keyed
  -- by run_id, parented to the launching session. status is an open string
  -- (running | completed | error | failed | …) — intentionally no CHECK, so new
  -- harness states never trip a stale constraint. phases/progress hold the
  -- journal's phases[] / workflowProgress[] arrays verbatim (JSON) for detail
  -- rendering; the inner agents are linked via agents.workflow_run_id.
  CREATE TABLE IF NOT EXISTS workflows (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    default_model TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    agent_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_tool_calls INTEGER NOT NULL DEFAULT 0,
    phases TEXT,
    progress TEXT,
    script_path TEXT,
    journal_path TEXT,
    source TEXT NOT NULL DEFAULT 'journal',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workflows_session ON workflows(session_id);
  CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
`);

try {
  db.prepare("SELECT workflow_run_id FROM agents LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE agents ADD COLUMN workflow_run_id TEXT").run();
  db.prepare("ALTER TABLE agents ADD COLUMN workflow_phase TEXT").run();
}
db.prepare("CREATE INDEX IF NOT EXISTS idx_agents_workflow ON agents(workflow_run_id)").run();

try {
  db.prepare("SELECT cache_write_1h_per_mtok FROM model_pricing LIMIT 1").get();
} catch {
  db.prepare(
    "ALTER TABLE model_pricing ADD COLUMN cache_write_1h_per_mtok REAL NOT NULL DEFAULT 0"
  ).run();
  db.prepare(
    `UPDATE model_pricing
     SET cache_write_1h_per_mtok = CASE
       WHEN input_per_mtok > 0 THEN input_per_mtok * 2
       WHEN cache_write_per_mtok > 0 THEN cache_write_per_mtok * 1.6
       ELSE 0
     END
     WHERE cache_write_1h_per_mtok = 0`
  ).run();
}

try {
  db.prepare("SELECT fast_input_per_mtok FROM model_pricing LIMIT 1").get();
} catch {
  db.prepare(
    "ALTER TABLE model_pricing ADD COLUMN fast_input_per_mtok REAL NOT NULL DEFAULT 0"
  ).run();
  db.prepare(
    "ALTER TABLE model_pricing ADD COLUMN fast_output_per_mtok REAL NOT NULL DEFAULT 0"
  ).run();
  const setFast = db.prepare(
    "UPDATE model_pricing SET fast_input_per_mtok = ?, fast_output_per_mtok = ? WHERE model_pattern = ? AND fast_input_per_mtok = 0"
  );
  setFast.run(10, 50, "claude-opus-4-8%");
  setFast.run(30, 150, "claude-opus-4-7%");
  setFast.run(30, 150, "claude-opus-4-6%");
}

try {
  db.prepare("SELECT intro_until FROM model_pricing LIMIT 1").get();
} catch {
  for (const col of [
    "intro_input_per_mtok",
    "intro_output_per_mtok",
    "intro_cache_read_per_mtok",
    "intro_cache_write_per_mtok",
    "intro_cache_write_1h_per_mtok",
  ]) {
    db.prepare(`ALTER TABLE model_pricing ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`).run();
  }
  db.prepare("ALTER TABLE model_pricing ADD COLUMN intro_until TEXT").run();
}

try {
  db.prepare("SELECT model FROM token_usage LIMIT 1").get();
} catch {
  
  db.pragma("foreign_keys = OFF");
  db.prepare("ALTER TABLE token_usage RENAME TO token_usage_old").run();
  db.prepare(
    `
    CREATE TABLE token_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, model),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `
  ).run();
  db.prepare(
    `
    INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      SELECT tu.session_id, COALESCE(s.model, 'unknown'), tu.input_tokens, tu.output_tokens, tu.cache_read_tokens, tu.cache_write_tokens
      FROM token_usage_old tu LEFT JOIN sessions s ON s.id = tu.session_id
  `
  ).run();
  db.prepare("DROP TABLE token_usage_old").run();
  db.pragma("foreign_keys = ON");
}

try {
  db.prepare("SELECT updated_at FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run();
  db.prepare("UPDATE sessions SET updated_at = COALESCE(ended_at, started_at)").run();
}
try {
  db.prepare("SELECT updated_at FROM agents LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE agents ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run();
  db.prepare("UPDATE agents SET updated_at = COALESCE(ended_at, started_at)").run();
}

db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC)`
);

try {
  db.prepare("SELECT awaiting_input_since FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN awaiting_input_since TEXT").run();
}
try {
  db.prepare("SELECT awaiting_input_since FROM agents LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE agents ADD COLUMN awaiting_input_since TEXT").run();
}

try {
  db.prepare("SELECT transcript_path FROM sessions LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE sessions ADD COLUMN transcript_path TEXT").run();
  
  
  
  
  
  
  db.prepare(
    `UPDATE sessions SET transcript_path = (
       SELECT json_extract(e.data, '$.transcript_path')
       FROM events e
       WHERE e.session_id = sessions.id
         AND json_valid(e.data) = 1
         AND json_extract(e.data, '$.transcript_path') IS NOT NULL
       LIMIT 1
     ) WHERE transcript_path IS NULL`
  ).run();
}

db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sessions_active_tp
   ON sessions(status, transcript_path)
   WHERE status='active' AND transcript_path IS NOT NULL`
);

{
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'")
    .get();
  if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'idle'")) {
    
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      -- Map old statuses to new ones in-place (still valid under old constraint isn't needed
      -- because we're about to drop the table — we do it in the INSERT below)
      CREATE TABLE agents_new (
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
        parent_agent_id TEXT,
        metadata TEXT,
        updated_at TEXT NOT NULL DEFAULT '',
        awaiting_input_since TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
      );
      INSERT INTO agents_new SELECT
        id, session_id, name, type, subagent_type,
        CASE status
          WHEN 'idle' THEN 'waiting'
          WHEN 'connected' THEN 'working'
          ELSE status
        END,
        task, current_tool, started_at, ended_at, parent_agent_id, metadata,
        updated_at, awaiting_input_since
      FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_new RENAME TO agents;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    `);
  }
}

try {
  db.prepare("SELECT baseline_input FROM token_usage LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE token_usage ADD COLUMN baseline_input INTEGER NOT NULL DEFAULT 0").run();
  db.prepare("ALTER TABLE token_usage ADD COLUMN baseline_output INTEGER NOT NULL DEFAULT 0").run();
  db.prepare(
    "ALTER TABLE token_usage ADD COLUMN baseline_cache_read INTEGER NOT NULL DEFAULT 0"
  ).run();
  db.prepare(
    "ALTER TABLE token_usage ADD COLUMN baseline_cache_write INTEGER NOT NULL DEFAULT 0"
  ).run();
}

try {
  db.prepare("SELECT speed FROM token_usage LIMIT 1").get();
} catch {
  db.pragma("foreign_keys = OFF");
  db.prepare("ALTER TABLE token_usage RENAME TO token_usage_pre_modifiers").run();
  db.prepare(
    `
    CREATE TABLE token_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      speed TEXT NOT NULL DEFAULT 'standard',
      inference_geo TEXT NOT NULL DEFAULT 'global',
      service_tier TEXT NOT NULL DEFAULT 'standard',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      web_search_requests INTEGER NOT NULL DEFAULT 0,
      web_fetch_requests INTEGER NOT NULL DEFAULT 0,
      code_execution_requests INTEGER NOT NULL DEFAULT 0,
      baseline_input INTEGER NOT NULL DEFAULT 0,
      baseline_output INTEGER NOT NULL DEFAULT 0,
      baseline_cache_read INTEGER NOT NULL DEFAULT 0,
      baseline_cache_write INTEGER NOT NULL DEFAULT 0,
      baseline_cache_write_1h INTEGER NOT NULL DEFAULT 0,
      baseline_web_search INTEGER NOT NULL DEFAULT 0,
      baseline_web_fetch INTEGER NOT NULL DEFAULT 0,
      baseline_code_execution INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, model, speed, inference_geo, service_tier),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `
  ).run();
  db.prepare(
    `
    INSERT INTO token_usage (session_id, model, speed, inference_geo, service_tier,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      baseline_input, baseline_output, baseline_cache_read, baseline_cache_write)
    SELECT session_id, model, 'standard', 'global', 'standard',
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      baseline_input, baseline_output, baseline_cache_read, baseline_cache_write
    FROM token_usage_pre_modifiers
  `
  ).run();
  db.prepare("DROP TABLE token_usage_pre_modifiers").run();
  db.pragma("foreign_keys = ON");
}

db.prepare(
  `
  UPDATE sessions SET
    status = 'completed',
    ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE status = 'active'
    AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    AND NOT EXISTS (
      SELECT 1 FROM events e
      WHERE e.session_id = sessions.id
        AND e.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    )
`
).run();

db.prepare(
  `
  UPDATE agents SET
    status = 'completed',
    ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE status IN ('working', 'waiting')
    AND session_id IN (SELECT id FROM sessions WHERE status IN ('completed', 'error', 'abandoned'))
`
).run();

db.prepare(
  `
  UPDATE agents SET
    started_at = ended_at,
    updated_at = ended_at
  WHERE subagent_type = 'compaction'
    AND ended_at IS NOT NULL
    AND julianday(ended_at) < julianday(started_at)
`
).run();

const stmts = {
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  listSessions: db.prepare(
    `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity
     FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
     GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
  ),
  listSessionsByStatus: db.prepare(
    `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity
     FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
     WHERE s.status = ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
  ),
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
  clearAgentAwaitingInput: db.prepare(
    "UPDATE agents SET awaiting_input_since = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND awaiting_input_since IS NOT NULL"
  ),
  clearSessionAgentsAwaitingInput: db.prepare(
    "UPDATE agents SET awaiting_input_since = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ? AND awaiting_input_since IS NOT NULL"
  ),
  
  
  
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
  findStaleSessions: db.prepare(
    `SELECT id FROM sessions
     WHERE status = 'active' AND id != ?
       AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' minutes')`
  ),

  insertEvent: db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ),
  listEvents: db.prepare("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"),
  listEventsBySession: db.prepare(
    "SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC, id DESC"
  ),
  countEvents: db.prepare("SELECT COUNT(*) as count FROM events"),
  countEventsSince: db.prepare("SELECT COUNT(*) as count FROM events WHERE created_at >= ?"),
  
  
  countEventsToday: db.prepare(
    "SELECT COUNT(*) as count FROM events WHERE created_at >= datetime('now', ?, 'start of day', ?)"
  ),

  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) as total_sessions,
      (SELECT COUNT(*) FROM sessions WHERE status = 'active') as active_sessions,
      (SELECT COUNT(*) FROM agents WHERE status IN ('working', 'waiting')) as active_agents,
      (SELECT COUNT(*) FROM agents) as total_agents,
      (SELECT COUNT(*) FROM events) as total_events
  `),
  agentStatusCounts: db.prepare("SELECT status, COUNT(*) as count FROM agents GROUP BY status"),
  sessionStatusCounts: db.prepare("SELECT status, COUNT(*) as count FROM sessions GROUP BY status"),

  
  
  upsertTokenUsage: db.prepare(`
    INSERT INTO token_usage (session_id, model, speed, inference_geo, service_tier,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?, ?, 'standard', 'global', 'standard', ?, ?, ?, ?)
    ON CONFLICT(session_id, model, speed, inference_geo, service_tier) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens
  `),
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  replaceTokenUsage: db.prepare(`
    INSERT INTO token_usage (session_id, model, speed, inference_geo, service_tier,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
                             web_search_requests, web_fetch_requests, code_execution_requests,
                             baseline_input, baseline_output, baseline_cache_read, baseline_cache_write, baseline_cache_write_1h,
                             baseline_web_search, baseline_web_fetch, baseline_code_execution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)
    ON CONFLICT(session_id, model, speed, inference_geo, service_tier) DO UPDATE SET
      baseline_input = MAX(input_tokens + baseline_input - excluded.input_tokens, 0),
      baseline_output = MAX(output_tokens + baseline_output - excluded.output_tokens, 0),
      baseline_cache_read = MAX(cache_read_tokens + baseline_cache_read - excluded.cache_read_tokens, 0),
      baseline_cache_write = MAX(cache_write_tokens + baseline_cache_write - excluded.cache_write_tokens, 0),
      baseline_cache_write_1h = MAX(cache_write_1h_tokens + baseline_cache_write_1h - excluded.cache_write_1h_tokens, 0),
      baseline_web_search = MAX(web_search_requests + baseline_web_search - excluded.web_search_requests, 0),
      baseline_web_fetch = MAX(web_fetch_requests + baseline_web_fetch - excluded.web_fetch_requests, 0),
      baseline_code_execution = MAX(code_execution_requests + baseline_code_execution - excluded.code_execution_requests, 0),
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cache_write_1h_tokens = excluded.cache_write_1h_tokens,
      web_search_requests = excluded.web_search_requests,
      web_fetch_requests = excluded.web_fetch_requests,
      code_execution_requests = excluded.code_execution_requests
  `),
  getTokenTotals: db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + baseline_input), 0) as total_input,
      COALESCE(SUM(output_tokens + baseline_output), 0) as total_output,
      COALESCE(SUM(cache_read_tokens + baseline_cache_read), 0) as total_cache_read,
      COALESCE(SUM(cache_write_tokens + baseline_cache_write), 0) as total_cache_write,
      COALESCE(SUM(cache_write_1h_tokens + baseline_cache_write_1h), 0) as total_cache_write_1h,
      COALESCE(SUM(web_search_requests + baseline_web_search), 0) as total_web_search,
      COALESCE(SUM(web_fetch_requests + baseline_web_fetch), 0) as total_web_fetch,
      COALESCE(SUM(code_execution_requests + baseline_code_execution), 0) as total_code_execution
    FROM token_usage
  `),
  getTokensBySession: db.prepare(
    `SELECT model, speed, inference_geo, service_tier,
      input_tokens + baseline_input as input_tokens,
      output_tokens + baseline_output as output_tokens,
      cache_read_tokens + baseline_cache_read as cache_read_tokens,
      cache_write_tokens + baseline_cache_write as cache_write_tokens,
      cache_write_1h_tokens + baseline_cache_write_1h as cache_write_1h_tokens,
      web_search_requests + baseline_web_search as web_search_requests,
      web_fetch_requests + baseline_web_fetch as web_fetch_requests,
      code_execution_requests + baseline_code_execution as code_execution_requests
    FROM token_usage WHERE session_id = ?`
  ),

  
  listPricing: db.prepare("SELECT * FROM model_pricing ORDER BY display_name ASC"),
  matchPricing: db.prepare(
    "SELECT * FROM model_pricing WHERE ? LIKE REPLACE(model_pattern, '%', '%') LIMIT 1"
  ),
  toolUsageCounts: db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM events
    WHERE tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 20
  `),
  
  dailyEventCounts: db.prepare(`
    SELECT DATE(created_at, ?) as date, COUNT(*) as count
    FROM events
    WHERE created_at >= DATE('now', '-365 days')
    GROUP BY 1
    ORDER BY date ASC
  `),
  dailySessionCounts: db.prepare(`
    SELECT DATE(started_at, ?) as date, COUNT(*) as count
    FROM sessions
    WHERE started_at >= DATE('now', '-365 days')
    GROUP BY 1
    ORDER BY date ASC
  `),
  totalSubagentCount: db.prepare("SELECT COUNT(*) as count FROM agents WHERE type = 'subagent'"),
  eventTypeCounts: db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM events
    GROUP BY event_type
    ORDER BY count DESC
  `),
  avgEventsPerSession: db.prepare(`
    SELECT ROUND(CAST(COUNT(*) AS REAL) / MAX(1, (SELECT COUNT(*) FROM sessions)), 1) as avg
    FROM events
  `),

  
  sessionEventCount: db.prepare("SELECT COUNT(*) as count FROM events WHERE session_id = ?"),
  sessionEventTypeCounts: db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM events
    WHERE session_id = ?
    GROUP BY event_type
    ORDER BY count DESC
  `),
  sessionToolUsageCounts: db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM events
    WHERE session_id = ? AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT 15
  `),
  
  
  
  sessionErrorCount: db.prepare(`
    SELECT COUNT(*) as count
    FROM events
    WHERE session_id = ?
      AND (
        LOWER(event_type) LIKE '%error%'
        OR LOWER(event_type) LIKE '%failed%'
        OR LOWER(summary) LIKE 'error%'
        OR LOWER(summary) LIKE 'failed%'
      )
  `),
  sessionEventTimeRange: db.prepare(`
    SELECT MIN(created_at) as first_at, MAX(created_at) as last_at
    FROM events
    WHERE session_id = ?
  `),
  sessionAgentTypeCounts: db.prepare(`
    SELECT
      COALESCE(subagent_type, 'unknown') as subagent_type,
      COUNT(*) as count
    FROM agents
    WHERE session_id = ? AND type = 'subagent'
    GROUP BY COALESCE(subagent_type, 'unknown')
    ORDER BY count DESC
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

  
  
  
  
  upsertWorkflow: db.prepare(
    `INSERT INTO workflows
       (run_id, session_id, task_id, name, status, default_model, started_at, ended_at,
        duration_ms, agent_count, total_tokens, total_tool_calls, phases, progress,
        script_path, journal_path, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(run_id) DO UPDATE SET
       session_id = excluded.session_id,
       task_id = COALESCE(excluded.task_id, workflows.task_id),
       name = COALESCE(excluded.name, workflows.name),
       status = excluded.status,
       default_model = COALESCE(excluded.default_model, workflows.default_model),
       started_at = COALESCE(workflows.started_at, excluded.started_at),
       ended_at = excluded.ended_at,
       duration_ms = excluded.duration_ms,
       agent_count = excluded.agent_count,
       total_tokens = excluded.total_tokens,
       total_tool_calls = excluded.total_tool_calls,
       phases = COALESCE(excluded.phases, workflows.phases),
       progress = COALESCE(excluded.progress, workflows.progress),
       script_path = COALESCE(excluded.script_path, workflows.script_path),
       journal_path = COALESCE(excluded.journal_path, workflows.journal_path),
       source = excluded.source,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ),
  getWorkflow: db.prepare("SELECT * FROM workflows WHERE run_id = ?"),
  listWorkflowsBySession: db.prepare(
    "SELECT * FROM workflows WHERE session_id = ? ORDER BY started_at DESC, created_at DESC"
  ),
  listWorkflows: db.prepare(
    "SELECT * FROM workflows ORDER BY COALESCE(started_at, created_at) DESC LIMIT ? OFFSET ?"
  ),
  listWorkflowsByStatus: db.prepare(
    "SELECT * FROM workflows WHERE status = ? ORDER BY COALESCE(started_at, created_at) DESC LIMIT ? OFFSET ?"
  ),
  listWorkflowsBySessionFilter: db.prepare(
    "SELECT * FROM workflows WHERE session_id = ? ORDER BY COALESCE(started_at, created_at) DESC LIMIT ? OFFSET ?"
  ),
  countWorkflows: db.prepare("SELECT COUNT(*) AS n FROM workflows"),
  countWorkflowsByStatus: db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE status = ?"),
  workflowStatusCounts: db.prepare("SELECT status, COUNT(*) AS n FROM workflows GROUP BY status"),
  setAgentWorkflow: db.prepare(
    "UPDATE agents SET workflow_run_id = ?, workflow_phase = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ),
  listAgentsByWorkflow: db.prepare(
    "SELECT * FROM agents WHERE workflow_run_id = ? ORDER BY started_at ASC, id ASC"
  ),
};

module.exports = { db, stmts, DB_PATH };
