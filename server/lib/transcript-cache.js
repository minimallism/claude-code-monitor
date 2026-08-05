const fs = require("fs");
const {
  bucketKey,
  emptyBucket,
  extractUsageFields,
  accumulateBucket,
} = require("./token-usage");

// 转录本缓存最多保留 200 条记录，避免大项目运行时内存无限增长。
const MAX_CACHE_ENTRIES = 200;

// 识别 Claude Code 在用户按 Ctrl+C 时写入的中断标记。
const INTERRUPT_RE = /\[Request interrupted by user/i;

/**
 * 判断是否存在"待处理"的用户中断：
 * 最近的中断时间戳 >= 最近的轮次时间戳，说明中断后还没有新的 assistant/user 轮次。
 */
function computePendingInterrupt(lastInterruptTs, lastTurnTs) {
  if (!lastInterruptTs) return false;
  if (!lastTurnTs) return true;
  return lastInterruptTs >= lastTurnTs;
}

/**
 * 检查消息内容里是否包含用户中断文本。
 */
function hasInterruptText(message) {
  if (!message || typeof message !== "object") return false;
  const content = message.content;
  if (typeof content === "string") return INTERRUPT_RE.test(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block.text === "string" && INTERRUPT_RE.test(block.text)) return true;
    }
  }
  return false;
}

// 缓存中 turnDurations 等数组的最大长度，防止单条缓存对象无限增长。
const MAX_ARRAY_LEN = (() => {
  const parsedEnvValue = parseInt(process.env.TRANSCRIPT_CACHE_MAX_ARRAY_LEN, 10);
  return Number.isFinite(parsedEnvValue) && parsedEnvValue > 0 ? parsedEnvValue : 1000;
})();

// 当数组长度超过 MAX_ARRAY_LEN 两倍时触发裁剪，降低频繁裁剪开销。
const PARSE_TRIM_WATERMARK = MAX_ARRAY_LEN * 2;

const FIRST_USER_MESSAGE_MAX_LEN = 500;

// 排除由本地命令输出合成的"伪用户文本"，避免把命令回显当作会话标题。
const SYNTHETIC_USER_TEXT_RE =
  /^<(?:command-name|command-message|local-command-stdout|local-command-caveat)>/;

/**
 * 从 user 条目中提取第一条真实用户输入文本，用于生成会话/主 agent 默认名称。
 */
function extractFirstUserText(entry) {
  if (entry.isMeta || entry.isCompactSummary) return null;
  if (entry.interruptedMessageId != null || hasInterruptText(entry.message)) return null;
  const message = entry.message;
  if (!message || typeof message !== "object" || message.role !== "user") return null;
  const content = message.content;
  let text = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // 如果 user 消息包含 tool_result，说明这是工具结果回显，不是用户原始输入。
    if (content.some((block) => block && block.type === "tool_result")) return null;
    text = content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ");
  }
  if (typeof text !== "string") return null;

  // 规范化空白并排除本地命令合成的文本。
  text = text.replace(/\s+/g, " ").trim();
  if (!text || SYNTHETIC_USER_TEXT_RE.test(text)) return null;
  return text.length > FIRST_USER_MESSAGE_MAX_LEN
    ? text.slice(0, FIRST_USER_MESSAGE_MAX_LEN)
    : text;
}

/**
 * 转录本解析缓存。
 *
 * 设计要点：
 * - 按文件路径缓存解析结果，避免重复全量读取大 JSONL 文件。
 * - 通过 mtimeMs 判断文件是否变化；若未变化直接返回缓存（热路径）。
 * - 文件变化时全量重新解析（JSONL 文件通常较小，全量解析耗时可忽略）。
 */
class TranscriptCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this._cache = new Map();
    this._maxEntries = maxEntries;
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * 提取转录本的聚合信息。返回 null 表示没有可用数据。
   */
  extract(transcriptPath) {
    if (!transcriptPath) return null;
    try {
      let stat;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        return null;
      }
      const cachedEntry = this._cache.get(transcriptPath);

      // 缓存命中：文件 mtime 没变，直接返回缓存结果。
      if (cachedEntry && cachedEntry.mtimeMs === stat.mtimeMs) {
        this._hits++;
        return cachedEntry.result;
      }

      this._misses++;
      const result = this._fullRead(transcriptPath);
      this._set(transcriptPath, { mtimeMs: stat.mtimeMs, result });
      return result;
    } catch {
      return null;
    }
  }

  /**
   * 全量读取转录本文件，按行解析 JSONL。
   */
  _fullRead(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    const state = this._initParseState();
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed) this._consumeLine(trimmed, state);
    }
    return this._finalizeState(state);
  }

  /**
   * 初始化解析状态对象。所有字段在逐行解析过程中累积。
   */
  _initParseState() {
    return {
      tokensByModel: {},
      turnDurations: [],
      // 最后一条 assistant 消息使用的模型。
      latestModel: null,
      // 用户自定义标题 / AI 生成标题。
      customTitle: null,
      aiTitle: null,
      // 第一条真实用户输入文本。
      firstUserMessage: null,
      // 用于判断是否存在未恢复的用户中断。
      lastInterruptTs: null,
      lastTurnTs: null,
    };
  }

  /**
   * 消费单行 JSONL，更新解析状态。
   */
  _consumeLine(line, state) {
    if (!line) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }

    // 标题类条目单独处理，不进入 token/轮次统计。
    if (entry.type === "custom-title") {
      if (typeof entry.customTitle === "string" && entry.customTitle.trim()) {
        state.customTitle = entry.customTitle;
      }
      return;
    }
    if (entry.type === "ai-title") {
      if (typeof entry.aiTitle === "string" && entry.aiTitle.trim()) {
        state.aiTitle = entry.aiTitle;
      }
      return;
    }

    // 用户中断条目：记录最后中断时间戳，并跳过 token 统计。
    if (
      entry.type === "user" &&
      (entry.interruptedMessageId != null || hasInterruptText(entry.message))
    ) {
      if (entry.timestamp) state.lastInterruptTs = entry.timestamp;
      return;
    }

    // 每遇到一条 assistant/user 消息，更新最后轮次时间戳，
    // 用于与 lastInterruptTs 比较判断中断是否已恢复。
    if ((entry.type === "assistant" || entry.type === "user") && entry.timestamp) {
      if (!state.lastTurnTs || entry.timestamp > state.lastTurnTs)
        state.lastTurnTs = entry.timestamp;
    }

    // 只取第一条真实用户消息作为会话标题候选。
    if (state.firstUserMessage === null && entry.type === "user") {
      const firstText = extractFirstUserText(entry);
      if (firstText) state.firstUserMessage = firstText;
    }

    // turn_duration 系统事件：累加每次用户到 assistant 的完整轮次耗时。
    if (entry.type === "system" && entry.subtype === "turn_duration" && entry.durationMs) {
      const turnTimestamp = entry.timestamp
        ? typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString()
          : entry.timestamp
        : null;
      state.turnDurations.push({ durationMs: entry.durationMs, timestamp: turnTimestamp });
      if (state.turnDurations.length >= PARSE_TRIM_WATERMARK) {
        this._trimArray(state.turnDurations);
      }
    }

    // 只对 assistant 消息做 token 统计；user 消息没有 usage。
    if (entry.type !== "assistant" || !entry.message) return;
    const message = entry.message;
    const model = message.model;
    // <synthetic> 是占位模型名，没有真实 usage，应忽略。
    if (!model || model === "<synthetic>" || !message.usage) return;
    state.latestModel = model;

    // 按 model 分桶累加 token。
    const key = bucketKey(model);
    if (!state.tokensByModel[key]) {
      state.tokensByModel[key] = emptyBucket(model);
    }
    accumulateBucket(state.tokensByModel[key], extractUsageFields(message.usage));
  }

  /**
   * 把解析状态整理为最终返回对象。
   * 所有空集合/空数组都规范化为 null，减少对象体积。
   */
  _finalizeState(state) {
    const hasTokens = Object.keys(state.tokensByModel).length > 0;
    const hasTurnDurations = state.turnDurations.length > 0;
    if (
      !hasTokens &&
      !hasTurnDurations &&
      !state.latestModel &&
      !state.customTitle &&
      !state.aiTitle &&
      !state.firstUserMessage &&
      !state.lastInterruptTs &&
      !state.lastTurnTs
    ) {
      return null;
    }

    this._trimArray(state.turnDurations);

    return {
      tokensByModel: hasTokens ? state.tokensByModel : null,
      turnDurations: hasTurnDurations ? state.turnDurations : null,
      latestModel: state.latestModel,
      customTitle: state.customTitle,
      aiTitle: state.aiTitle,
      firstUserMessage: state.firstUserMessage,
      lastInterruptTs: state.lastInterruptTs,
      lastTurnTs: state.lastTurnTs,
      pendingInterrupt: computePendingInterrupt(state.lastInterruptTs, state.lastTurnTs),
    };
  }

  /**
   * 写入缓存。先 delete 再 set 是为了把 key 移动到 Map 末尾（最近使用），
   * 超出容量时删除最旧的 key（Map 头部）。
   */
  _set(key, entry) {
    this._cache.delete(key);
    this._cache.set(key, entry);

    while (this._cache.size > this._maxEntries) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  /**
   * 限制数组长度，保留末尾最新的 maxLength 条。
   */
  _trimArray(array, maxLength = MAX_ARRAY_LEN) {
    if (!array || !Array.isArray(array) || array.length <= maxLength) return;
    array.splice(0, array.length - maxLength);
  }

  /** 当前缓存条目数。 */
  get size() {
    return this._cache.size;
  }

  /** 使指定转录本缓存失效。 */
  invalidate(transcriptPath) {
    this._cache.delete(transcriptPath);
  }

  /** 清空缓存。 */
  clear() {
    this._cache.clear();
  }

  /** 返回缓存命中率等统计信息，便于调试。 */
  stats() {
    const total = this._hits + this._misses;
    return {
      size: this._cache.size,
      maxSize: this._maxEntries,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? +((this._hits / total) * 100).toFixed(1) : 0,
      keys: [...this._cache.keys()],
    };
  }
}

module.exports = TranscriptCache;
module.exports.extractFirstUserText = extractFirstUserText;
