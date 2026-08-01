/**
 * 仪表盘概览 API。
 *
 * 聚合展示首页需要的核心指标：会话/agent 总数、今日事件/会话/token、
 * 项目数、token 总量以及当前 SSE 连接数。
 *
 * 时区处理：
 * - 前端把本地时区偏移（分钟）通过 tz_offset 传入。
 * - 后端用 SQLite 的 datetime('now', ?) 把 UTC 的 'now' 转换到用户本地时区，
 *   再按 'start of day' 截取当天 00:00，保证 "今日" 与用户的日历日一致。
 */

const fs = require("fs");
const { Router } = require("express");
const { db, stmts } = require("../db");
const { getConnectionCount } = require("../sse");

const router = Router();

router.get("/", (req, res) => {
  // tz_offset 是前端本地时区相对 UTC 的分钟偏移（如北京为 +480）。
  // 要得到本地时间，需要把 UTC 的 now 减去这个偏移。
  const rawOffset = parseInt(req.query.tz_offset, 10);
  const offsetMin = Number.isFinite(rawOffset) ? rawOffset : 0;
  const toLocal = `${-offsetMin} minutes`;
  const toUTC = `${offsetMin} minutes`;

  const overview = stmts.stats.get();
  const agentsByStatus = stmts.agentStatusCounts.all();
  const sessionsByStatus = stmts.sessionStatusCounts.all();

  const eventsToday = stmts.countEventsToday.get(toLocal, toUTC);
  const sessionsToday = stmts.countSessionsToday.get(toLocal, toUTC);
  const tokensToday = stmts.countTokensToday.get(toLocal, toUTC);

  // 只统计磁盘上仍然存在的 cwd 作为真实项目数。
  const allCwds = db.prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != ''").all();
  const totalProjects = allCwds.filter((r) => fs.existsSync(r.cwd)).length;
  const tokenTotals = stmts.getTokenTotals.get();

  res.json({
    ...overview,
    total_projects: totalProjects,
    events_today: eventsToday?.count ?? 0,
    sessions_today: sessionsToday?.count ?? 0,
    tokens_today: tokensToday?.total ?? 0,
    total_tokens_input: tokenTotals?.total_input ?? 0,
    total_tokens_output: tokenTotals?.total_output ?? 0,
    total_tokens_cache_read: tokenTotals?.total_cache_read ?? 0,
    total_tokens_cache_write: tokenTotals?.total_cache_write ?? 0,
    ws_connections: getConnectionCount(),
    agents_by_status: Object.fromEntries(agentsByStatus.map((r) => [r.status, r.count])),
    sessions_by_status: Object.fromEntries(sessionsByStatus.map((r) => [r.status, r.count])),
  });
});

module.exports = router;
