const { Router } = require("express");
const { stmts, db } = require("../db");

const router = Router();

router.get("/", (req, res) => {
  
  
  const rawOffset = parseInt(req.query.tz_offset, 10);
  const tzModifier = Number.isFinite(rawOffset) ? `${-rawOffset} minutes` : "+0 minutes";
  const toUTC = Number.isFinite(rawOffset) ? `${rawOffset} minutes` : "+0 minutes";

  const tokenTotals = stmts.getTokenTotals.get();
  const toolUsage = stmts.toolUsageCounts.all();
  const toolDurations = stmts.toolAvgDurations.all();

  // merge avg_duration_ms into tool_usage
  const durationByToolName = Object.fromEntries(toolDurations.map((durationRow) => [durationRow.tool_name, durationRow.avg_duration_ms]));
  for (const toolUsageRow of toolUsage) {
    toolUsageRow.avg_duration_ms = durationByToolName[toolUsageRow.tool_name] ?? null;
  }
  const dailySessions = stmts.dailySessionCounts.all(tzModifier);
  const dailySessionStatuses = stmts.dailySessionStatusCounts.all(tzModifier);
  const dailyTokens = stmts.dailyTokenCounts.all(tzModifier);
  const overview = stmts.stats.get();
  const agentsByStatus = stmts.agentStatusCounts.all();
  const agentTypes = stmts.agentTypeCounts.all();
  const subagentTypes = stmts.subagentTypeCounts.all();
  const sessionsByStatus = stmts.sessionStatusCounts.all();
  const sessionsToday = stmts.countSessionsToday.get(tzModifier, toUTC);

  const tokensByModel = db
    .prepare(
      `SELECT COALESCE(model, 'unknown') as model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens
       FROM token_usage GROUP BY model ORDER BY (input_tokens + output_tokens) DESC`
    )
    .all();


  res.json({
    tokens: {
      total_input: tokenTotals?.total_input ?? 0,
      total_output: tokenTotals?.total_output ?? 0,
      total_cache_read: tokenTotals?.total_cache_read ?? 0,
      total_cache_write: tokenTotals?.total_cache_write ?? 0,
    },
    tokens_by_model: tokensByModel,
    tool_usage: toolUsage,
    daily_sessions: dailySessions,
    daily_session_statuses: Object.entries(
      dailySessionStatuses.reduce((groupedByDate, statusRow) => {
        if (!groupedByDate[statusRow.date]) groupedByDate[statusRow.date] = { date: statusRow.date, completed: 0, error: 0, active: 0 };
        if (statusRow.status in groupedByDate[statusRow.date]) groupedByDate[statusRow.date][statusRow.status] = statusRow.count;
        return groupedByDate;
      }, {})
    ).map(([, statusEntry]) => statusEntry).sort((a, b) => a.date.localeCompare(b.date)),
    daily_tokens: dailyTokens,
    sessions_today: sessionsToday?.count ?? 0,
    overview,
    agents_by_status: Object.fromEntries(agentsByStatus.map((statusRow) => [statusRow.status, statusRow.count])),
    agent_types: Object.fromEntries(agentTypes.map((typeRow) => [typeRow.type, typeRow.count])),
    subagent_types: subagentTypes,
    sessions_by_status: Object.fromEntries(sessionsByStatus.map((statusRow) => [statusRow.status, statusRow.count])),
  });
});

module.exports = router;
