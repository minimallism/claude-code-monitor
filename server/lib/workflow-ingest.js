const fs = require("fs");
const path = require("path");

function importHistory() {
  return require("../../scripts/import-history");
}

let claudeHome = null;
function getClaudeHomeLib() {
  if (!claudeHome) claudeHome = require("./claude-home");
  return claudeHome;
}

function extractRunId(filename) {
  const base = path.basename(filename).replace(/\.(json|js)$/i, "");
  const m = base.match(/wf_[A-Za-z0-9_-]+$/);
  return m ? m[0] : base;
}

function nameFromScript(filename) {
  const base = path.basename(filename).replace(/\.js$/i, "");
  return base.replace(/-?wf_[A-Za-z0-9_-]+$/, "") || base;
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    try {
      return new Date(value).toISOString();
    } catch {
      return null;
    }
  }
  return String(value);
}

function mapState(state) {
  switch (String(state || "").toLowerCase()) {
    case "error":
    case "failed":
      return "error";
    case "running":
    case "working":
    case "active":
    case "in_progress":
    case "queued":
      return "working";
    case "done":
    case "completed":
    case "success":
      return "completed";
    default:
      return "completed";
  }
}

const TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "webSearch",
  "webFetch",
  "codeExec",
];

function mergeWorkflowTokens(dst, src) {
  for (const b of Object.values(src || {})) {
    if (!b || !b.model) continue;
    const key = `${b.model}|${b.speed}|${b.geo}|workflow`;
    if (!dst[key]) {
      dst[key] = {
        model: b.model,
        speed: b.speed,
        geo: b.geo,
        tier: "workflow",
      };
      for (const f of TOKEN_FIELDS) dst[key][f] = 0;
    }
    for (const f of TOKEN_FIELDS) dst[key][f] += b[f] || 0;
  }
}

function resolveTranscriptPath(session) {
  if (session && session.transcript_path) return session.transcript_path;
  if (session && session.id && session.cwd) {
    try {
      return getClaudeHomeLib().getTranscriptPath(session.id, session.cwd);
    } catch {
      return null;
    }
  }
  return null;
}

function findSessionWorkflows(transcriptPath) {
  const empty = {
    sessionDir: null,
    workflowsDir: null,
    journals: [],
    scripts: [],
    liveRuns: [],
  };
  if (!transcriptPath) return empty;
  const dir = path.dirname(transcriptPath);
  const sessionId = path.basename(transcriptPath, ".jsonl");
  const sessionDir = path.join(dir, sessionId);
  const workflowsDir = path.join(sessionDir, "workflows");

  const journals = [];
  const scripts = [];
  try {
    if (fs.existsSync(workflowsDir)) {
      for (const f of fs.readdirSync(workflowsDir)) {
        if (f.startsWith("wf_") && f.endsWith(".json")) journals.push(path.join(workflowsDir, f));
      }
      const scriptsDir = path.join(workflowsDir, "scripts");
      if (fs.existsSync(scriptsDir)) {
        for (const f of fs.readdirSync(scriptsDir)) {
          if (f.endsWith(".js")) scripts.push(path.join(scriptsDir, f));
        }
      }
    }
  } catch {
    
  }

  
  
  
  const liveRuns = [];
  try {
    const base = path.join(sessionDir, "subagents", "workflows");
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory()) liveRuns.push({ runId: d.name, dir: path.join(base, d.name) });
      }
    }
  } catch {
    
  }

  return { sessionDir, workflowsDir, journals, scripts, liveRuns };
}

function agentsDirForRun(sessionDir, runId) {
  return path.join(sessionDir, "subagents", "workflows", runId);
}

function parseWorkflowJournal(journalPath) {
  let raw;
  try {
    raw = fs.readFileSync(journalPath, "utf8");
  } catch {
    return null;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const runId = extractRunId(journalPath) || j.runId || null;
  if (!runId) return null;

  const startedAt = toIso(j.startTime != null ? j.startTime : j.startedAt);
  const durationMs = Number.isFinite(j.durationMs) ? j.durationMs : null;
  let endedAt = toIso(j.endTime != null ? j.endTime : j.endedAt);
  if (!endedAt && startedAt && durationMs != null) {
    const t = Date.parse(startedAt);
    if (!Number.isNaN(t)) endedAt = new Date(t + durationMs).toISOString();
  }
  const progress = Array.isArray(j.workflowProgress)
    ? j.workflowProgress
    : Array.isArray(j.progress)
      ? j.progress
      : [];

  return {
    runId,
    taskId: j.taskId || null,
    name: j.workflowName || j.name || nameFromScript(journalPath),
    status: String(j.status || "completed"),
    defaultModel: j.defaultModel || null,
    startedAt,
    endedAt,
    durationMs,
    agentCount: Number.isFinite(j.agentCount)
      ? j.agentCount
      : progress.filter((e) => e && e.type === "workflow_agent").length,
    totalTokens: Number.isFinite(j.totalTokens) ? j.totalTokens : 0,
    totalToolCalls: Number.isFinite(j.totalToolCalls) ? j.totalToolCalls : 0,
    phases: Array.isArray(j.phases) ? j.phases : [],
    progress,
    journalPath,
  };
}

async function ingestWorkflowJournal(dbModule, sessionId, journal, opts = {}) {
  const { stmts } = dbModule;
  const mainAgentId = `${sessionId}-main`;
  const ih = importHistory();
  
  
  const agentDir = opts.sessionDir ? agentsDirForRun(opts.sessionDir, journal.runId) : null;
  
  
  const runTokens = {};

  stmts.upsertWorkflow.run(
    journal.runId,
    sessionId,
    journal.taskId,
    journal.name,
    journal.status,
    journal.defaultModel,
    journal.startedAt,
    journal.endedAt,
    journal.durationMs,
    journal.agentCount,
    journal.totalTokens,
    journal.totalToolCalls,
    JSON.stringify(journal.phases),
    JSON.stringify(journal.progress),
    opts.scriptPath || null,
    journal.journalPath || null,
    "journal"
  );

  
  
  const agentEntries = journal.progress.filter(
    (e) => e && e.type === "workflow_agent" && e.agentId
  );
  for (const entry of agentEntries) {
    const agentId = entry.agentId;
    const jsonlId = `${sessionId}-jsonl-${agentId}`;
    const status = mapState(entry.state);
    const phase = entry.phaseTitle || null;
    
    
    const subType =
      (entry.label && entry.label.includes(":") ? entry.label.split(":")[0] : null) ||
      entry.agentType ||
      "workflow-subagent";

    
    
    
    let parsed = null;
    if (agentDir) {
      const subPath = path.join(agentDir, `agent-${agentId}.jsonl`);
      if (fs.existsSync(subPath)) {
        try {
          parsed = await ih.parseSubagentFile(subPath);
        } catch {
          parsed = null;
        }
      }
    }
    try {
      if (parsed) {
        ih.importSubagentFromJsonl(dbModule, sessionId, mainAgentId, parsed);
        mergeWorkflowTokens(runTokens, parsed.tokensByModel);
      } else if (!stmts.getAgent.get(jsonlId)) {
        stmts.insertAgent.run(
          jsonlId,
          sessionId,
          entry.label || `Subagent ${String(agentId).slice(0, 8)}`,
          "subagent",
          subType,
          status,
          entry.label || entry.promptPreview || null,
          mainAgentId,
          JSON.stringify({
            imported: true,
            source: "workflow",
            workflow_run_id: journal.runId,
            model: entry.model || null,
            tokens: entry.tokens || 0,
            tool_calls: entry.toolCalls || 0,
          })
        );
      }
      
      stmts.setAgentWorkflow.run(journal.runId, phase, status, jsonlId);
    } catch {
      
    }
  }

  return { row: stmts.getWorkflow.get(journal.runId), tokens: runTokens };
}

function shortLabel(s) {
  if (!s) return null;
  const first = String(s).split("\n")[0].trim();
  return first.length > 80 ? first.slice(0, 79) + "…" : first;
}

function safeStringify(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function bucketTotal(tokensByModel) {
  let n = 0;
  for (const b of Object.values(tokensByModel || {})) {
    n +=
      (b.input || 0) +
      (b.output || 0) +
      (b.cacheRead || 0) +
      (b.cacheWrite || 0) +
      (b.cacheWrite1h || 0);
  }
  return n;
}

async function ingestLiveWorkflow(dbModule, sessionId, sessionDir, runId, scriptPath) {
  const { stmts } = dbModule;
  const mainAgentId = `${sessionId}-main`;
  const ih = importHistory();
  const dir = agentsDirForRun(sessionDir, runId);
  if (!fs.existsSync(dir)) return null;

  
  const started = new Set();
  const doneResults = new Map();
  try {
    const jj = path.join(dir, "journal.jsonl");
    if (fs.existsSync(jj)) {
      for (const line of fs.readFileSync(jj, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!o || !o.agentId) continue;
        if (o.type === "started") started.add(o.agentId);
        else if (o.type === "result") doneResults.set(o.agentId, o.result);
      }
    }
  } catch {
    
  }

  let agentFiles = [];
  try {
    agentFiles = fs.readdirSync(dir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (agentFiles.length === 0 && started.size === 0) return null;

  const progress = [];
  const runTokens = {};
  let totalTokens = 0;
  let totalToolCalls = 0;
  let earliest = null;
  let latest = null;
  let model = null;

  for (const f of agentFiles) {
    const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    let parsed = null;
    try {
      parsed = await ih.parseSubagentFile(path.join(dir, f));
    } catch {
      parsed = null;
    }
    const done = doneResults.has(agentId);
    const state = done ? "done" : "running";
    const aTok = parsed ? bucketTotal(parsed.tokensByModel) : 0;
    const tools = parsed && parsed.toolNames ? parsed.toolNames : [];
    const startedAt = parsed && parsed.startedAt ? parsed.startedAt : null;
    const endedAt = parsed && parsed.endedAt ? parsed.endedAt : null;
    const durationMs = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null;
    const label = parsed && parsed.task ? shortLabel(parsed.task) : null;
    if (parsed && parsed.model && !model) model = parsed.model;
    totalTokens += aTok;
    totalToolCalls += tools.length;
    if (startedAt) {
      const ts = Date.parse(startedAt);
      if (!earliest || ts < earliest) earliest = ts;
    }
    if (endedAt) {
      const ts = Date.parse(endedAt);
      if (!latest || ts > latest) latest = ts;
    }

    progress.push({
      type: "workflow_agent",
      agentId,
      label,
      phaseTitle: null,
      model: parsed ? parsed.model : null,
      state,
      tokens: aTok,
      toolCalls: tools.length,
      durationMs,
      lastToolName: tools.length ? tools[tools.length - 1] : null,
      promptPreview: parsed ? parsed.task : null,
      resultPreview: done ? safeStringify(doneResults.get(agentId)) : null,
    });

    try {
      const jsonlId = `${sessionId}-jsonl-${agentId}`;
      if (parsed) {
        ih.importSubagentFromJsonl(dbModule, sessionId, mainAgentId, parsed);
        mergeWorkflowTokens(runTokens, parsed.tokensByModel);
      } else if (!stmts.getAgent.get(jsonlId)) {
        stmts.insertAgent.run(
          jsonlId,
          sessionId,
          label || `Subagent ${agentId.slice(0, 8)}`,
          "subagent",
          "workflow-subagent",
          mapState(state),
          label,
          mainAgentId,
          JSON.stringify({ imported: true, source: "workflow-live", workflow_run_id: runId })
        );
      }
      stmts.setAgentWorkflow.run(runId, null, mapState(state), jsonlId);
    } catch {
      
    }
  }

  
  for (const agentId of started) {
    if (agentFiles.includes(`agent-${agentId}.jsonl`)) continue;
    progress.push({
      type: "workflow_agent",
      agentId,
      label: null,
      phaseTitle: null,
      model: null,
      state: doneResults.has(agentId) ? "done" : "running",
      tokens: 0,
      toolCalls: 0,
      durationMs: null,
      lastToolName: null,
    });
  }

  let startedAtIso = earliest ? new Date(earliest).toISOString() : null;
  if (!startedAtIso && scriptPath) {
    try {
      startedAtIso = new Date(fs.statSync(scriptPath).mtimeMs).toISOString();
    } catch {
      
    }
  }
  const durationMs = earliest && latest ? latest - earliest : null;

  stmts.upsertWorkflow.run(
    runId,
    sessionId,
    null,
    scriptPath ? nameFromScript(scriptPath) : runId,
    "running",
    model,
    startedAtIso,
    null,
    durationMs,
    progress.length,
    totalTokens,
    totalToolCalls,
    null,
    JSON.stringify(progress),
    scriptPath || null,
    null,
    "live"
  );
  return { row: stmts.getWorkflow.get(runId), tokens: runTokens };
}

function detectRunningWorkflows(dbModule, sessionId, paths, handledRunIds) {
  const { stmts } = dbModule;
  const changed = [];
  for (const scriptPath of paths.scripts) {
    const runId = extractRunId(scriptPath);
    if (!runId || handledRunIds.has(runId)) continue;
    const existing = stmts.getWorkflow.get(runId);
    if (existing && existing.status !== "running") continue; 

    let startedAt = null;
    let agentCount = 0;
    try {
      const st = fs.statSync(scriptPath);
      startedAt = new Date(st.mtimeMs).toISOString();
    } catch {
      
    }
    
    try {
      const agentDir = paths.sessionDir ? agentsDirForRun(paths.sessionDir, runId) : null;
      if (agentDir && fs.existsSync(agentDir)) {
        agentCount = fs
          .readdirSync(agentDir)
          .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl")).length;
      }
    } catch {
      
    }

    stmts.upsertWorkflow.run(
      runId,
      sessionId,
      null,
      nameFromScript(scriptPath),
      "running",
      null,
      startedAt,
      null,
      null,
      agentCount,
      0,
      0,
      null,
      null,
      scriptPath,
      null,
      "live"
    );
    changed.push(stmts.getWorkflow.get(runId));
  }
  return changed;
}

async function ingestWorkflowsForSession(dbModule, session) {
  const sessionId = session && session.id;
  if (!sessionId) return [];
  const transcriptPath = resolveTranscriptPath(session);
  if (!transcriptPath) return [];

  const paths = findSessionWorkflows(transcriptPath);
  if (paths.journals.length === 0 && paths.scripts.length === 0 && paths.liveRuns.length === 0) {
    return [];
  }

  const changed = [];
  const journalRunIds = new Set();
  
  
  
  
  const workflowTokens = {};
  
  const scriptByRun = new Map();
  for (const s of paths.scripts) scriptByRun.set(extractRunId(s), s);

  for (const journalPath of paths.journals) {
    try {
      const journal = parseWorkflowJournal(journalPath);
      if (!journal) continue;
      journalRunIds.add(journal.runId);
      const res = await ingestWorkflowJournal(dbModule, sessionId, journal, {
        sessionDir: paths.sessionDir,
        scriptPath: scriptByRun.get(journal.runId) || null,
      });
      if (res && res.row) changed.push(res.row);
      if (res && res.tokens) mergeWorkflowTokens(workflowTokens, res.tokens);
    } catch {
      
    }
  }

  
  
  const liveHandled = new Set();
  for (const lr of paths.liveRuns) {
    if (journalRunIds.has(lr.runId)) continue; 
    try {
      const res = await ingestLiveWorkflow(
        dbModule,
        sessionId,
        paths.sessionDir,
        lr.runId,
        scriptByRun.get(lr.runId) || null
      );
      if (res && res.row) {
        changed.push(res.row);
        liveHandled.add(lr.runId);
      }
      if (res && res.tokens) mergeWorkflowTokens(workflowTokens, res.tokens);
    } catch {
      
    }
  }

  try {
    const handled = new Set([...journalRunIds, ...liveHandled]);
    changed.push(...detectRunningWorkflows(dbModule, sessionId, paths, handled));
  } catch {
    
  }

  
  
  
  try {
    if (Object.keys(workflowTokens).length > 0) {
      importHistory().writeSessionTokens(dbModule, sessionId, workflowTokens);
    }
  } catch {
    
  }

  return changed;
}

async function ingestAllWorkflows(dbModule) {
  const { db } = dbModule;
  let rows = [];
  try {
    rows = db.prepare("SELECT id, cwd, transcript_path FROM sessions").all();
  } catch {
    return { sessions: 0, workflows: 0 };
  }
  let sessions = 0;
  let workflows = 0;
  for (const row of rows) {
    try {
      const changed = await ingestWorkflowsForSession(dbModule, {
        id: row.id,
        cwd: row.cwd,
        transcript_path: row.transcript_path,
      });
      if (changed.length > 0) {
        sessions++;
        workflows += changed.length;
      }
    } catch {
      
    }
  }
  return { sessions, workflows };
}

function workflowsMaxMtime(transcriptPath) {
  const { journals, scripts, liveRuns } = findSessionWorkflows(transcriptPath);
  let max = 0;
  const stat = (p) => {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > max) max = m;
    } catch {
      
    }
  };
  for (const p of [...journals, ...scripts]) stat(p);
  const completed = new Set(journals.map(extractRunId));
  for (const lr of liveRuns) {
    if (completed.has(lr.runId)) continue; 
    try {
      for (const f of fs.readdirSync(lr.dir)) {
        if (f.endsWith(".jsonl")) stat(path.join(lr.dir, f));
      }
    } catch {
      
    }
  }
  return max;
}

module.exports = {
  ingestWorkflowsForSession,
  ingestAllWorkflows,
  ingestLiveWorkflow,
  workflowsMaxMtime,
  findSessionWorkflows,
  parseWorkflowJournal,
  ingestWorkflowJournal,
  detectRunningWorkflows,
  extractRunId,
  nameFromScript,
  mapState,
};
