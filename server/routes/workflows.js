const { Router } = require("express");
const { db, stmts } = require("../db");

const router = Router();

function durationSec(s) {
  if (!s.started_at) return 0;
  const end = s.ended_at || new Date().toISOString();
  return Math.max(0, (new Date(end) - new Date(s.started_at)) / 1000);
}

router.get("/", (req, res) => {
  try {
    
    const statusFilter = req.query.status || null;
    const data = {
      orchestration: getOrchestrationData(statusFilter),
      toolFlow: getToolFlowData(statusFilter),
      effectiveness: getSubagentEffectiveness(statusFilter),
      patterns: getWorkflowPatterns(statusFilter),
      modelDelegation: getModelDelegation(statusFilter),
      errorPropagation: getErrorPropagation(statusFilter),
      concurrency: getConcurrencyData(statusFilter),
      complexity: getSessionComplexity(statusFilter),
      compaction: getCompactionImpact(statusFilter),
      cooccurrence: getAgentCooccurrence(statusFilter),
    };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

function statusClause(statusFilter, alias = "s") {
  if (!statusFilter || statusFilter === "all") return { clause: "", params: [] };
  return { clause: ` AND ${alias}.status = ?`, params: [statusFilter] };
}

function sessionIdFilter(statusFilter) {
  if (!statusFilter || statusFilter === "all") return { clause: "", params: [] };
  return {
    clause: " AND session_id IN (SELECT id FROM sessions WHERE status = ?)",
    params: [statusFilter],
  };
}

function getOrchestrationData(statusFilter) {
  const sf = sessionIdFilter(statusFilter);
  const ss = statusClause(statusFilter);

  
  const sessionCount = db
    .prepare(`SELECT COUNT(*) as c FROM sessions s WHERE 1=1${ss.clause}`)
    .get(...ss.params).c;

  
  const mainCount = db
    .prepare(`SELECT COUNT(*) as c FROM agents WHERE type = 'main'${sf.clause}`)
    .get(...sf.params).c;

  
  const subagentTypes = db
    .prepare(
      `SELECT subagent_type, COUNT(*) as count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
       FROM agents WHERE type = 'subagent' AND subagent_type IS NOT NULL${sf.clause}
       GROUP BY subagent_type ORDER BY count DESC`
    )
    .all(...sf.params);

  
  const edges = db
    .prepare(
      `SELECT
        COALESCE(p.subagent_type, 'main') as source,
        a.subagent_type as target,
        COUNT(*) as weight
       FROM agents a
       LEFT JOIN agents p ON a.parent_agent_id = p.id
       WHERE a.type = 'subagent' AND a.subagent_type IS NOT NULL${sf.clause.replace("session_id", "a.session_id")}
       GROUP BY source, target
       ORDER BY weight DESC`
    )
    .all(...sf.params);

  
  const outcomes = db
    .prepare(
      `SELECT status, COUNT(*) as count FROM agents
       WHERE status IN ('completed', 'error')${sf.clause}
       GROUP BY status`
    )
    .all(...sf.params);

  
  const compactions = db
    .prepare(
      `SELECT session_id, COUNT(*) as count
       FROM agents WHERE subagent_type = 'compaction'${sf.clause}
       GROUP BY session_id`
    )
    .all(...sf.params);
  const totalCompactions = compactions.reduce((s, r) => s + r.count, 0);
  const sessionsWithCompactions = compactions.length;

  return {
    sessionCount,
    mainCount,
    subagentTypes,
    edges,
    outcomes,
    compactions: { total: totalCompactions, sessions: sessionsWithCompactions },
  };
}

function getToolFlowData(statusFilter) {
  const sf = sessionIdFilter(statusFilter);

  
  const transitions = db
    .prepare(
      `SELECT e1.tool_name as source, e2.tool_name as target, COUNT(*) as value
       FROM events e1
       JOIN events e2 ON e2.session_id = e1.session_id AND e2.id = (
         SELECT MIN(e3.id) FROM events e3
         WHERE e3.session_id = e1.session_id AND e3.id > e1.id AND e3.tool_name IS NOT NULL
       )
       WHERE e1.tool_name IS NOT NULL AND e2.tool_name IS NOT NULL${sf.clause.replace("session_id", "e1.session_id")}
       GROUP BY e1.tool_name, e2.tool_name
       ORDER BY value DESC
       LIMIT 50`
    )
    .all(...sf.params);

  
  const toolCounts = db
    .prepare(
      `SELECT tool_name, COUNT(*) as count FROM events
       WHERE tool_name IS NOT NULL${sf.clause}
       GROUP BY tool_name ORDER BY count DESC LIMIT 15`
    )
    .all(...sf.params);

  return { transitions, toolCounts };
}

function getSubagentEffectiveness(statusFilter) {
  const sf = sessionIdFilter(statusFilter);

  const types = db
    .prepare(
      `SELECT
        a.subagent_type,
        COUNT(*) as total,
        SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN a.status = 'error' THEN 1 ELSE 0 END) as errors,
        COUNT(DISTINCT a.session_id) as sessions
       FROM agents a
       WHERE a.type = 'subagent' AND a.subagent_type IS NOT NULL${sf.clause.replace("session_id", "a.session_id")}
       GROUP BY a.subagent_type
       ORDER BY total DESC
       LIMIT 12`
    )
    .all(...sf.params);

  
  
  const withMetrics = types.map((t) => {
    const durRow = db
      .prepare(
        
        
        
        
        
        `SELECT AVG(
          CASE WHEN ended_at IS NOT NULL THEN
            MAX(0, (julianday(ended_at) - julianday(started_at)) * 86400)
          ELSE NULL END
        ) as avg_duration
        FROM agents WHERE subagent_type = ? AND type = 'subagent'${sf.clause}`
      )
      .get(t.subagent_type, ...sf.params);

    
    
    
    const trendRows = db
      .prepare(
        `SELECT CAST(strftime('%w', started_at) AS INTEGER) as dow, COUNT(*) as count
         FROM agents WHERE subagent_type = ? AND type = 'subagent'
           AND started_at >= date('now', '-56 days')${sf.clause}
         GROUP BY dow ORDER BY dow ASC`
      )
      .all(t.subagent_type, ...sf.params);

    
    const trendByDay = [0, 0, 0, 0, 0, 0, 0];
    for (const row of trendRows) {
      const idx = (row.dow + 6) % 7; 
      trendByDay[idx] = row.count;
    }

    return {
      ...t,
      successRate:
        t.completed + t.errors > 0
          ? +((t.completed / (t.completed + t.errors)) * 100).toFixed(1)
          : 100,
      avgDuration: durRow?.avg_duration ? Math.round(durRow.avg_duration) : null,
      trend: trendByDay,
    };
  });

  return withMetrics;
}

function getWorkflowPatterns(statusFilter) {
  const sf = sessionIdFilter(statusFilter);
  const ss = statusClause(statusFilter);

  
  const sessions = db
    .prepare(
      `SELECT session_id, GROUP_CONCAT(subagent_type, '→') as sequence
       FROM (
         SELECT session_id, subagent_type
         FROM agents
         WHERE type = 'subagent' AND subagent_type IS NOT NULL${sf.clause}
         ORDER BY session_id, started_at ASC
       )
       GROUP BY session_id
       HAVING COUNT(*) >= 2`
    )
    .all(...sf.params);

  
  const patternCounts = {};
  const totalSessions = db
    .prepare(`SELECT COUNT(*) as c FROM sessions s WHERE 1=1${ss.clause}`)
    .get(...ss.params).c;
  for (const row of sessions) {
    const seq = row.sequence;
    patternCounts[seq] = (patternCounts[seq] || 0) + 1;
  }

  
  for (const row of sessions) {
    const steps = row.sequence.split("→");
    
    for (let i = 0; i < steps.length - 1; i++) {
      const sub = steps.slice(i, i + 2).join("→");
      patternCounts[sub] = (patternCounts[sub] || 0) + 1;
    }
    
    for (let i = 0; i < steps.length - 2; i++) {
      const sub = steps.slice(i, i + 3).join("→");
      patternCounts[sub] = (patternCounts[sub] || 0) + 1;
    }
  }

  
  
  const sorted = Object.entries(patternCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => ({
      steps: pattern.split("→"),
      count,
      percentage: totalSessions > 0 ? +((count / totalSessions) * 100).toFixed(1) : 0,
    }));

  
  const soloCount = db
    .prepare(
      `SELECT COUNT(*) as c FROM sessions s
       WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.session_id = s.id AND a.type = 'subagent')${ss.clause}`
    )
    .get(...ss.params).c;

  return {
    patterns: sorted,
    soloSessionCount: soloCount,
    soloPercentage: totalSessions > 0 ? +((soloCount / totalSessions) * 100).toFixed(1) : 0,
  };
}

function getModelDelegation(statusFilter) {
  const ss = statusClause(statusFilter);

  
  const mainModels = db
    .prepare(
      `SELECT s.model, COUNT(DISTINCT a.id) as agent_count, COUNT(DISTINCT s.id) as session_count
       FROM agents a JOIN sessions s ON a.session_id = s.id
       WHERE a.type = 'main' AND s.model IS NOT NULL${ss.clause}
       GROUP BY s.model ORDER BY agent_count DESC`
    )
    .all(...ss.params);

  
  const subagentModels = db
    .prepare(
      `SELECT s.model, COUNT(a.id) as agent_count
       FROM agents a JOIN sessions s ON a.session_id = s.id
       WHERE a.type = 'subagent' AND s.model IS NOT NULL${ss.clause}
       GROUP BY s.model ORDER BY agent_count DESC`
    )
    .all(...ss.params);

  
  const sfToken = sessionIdFilter(statusFilter);
  const tokensByModel = db
    .prepare(
      `SELECT model,
        SUM(input_tokens + baseline_input) as input_tokens,
        SUM(output_tokens + baseline_output) as output_tokens,
        SUM(cache_read_tokens + baseline_cache_read) as cache_read_tokens,
        SUM(cache_write_tokens + baseline_cache_write) as cache_write_tokens
       FROM token_usage WHERE 1=1${sfToken.clause}
       GROUP BY model ORDER BY (input_tokens + output_tokens) DESC`
    )
    .all(...sfToken.params);

  return { mainModels, subagentModels, tokensByModel };
}

function getErrorPropagation(statusFilter) {
  const sf = sessionIdFilter(statusFilter);
  const ss = statusClause(statusFilter);

  
  
  const errorsByDepth = db
    .prepare(
      `WITH RECURSIVE agent_depth AS (
        SELECT id, session_id, subagent_type, status, 0 as depth
        FROM agents WHERE parent_agent_id IS NULL
        UNION ALL
        SELECT a.id, a.session_id, a.subagent_type, a.status, ad.depth + 1
        FROM agents a JOIN agent_depth ad ON a.parent_agent_id = ad.id
      )
      SELECT depth, COUNT(*) as count FROM agent_depth
      WHERE status = 'error'${sf.clause}
      GROUP BY depth ORDER BY depth ASC`
    )
    .all(...sf.params);

  
  
  const sessionErrorsNotInAgents = db
    .prepare(
      `SELECT COUNT(*) as c FROM sessions s
       WHERE s.status = 'error'${ss.clause}
         AND NOT EXISTS (
           SELECT 1 FROM agents a WHERE a.session_id = s.id AND a.status = 'error'
         )`
    )
    .get(...ss.params).c;

  if (sessionErrorsNotInAgents > 0) {
    const existing = errorsByDepth.find((d) => d.depth === 0);
    if (existing) {
      existing.count += sessionErrorsNotInAgents;
    } else {
      errorsByDepth.unshift({ depth: 0, count: sessionErrorsNotInAgents });
    }
  }

  
  const errorTypes = db
    .prepare(
      `SELECT subagent_type, COUNT(*) as count
       FROM agents WHERE status = 'error' AND subagent_type IS NOT NULL${sf.clause}
       GROUP BY subagent_type ORDER BY count DESC LIMIT 5`
    )
    .all(...sf.params);

  
  const eventErrors = db
    .prepare(
      `SELECT e.summary, COUNT(*) as count
       FROM events e
       WHERE ((e.event_type = 'Stop' AND e.summary LIKE 'Error in%')
          OR e.event_type = 'APIError')${sf.clause.replace("session_id", "e.session_id")}
       GROUP BY e.summary ORDER BY count DESC LIMIT 10`
    )
    .all(...sf.params);

  
  const sessionsWithErrors = db
    .prepare(
      `SELECT COUNT(DISTINCT id) as c FROM (
        SELECT id FROM sessions s WHERE s.status = 'error'${ss.clause}
        UNION
        SELECT DISTINCT session_id as id FROM agents WHERE status = 'error'${sf.clause}
        UNION
        SELECT DISTINCT session_id as id FROM events
        WHERE ((event_type = 'Stop' AND summary LIKE 'Error in%')
           OR event_type = 'APIError')${sf.clause}
      )`
    )
    .get(...ss.params, ...sf.params, ...sf.params).c;
  const totalSessions = db
    .prepare(`SELECT COUNT(*) as c FROM sessions s WHERE 1=1${ss.clause}`)
    .get(...ss.params).c;

  return {
    byDepth: errorsByDepth,
    byType: errorTypes,
    eventErrors,
    sessionsWithErrors,
    totalSessions,
    errorRate: totalSessions > 0 ? +((sessionsWithErrors / totalSessions) * 100).toFixed(1) : 0,
  };
}

function getConcurrencyData(statusFilter) {
  const ss = statusClause(statusFilter);

  
  
  const lanes = db
    .prepare(
      `SELECT
        a.id, a.name, a.type, a.subagent_type, a.status,
        a.started_at, a.ended_at, a.session_id,
        s.started_at as session_start, s.ended_at as session_end
       FROM agents a
       JOIN sessions s ON a.session_id = s.id
       WHERE s.ended_at IS NOT NULL${ss.clause}
       ORDER BY a.started_at ASC
       LIMIT 2000`
    )
    .all(...ss.params);

  
  const typeAgg = {};
  for (const lane of lanes) {
    const sessStart = new Date(lane.session_start).getTime();
    const sessEnd = new Date(lane.session_end).getTime();
    const sessDur = sessEnd - sessStart;
    if (sessDur <= 0) continue;

    const agStart = new Date(lane.started_at).getTime();
    const agEnd = lane.ended_at ? new Date(lane.ended_at).getTime() : sessEnd;

    const startPct = Math.max(0, Math.min(1, (agStart - sessStart) / sessDur));
    const endPct = Math.max(0, Math.min(1, (agEnd - sessStart) / sessDur));

    const key = lane.type === "main" ? "Main Agent" : lane.subagent_type || "unknown";
    if (!typeAgg[key]) typeAgg[key] = { starts: [], ends: [], status: lane.status };
    typeAgg[key].starts.push(startPct);
    typeAgg[key].ends.push(endPct);
  }

  
  const aggregateLanes = Object.entries(typeAgg)
    .map(([name, data]) => ({
      name,
      avgStart: +(data.starts.reduce((s, v) => s + v, 0) / data.starts.length).toFixed(3),
      avgEnd: +(data.ends.reduce((s, v) => s + v, 0) / data.ends.length).toFixed(3),
      count: data.starts.length,
    }))
    .sort((a, b) => a.avgStart - b.avgStart);

  return { aggregateLanes };
}

function getSessionComplexity(statusFilter) {
  const ss = statusClause(statusFilter);

  const rows = db
    .prepare(
      `SELECT
        s.id, s.name, s.status, s.started_at, s.ended_at, s.model,
        COUNT(a.id) as agent_count,
        SUM(CASE WHEN a.type = 'subagent' THEN 1 ELSE 0 END) as subagent_count
       FROM sessions s
       LEFT JOIN agents a ON a.session_id = s.id
       WHERE 1=1${ss.clause}
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT 200`
    )
    .all(...ss.params);

  const sessions = rows.map((r) => {
    const dur = durationSec(r);
    
    const tokens = db
      .prepare(
        `SELECT SUM(input_tokens + baseline_input + output_tokens + baseline_output +
                    cache_read_tokens + baseline_cache_read + cache_write_tokens + baseline_cache_write) as total
         FROM token_usage WHERE session_id = ?`
      )
      .get(r.id);

    return {
      id: r.id,
      name: r.name,
      status: r.status,
      duration: Math.round(dur),
      agentCount: r.agent_count,
      subagentCount: r.subagent_count,
      totalTokens: tokens?.total || 0,
      model: r.model,
    };
  });

  return sessions;
}

function getCompactionImpact(statusFilter) {
  const sf = sessionIdFilter(statusFilter);
  const ss = statusClause(statusFilter);

  
  const totalCompactions = db
    .prepare(`SELECT COUNT(*) as c FROM agents WHERE subagent_type = 'compaction'${sf.clause}`)
    .get(...sf.params).c;

  
  const recovered = db
    .prepare(
      `SELECT
        SUM(baseline_input + baseline_output + baseline_cache_read + baseline_cache_write) as total
       FROM token_usage WHERE 1=1${sf.clause}`
    )
    .get(...sf.params);

  
  const perSession = db
    .prepare(
      `SELECT session_id, COUNT(*) as compactions
       FROM agents WHERE subagent_type = 'compaction'${sf.clause}
       GROUP BY session_id ORDER BY compactions DESC LIMIT 50`
    )
    .all(...sf.params);

  
  const sessionsWithCompactions = db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) as c FROM agents WHERE subagent_type = 'compaction'${sf.clause}`
    )
    .get(...sf.params).c;
  const totalSessions = db
    .prepare(`SELECT COUNT(*) as c FROM sessions s WHERE 1=1${ss.clause}`)
    .get(...ss.params).c;

  return {
    totalCompactions,
    tokensRecovered: recovered?.total || 0,
    perSession,
    sessionsWithCompactions,
    totalSessions,
  };
}

function getAgentCooccurrence(statusFilter) {
  const sf = sessionIdFilter(statusFilter);

  
  
  const pairs = db
    .prepare(
      `SELECT a1.subagent_type as source, a2.subagent_type as target,
              COUNT(*) as weight
       FROM agents a1
       JOIN agents a2 ON a1.session_id = a2.session_id
         AND a1.started_at < a2.started_at
         AND a1.id != a2.id
       WHERE a1.type = 'subagent' AND a2.type = 'subagent'
         AND a1.subagent_type IS NOT NULL AND a2.subagent_type IS NOT NULL
         AND a1.subagent_type != 'compaction' AND a2.subagent_type != 'compaction'${sf.clause.replace("session_id", "a1.session_id")}
       GROUP BY a1.subagent_type, a2.subagent_type
       HAVING weight >= 2
       ORDER BY weight DESC
       LIMIT 40`
    )
    .all(...sf.params);

  return pairs;
}

function hydrateWorkflow(row) {
  if (!row) return row;
  let phases = [];
  let progress = [];
  try {
    phases = row.phases ? JSON.parse(row.phases) : [];
  } catch {
    phases = [];
  }
  try {
    progress = row.progress ? JSON.parse(row.progress) : [];
  } catch {
    progress = [];
  }
  return { ...row, phases, progress };
}

router.get("/runs", (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const status = req.query.status && req.query.status !== "all" ? req.query.status : null;
    const sessionId = req.query.session_id || null;

    let rows;
    if (sessionId) {
      rows = stmts.listWorkflowsBySessionFilter.all(sessionId, limit, offset);
    } else if (status) {
      rows = stmts.listWorkflowsByStatus.all(status, limit, offset);
    } else {
      rows = stmts.listWorkflows.all(limit, offset);
    }

    const total = status
      ? stmts.countWorkflowsByStatus.get(status).n
      : stmts.countWorkflows.get().n;
    const counts = {};
    for (const r of stmts.workflowStatusCounts.all()) counts[r.status] = r.n;

    res.json({ runs: rows.map(hydrateWorkflow), total, counts, limit, offset });
  } catch (err) {
    res.status(500).json({ error: { code: "WORKFLOW_LIST_FAILED", message: err.message } });
  }
});

router.get("/runs/:runId", (req, res) => {
  try {
    const wf = stmts.getWorkflow.get(req.params.runId);
    if (!wf) {
      return res
        .status(404)
        .json({ error: { code: "WORKFLOW_NOT_FOUND", message: "Workflow run not found" } });
    }
    const agents = stmts.listAgentsByWorkflow.all(req.params.runId);
    
    let events = [];
    if (agents.length > 0) {
      const ids = agents.map((a) => a.id);
      const placeholders = ids.map(() => "?").join(",");
      events = db
        .prepare(
          `SELECT * FROM events WHERE agent_id IN (${placeholders}) ORDER BY created_at ASC, id ASC LIMIT 5000`
        )
        .all(...ids);
    }
    res.json({ workflow: hydrateWorkflow(wf), agents, events });
  } catch (err) {
    res.status(500).json({ error: { code: "WORKFLOW_DETAIL_FAILED", message: err.message } });
  }
});

module.exports = router;
