const { Router } = require("express");
const { stmts, db } = require("../db");
const {
  WEB_SEARCH_PER_1K_SEARCHES,
  CODE_EXEC_PER_HOUR,
  CODE_EXEC_FREE_HOURS,
  estimateCodeExecHours,
  DATA_RESIDENCY_US_MULTIPLIER,
  BATCH_DISCOUNT_MULTIPLIER,
} = require("../lib/pricing-constants");

const router = Router();

const round4 = (n) => Math.round(n * 10000) / 10000;

function ratesForBucket(rule, row, asOf) {
  const r = rule || {};

  
  
  
  
  
  const day = String(row.date || asOf || new Date().toISOString()).slice(0, 10);
  const useIntro = !!r.intro_until && day <= r.intro_until;
  const pick = (introVal, stdVal) => (useIntro && (introVal || 0) > 0 ? introVal : stdVal || 0);

  let rIn = pick(r.intro_input_per_mtok, r.input_per_mtok);
  let rOut = pick(r.intro_output_per_mtok, r.output_per_mtok);
  let rRead = pick(r.intro_cache_read_per_mtok, r.cache_read_per_mtok);
  let r5m = pick(r.intro_cache_write_per_mtok, r.cache_write_per_mtok);
  let r1h = pick(r.intro_cache_write_1h_per_mtok, r.cache_write_1h_per_mtok);

  if (row.speed === "fast" && (r.fast_input_per_mtok || 0) > 0) {
    const baseIn = r.input_per_mtok || 0;
    const factor = baseIn > 0 ? r.fast_input_per_mtok / baseIn : 1;
    rIn = r.fast_input_per_mtok;
    rOut = (r.fast_output_per_mtok || 0) > 0 ? r.fast_output_per_mtok : rOut * factor;
    rRead *= factor;
    r5m *= factor;
    r1h *= factor;
  }
  if (row.inference_geo === "us") {
    const m = DATA_RESIDENCY_US_MULTIPLIER;
    rIn *= m;
    rOut *= m;
    rRead *= m;
    r5m *= m;
    r1h *= m;
  }
  if (row.service_tier === "batch") {
    const m = BATCH_DISCOUNT_MULTIPLIER;
    rIn *= m;
    rOut *= m;
    rRead *= m;
    r5m *= m;
    r1h *= m;
  }
  return { rIn, rOut, rRead, r5m, r1h };
}

function calculateCost(tokenRows, pricingRules, asOf) {
  const sortedRules = [...pricingRules].sort(
    (a, b) => b.model_pattern.length - a.model_pattern.length
  );

  let tokenCost = 0;
  let webSearchCost = 0;
  let codeExecHours = 0;
  
  
  
  
  
  const breakdownMap = new Map();
  
  
  
  const unpriced = new Map();

  for (const row of tokenRows) {
    const rule = sortedRules.find((p) => {
      const pattern = p.model_pattern.replace(/%/g, ".*");
      return new RegExp("^" + pattern + "$").test(row.model);
    });

    if (!rule) {
      const u = unpriced.get(row.model) || {
        model: row.model,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      };
      u.input_tokens += row.input_tokens || 0;
      u.output_tokens += row.output_tokens || 0;
      u.cache_read_tokens += row.cache_read_tokens || 0;
      u.cache_write_tokens += row.cache_write_tokens || 0;
      unpriced.set(row.model, u);
    }

    const { rIn, rOut, rRead, r5m, r1h } = ratesForBucket(rule, row, asOf);
    const cw1h = row.cache_write_1h_tokens || 0;
    const cw5m = Math.max(0, (row.cache_write_tokens || 0) - cw1h);
    const tCost =
      (row.input_tokens / 1e6) * rIn +
      (row.output_tokens / 1e6) * rOut +
      (row.cache_read_tokens / 1e6) * rRead +
      (cw5m / 1e6) * r5m +
      (cw1h / 1e6) * r1h;

    const wsCost = ((row.web_search_requests || 0) / 1000) * WEB_SEARCH_PER_1K_SEARCHES;
    const ceHours = estimateCodeExecHours(
      row.code_execution_requests,
      row.web_search_requests,
      row.web_fetch_requests
    );

    tokenCost += tCost;
    webSearchCost += wsCost;
    codeExecHours += ceHours;

    const key = `${row.model}|${row.speed || "standard"}|${row.inference_geo || "global"}|${row.service_tier || "standard"}`;
    const agg = breakdownMap.get(key) || {
      model: row.model,
      speed: row.speed || "standard",
      inference_geo: row.inference_geo || "global",
      service_tier: row.service_tier || "standard",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_write_1h_tokens: 0,
      web_search_requests: 0,
      web_fetch_requests: 0,
      code_execution_requests: 0,
      _cost: 0,
      matched_rule: rule?.model_pattern || null,
    };
    agg.input_tokens += row.input_tokens || 0;
    agg.output_tokens += row.output_tokens || 0;
    agg.cache_read_tokens += row.cache_read_tokens || 0;
    agg.cache_write_tokens += row.cache_write_tokens || 0;
    agg.cache_write_1h_tokens += cw1h;
    agg.web_search_requests += row.web_search_requests || 0;
    agg.web_fetch_requests += row.web_fetch_requests || 0;
    agg.code_execution_requests += row.code_execution_requests || 0;
    agg._cost += tCost + wsCost;
    breakdownMap.set(key, agg);
  }
  const breakdown = [...breakdownMap.values()].map(({ _cost, ...b }) => ({
    ...b,
    cost: round4(_cost),
  }));

  
  
  
  const chargedHours = Math.max(0, codeExecHours - CODE_EXEC_FREE_HOURS);
  const codeExecCost = chargedHours * CODE_EXEC_PER_HOUR;
  const total = tokenCost + webSearchCost + codeExecCost;

  return {
    total_cost: round4(total),
    breakdown,
    feature_costs: {
      web_search_cost: round4(webSearchCost),
      web_fetch_cost: 0,
      code_execution_cost: round4(codeExecCost),
      code_execution_hours_estimated: round4(codeExecHours),
      code_execution_free_hours: CODE_EXEC_FREE_HOURS,
    },
    
    unpriced_models: [...unpriced.values()],
  };
}

function calculateDailyCosts(dailyTokenRows, pricingRules) {
  const rowsByDate = new Map();
  for (const row of dailyTokenRows) {
    const rows = rowsByDate.get(row.date) || [];
    rows.push({
      model: row.model,
      speed: row.speed,
      inference_geo: row.inference_geo,
      service_tier: row.service_tier,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      cache_write_1h_tokens: row.cache_write_1h_tokens,
      web_search_requests: row.web_search_requests,
      web_fetch_requests: row.web_fetch_requests,
      code_execution_requests: row.code_execution_requests,
    });
    rowsByDate.set(row.date, rows);
  }

  return [...rowsByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({ date, cost: calculateCost(rows, pricingRules, date).total_cost }));
}

router.get("/cost", (req, res) => {
  const rawOffset = parseInt(req.query.tz_offset, 10);
  const tzModifier = Number.isFinite(rawOffset) ? `${-rawOffset} minutes` : "+0 minutes";

  const dailyTokens = db
    .prepare(
      `SELECT
        DATE(s.started_at, ?) as date,
        tu.model as model,
        tu.speed as speed,
        tu.inference_geo as inference_geo,
        tu.service_tier as service_tier,
        SUM(tu.input_tokens + tu.baseline_input) as input_tokens,
        SUM(tu.output_tokens + tu.baseline_output) as output_tokens,
        SUM(tu.cache_read_tokens + tu.baseline_cache_read) as cache_read_tokens,
        SUM(tu.cache_write_tokens + tu.baseline_cache_write) as cache_write_tokens,
        SUM(tu.cache_write_1h_tokens + tu.baseline_cache_write_1h) as cache_write_1h_tokens,
        SUM(tu.web_search_requests + tu.baseline_web_search) as web_search_requests,
        SUM(tu.web_fetch_requests + tu.baseline_web_fetch) as web_fetch_requests,
        SUM(tu.code_execution_requests + tu.baseline_code_execution) as code_execution_requests
      FROM token_usage tu
      JOIN sessions s ON s.id = tu.session_id
      GROUP BY 1, tu.model, tu.speed, tu.inference_geo, tu.service_tier`
    )
    .all(tzModifier);
  const rules = stmts.listPricing.all();
  
  
  
  
  const result = calculateCost(dailyTokens, rules);
  const daily_costs = calculateDailyCosts(dailyTokens, rules);
  res.json({ ...result, daily_costs });
});

router.get("/cost/:sessionId", (req, res) => {
  const rawOffset = parseInt(req.query.tz_offset, 10);
  const tzModifier = Number.isFinite(rawOffset) ? `${-rawOffset} minutes` : "+0 minutes";

  const tokenRows = stmts.getTokensBySession.all(req.params.sessionId);
  const rules = stmts.listPricing.all();
  const started = db
    .prepare("SELECT DATE(started_at, ?) as date FROM sessions WHERE id = ?")
    .get(tzModifier, req.params.sessionId);
  
  
  const result = calculateCost(tokenRows, rules, started?.date);
  const daily_costs = started ? [{ date: started.date, cost: result.total_cost }] : [];
  res.json({ ...result, daily_costs });
});

function agentOwnCost(agent, pricingRules) {
  if (!agent || !agent.metadata) return 0;
  let meta;
  try {
    meta = JSON.parse(agent.metadata);
  } catch {
    return 0;
  }
  const rows = Array.isArray(meta.tokens) ? meta.tokens : null;
  if (!rows || rows.length === 0) return 0;
  const asOf = agent.started_at ? String(agent.started_at).slice(0, 10) : undefined;
  return calculateCost(rows, pricingRules, asOf).total_cost;
}

function attachAgentCosts(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return agents;
  const rules = stmts.listPricing.all();
  return agents.map((a) => ({ ...a, cost: agentOwnCost(a, rules) }));
}

module.exports = router;
module.exports.calculateCost = calculateCost;
module.exports.agentOwnCost = agentOwnCost;
module.exports.attachAgentCosts = attachAgentCosts;
