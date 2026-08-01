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
    };
  }
  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
  const ephemeral5mTokens = cacheCreation ? cacheCreation.ephemeral_5m_input_tokens || 0 : 0;
  const ephemeral1hTokens = cacheCreation ? cacheCreation.ephemeral_1h_input_tokens || 0 : 0;
  
  const cacheWrite =
    usage.cache_creation_input_tokens != null
      ? usage.cache_creation_input_tokens || 0
      : ephemeral5mTokens + ephemeral1hTokens;
  
  const cacheWrite1h = Math.min(ephemeral1hTokens, cacheWrite);
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite,
    cacheWrite1h,
  };
}

function accumulateBucket(target, source) {
  target.input += source.input || 0;
  target.output += source.output || 0;
  target.cacheRead += source.cacheRead || 0;
  target.cacheWrite += source.cacheWrite || 0;
  target.cacheWrite1h += source.cacheWrite1h || 0;
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
