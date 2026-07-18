const { Router } = require("express");
const { stmts, db } = require("../db");

const { calculateCost } = require("./pricing");

const router = Router();

router.get("/", (req, res) => {
  
  
  const rawOffset = parseInt(req.query.tz_offset, 10);
  const tzModifier = Number.isFinite(rawOffset) ? `${-rawOffset} minutes` : "+0 minutes";

  const tokenTotals = stmts.getTokenTotals.get();
  const toolUsage = stmts.toolUsageCounts.all();
  const dailyEvents = stmts.dailyEventCounts.all(tzModifier);
  const dailySessions = stmts.dailySessionCounts.all(tzModifier);
  const overview = stmts.stats.get();
  const agentsByStatus = stmts.agentStatusCounts.all();
  const sessionsByStatus = stmts.sessionStatusCounts.all();
  const totalSubagents = stmts.totalSubagentCount.get();
  const eventTypes = stmts.eventTypeCounts.all();
  const avgEvents = stmts.avgEventsPerSession.get();

  const tokensByModel = db
    .prepare(
      `SELECT COALESCE(model, 'unknown') as model,
        SUM(input_tokens + baseline_input) as input_tokens,
        SUM(output_tokens + baseline_output) as output_tokens,
        SUM(cache_read_tokens + baseline_cache_read) as cache_read_tokens,
        SUM(cache_write_tokens + baseline_cache_write) as cache_write_tokens
       FROM token_usage GROUP BY model ORDER BY (input_tokens + output_tokens) DESC`
    )
    .all();

  
  const pricingRules = stmts.listPricing.all();
  
  
  const allTokenUsage = db
    .prepare(
      "SELECT tu.*, DATE(s.started_at) as date FROM token_usage tu JOIN sessions s ON s.id = tu.session_id"
    )
    .all();

  let totalCost = 0;
  for (const usage of allTokenUsage) {
    const { total_cost } = calculateCost([usage], pricingRules);
    totalCost += total_cost;
  }

  res.json({
    tokens: {
      total_input: tokenTotals?.total_input ?? 0,
      total_output: tokenTotals?.total_output ?? 0,
      total_cache_read: tokenTotals?.total_cache_read ?? 0,
      total_cache_write: tokenTotals?.total_cache_write ?? 0,
    },
    tokens_by_model: tokensByModel,
    total_cost: totalCost,
    tool_usage: toolUsage,
    daily_events: dailyEvents,
    daily_sessions: dailySessions,
    event_types: eventTypes,
    avg_events_per_session: avgEvents?.avg ?? 0,
    total_subagents: totalSubagents?.count ?? 0,
    overview,
    agents_by_status: Object.fromEntries(agentsByStatus.map((r) => [r.status, r.count])),
    sessions_by_status: Object.fromEntries(sessionsByStatus.map((r) => [r.status, r.count])),
  });
});

module.exports = router;
