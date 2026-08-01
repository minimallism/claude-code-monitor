const fs = require("fs");
const { Router } = require("express");
const { db, stmts } = require("../db");
const { getConnectionCount } = require("../sse");

const router = Router();

router.get("/", (req, res) => {
  
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
