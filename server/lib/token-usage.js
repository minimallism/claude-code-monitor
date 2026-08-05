/**
 * 根据模型名生成唯一的分桶 key。
 * 直接用 model 名作为 key。
 */
function bucketKey(model) {
  return model || "unknown";
}

/**
 * 创建一个空的 token 分桶对象。
 */
function emptyBucket(model) {
  return {
    model,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

/**
 * 从 Claude Code 的 usage 对象中提取并归一化 token 字段。
 *
 * 兼容性处理：
 * - 新版 usage 直接提供 cache_creation_input_tokens。
 * - 旧版 usage 可能只提供 cache_creation.ephemeral_5m_input_tokens /
 *   ephemeral_1h_input_tokens，需要把它们相加作为 cacheWrite。
 */
function extractUsageFields(usage) {
  if (!usage || typeof usage !== "object") {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
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

  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite,
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
  return target;
}

module.exports = {
  bucketKey,
  emptyBucket,
  extractUsageFields,
  accumulateBucket,
};
