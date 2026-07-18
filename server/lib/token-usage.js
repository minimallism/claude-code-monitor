const BUCKET_SEP = String.fromCharCode(1);

function normalizeSpeed(usage) {
  return usage && usage.speed === "fast" ? "fast" : "standard";
}

function normalizeGeo(usage) {
  return usage && usage.inference_geo === "us" ? "us" : "global";
}

function normalizeTier(usage) {
  return usage && usage.service_tier === "batch" ? "batch" : "standard";
}

function bucketKey(model, speed, geo, tier) {
  return [model, speed, geo, tier].join(BUCKET_SEP);
}

function emptyBucket(model, speed, geo, tier) {
  return {
    model,
    speed,
    geo,
    tier,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0, 
    cacheWrite1h: 0, 
    webSearch: 0, 
    webFetch: 0, 
    codeExec: 0, 
  };
}

function extractUsageFields(usage) {
  if (!usage || typeof usage !== "object") {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      webSearch: 0,
      webFetch: 0,
      codeExec: 0,
    };
  }
  const cc =
    usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
  const ephem5m = cc ? cc.ephemeral_5m_input_tokens || 0 : 0;
  const ephem1h = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
  
  const cacheWrite =
    usage.cache_creation_input_tokens != null
      ? usage.cache_creation_input_tokens || 0
      : ephem5m + ephem1h;
  
  const cacheWrite1h = Math.min(ephem1h, cacheWrite);
  const stu =
    usage.server_tool_use && typeof usage.server_tool_use === "object"
      ? usage.server_tool_use
      : null;
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite,
    cacheWrite1h,
    webSearch: stu ? stu.web_search_requests || 0 : 0,
    webFetch: stu ? stu.web_fetch_requests || 0 : 0,
    codeExec: stu ? stu.code_execution_requests || 0 : 0,
  };
}

function accumulateBucket(target, src) {
  target.input += src.input || 0;
  target.output += src.output || 0;
  target.cacheRead += src.cacheRead || 0;
  target.cacheWrite += src.cacheWrite || 0;
  target.cacheWrite1h += src.cacheWrite1h || 0;
  target.webSearch += src.webSearch || 0;
  target.webFetch += src.webFetch || 0;
  target.codeExec += src.codeExec || 0;
  return target;
}

module.exports = {
  BUCKET_SEP,
  normalizeSpeed,
  normalizeGeo,
  normalizeTier,
  bucketKey,
  emptyBucket,
  extractUsageFields,
  accumulateBucket,
};
