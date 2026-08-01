const fs = require("fs");
const path = require("path");
const { Router } = require("express");
const { db } = require("../db");
const { getProjectsDir } = require("../lib/claude-home");

const router = Router();

router.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT
        s.cwd,
        COUNT(*) as session_count,
        COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.id END) as active_sessions,
        MAX(s.updated_at) as last_activity
      FROM sessions s
      WHERE s.cwd IS NOT NULL AND s.cwd != ''
      GROUP BY s.cwd
      ORDER BY last_activity DESC`
    )
    .all();

  const projects = [];
  for (const row of rows) {
    if (!fs.existsSync(row.cwd)) continue;

    const tokenRow = db
      .prepare(
        `SELECT
          COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens), 0) as total_tokens
        FROM token_usage t
        JOIN sessions s ON s.id = t.session_id
        WHERE s.cwd = ?`
      )
      .get(row.cwd);

    const encoded = row.cwd.replace(/[^a-zA-Z0-9]/g, "-");

    const projectDir = path.join(getProjectsDir(), encoded);
    const disk_usage = fs.existsSync(projectDir) ? getDirSize(projectDir) : 0;

    projects.push({
      name: row.cwd.split("/").filter(Boolean).pop() || row.cwd,
      cwd: row.cwd,
      encoded_cwd: encoded,
      session_count: row.session_count,
      active_sessions: row.active_sessions,
      total_tokens: tokenRow?.total_tokens ?? 0,
      last_activity: row.last_activity,
      disk_usage,
    });
  }

  res.json({ projects });
});

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else if (entry.isFile()) {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {}
  return size;
}

module.exports = router;
