// 使用不可见控制字符作为分桶字段的分隔符，避免 model 名中出现与分隔符冲突的字符。
const BUCKET_SEP = String.fromCharCode(1);

/**
 * 归一化 speed 字段。Claude Code usage 中可能出现 "fast" 等取值，
 * 非 fast 统一归为 "standard"，便于按相同维度聚合 token。
 */
function normalizeSpeed(usage) {
  return usage && usage.speed === "fast" ? "fast" : "standard";
}

/**
 * 归一化 inference_geo 字段。
 * 只有显式为 "us" 时才认为是美国区，否则统一为 "global"，避免细碎地理维度。
 */
function normalizeGeo(usage) {
  return usage && usage.inference_geo === "us" ? "us" : "global";
}

/**
 * 归一化 service_tier 字段。batch 以外的 tier 统一为 "standard"。
 */
function normalizeTier(usage) {
  return usage && usage.service_tier === "batch" ? "batch" : "standard";
}

/**
 * 根据 (model, speed, geo, tier) 生成唯一的分桶 key。
 * 这样同一模型在不同 speed/geo/tier 下的 token 不会相互覆盖。
 */
function bucketKey(model, speed, geo, tier) {
  return [model, speed, geo, tier].join(BUCKET_SEP);
}

/**
 * 创建一个空的 token 分桶对象。
 * cacheWrite1h 用于单独统计 1h 缓存写入量（成本结构不同）。
 */
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

/**
 * 从 Claude Code 的 usage 对象中提取并归一化 token 字段。
 *
 * 兼容性处理：
 * - 新版 usage 直接提供 cache_creation_input_tokens。
 * - 旧版 usage 可能只提供 cache_creation.ephemeral_5m_input_tokens /
 *   ephemeral_1h_input_tokens，需要把它们相加作为 cacheWrite。
 * - cacheWrite1h 是 cacheWrite 中属于 1h ephemeral 缓存的部分，
 *   用 Math.min 保证不超过总 cacheWrite。
 */
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

  // 优先使用显式的 cache_creation_input_tokens；不存在时再回退到旧结构相加。
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

/**
 * 将源分桶的数值累加到目标分桶。用于增量解析转录本时合并同一分桶的 token。
 */
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
