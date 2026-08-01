/**
 * 项目（Project）列表 API。
 *
 * 一个 project 对应一个工作目录（cwd）。
 * 该路由聚合每个 cwd 下的会话数量、活跃会话数、token 总量、磁盘占用和最后活动时间。
 */

const fs = require("fs");
const path = require("path");
const { Router } = require("express");
const { db } = require("../db");
const { getProjectsDir } = require("../lib/claude-home");

const router = Router();

/**
 * GET /api/projects
 *
 * 返回所有磁盘上仍然存在的 project 列表。
 *
 * 注意：
 * - 先按 cwd 分组统计会话数。
 * - 再单独查询每个 cwd 的 token 总量（避免 JOIN 导致大数据量时性能下降）。
 * - disk_usage 递归计算该项目在 ~/.claude/projects/<encoded> 下占用的字节数。
 */
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

/**
 * 递归计算目录总大小。
 */
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
