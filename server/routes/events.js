const { Router } = require("express");
const { db } = require("../db");

const router = Router();

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

function parseCsv(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function parseDate(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function buildWhere(filters) {
  const clauses = [];
  const params = [];

  const inClause = (field, values) => {
    clauses.push(`${field} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };

  if (filters.event_type) inClause("event_type", filters.event_type);
  if (filters.tool_name) inClause("tool_name", filters.tool_name);
  if (filters.agent_id) inClause("agent_id", filters.agent_id);
  if (filters.session_id) inClause("session_id", filters.session_id);

  if (filters.q) {
    clauses.push("(summary LIKE ? OR tool_name LIKE ? OR data LIKE ?)");
    const pattern = `%${filters.q}%`;
    params.push(pattern, pattern, pattern);
  }

  if (filters.from) {
    clauses.push("created_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("created_at <= ?");
    params.push(filters.to);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

router.get("/", (req, res) => {
  const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const filters = {
    event_type: parseCsv(req.query.event_type),
    tool_name: parseCsv(req.query.tool_name),
    agent_id: parseCsv(req.query.agent_id),
    session_id: parseCsv(req.query.session_id),
    q: typeof req.query.q === "string" && req.query.q.trim() !== "" ? req.query.q.trim() : null,
    from: parseDate(req.query.from),
    to: parseDate(req.query.to),
  };

  const { sql: whereSql, params: whereParams } = buildWhere(filters);

  const listSql = `SELECT * FROM events ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) as count FROM events ${whereSql}`;

  const events = db.prepare(listSql).all(...whereParams, limit, offset);
  const { count: total } = db.prepare(countSql).get(...whereParams);

  res.json({ events, limit, offset, total });
});

router.get("/facets", (_req, res) => {
  const eventTypes = db
    .prepare(
      "SELECT DISTINCT event_type FROM events WHERE event_type IS NOT NULL ORDER BY event_type"
    )
    .all()
    .map((r) => r.event_type);

  const toolNames = db
    .prepare("SELECT DISTINCT tool_name FROM events WHERE tool_name IS NOT NULL ORDER BY tool_name")
    .all()
    .map((r) => r.tool_name);

  res.json({ event_types: eventTypes, tool_names: toolNames });
});

module.exports = router;
