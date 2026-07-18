const fs = require("fs");
const {
  bucketKey,
  emptyBucket,
  extractUsageFields,
  normalizeSpeed,
  normalizeGeo,
  normalizeTier,
  accumulateBucket,
} = require("./token-usage");

const MAX_CACHE_ENTRIES = 200;

const INTERRUPT_RE = /\[Request interrupted by user/i;

function computePendingInterrupt(lastInterruptTs, lastTurnTs) {
  if (!lastInterruptTs) return false;
  if (!lastTurnTs) return true;
  return lastInterruptTs >= lastTurnTs;
}

function hasInterruptText(message) {
  if (!message || typeof message !== "object") return false;
  const c = message.content;
  if (typeof c === "string") return INTERRUPT_RE.test(c);
  if (Array.isArray(c)) {
    for (const block of c) {
      if (block && typeof block.text === "string" && INTERRUPT_RE.test(block.text)) return true;
    }
  }
  return false;
}

const MAX_ARRAY_LEN = (() => {
  const raw = parseInt(process.env.TRANSCRIPT_CACHE_MAX_ARRAY_LEN, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

const PARSE_TRIM_WATERMARK = MAX_ARRAY_LEN * 2;

const FIRST_USER_MESSAGE_MAX_LEN = 500;

const SYNTHETIC_USER_TEXT_RE =
  /^<(?:command-name|command-message|local-command-stdout|local-command-caveat)>/;

function extractFirstUserText(entry) {
  if (entry.isMeta || entry.isCompactSummary) return null;
  if (entry.interruptedMessageId != null || hasInterruptText(entry.message)) return null;
  const msg = entry.message;
  if (!msg || typeof msg !== "object" || msg.role !== "user") return null;
  const content = msg.content;
  let text = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    
    
    if (content.some((b) => b && b.type === "tool_result")) return null;
    text = content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  if (typeof text !== "string") return null;
  
  text = text.replace(/\s+/g, " ").trim();
  if (!text || SYNTHETIC_USER_TEXT_RE.test(text)) return null;
  return text.length > FIRST_USER_MESSAGE_MAX_LEN
    ? text.slice(0, FIRST_USER_MESSAGE_MAX_LEN)
    : text;
}

class TranscriptCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this._cache = new Map();
    this._maxEntries = maxEntries;
    this._hits = 0;
    this._misses = 0;
  }

  

  extract(transcriptPath) {
    if (!transcriptPath) return null;
    try {
      let stat;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        return null;
      }
      const key = transcriptPath;
      const cached = this._cache.get(key);

      
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        this._hits++;
        return cached.result;
      }

      this._misses++;
      
      if (!cached || stat.size < cached.bytesRead) {
        const result = this._fullRead(transcriptPath);
        this._set(key, { mtimeMs: stat.mtimeMs, size: stat.size, bytesRead: stat.size, result });
        return result;
      }

      
      if (stat.size > cached.bytesRead) {
        const incremental = this._streamRange(transcriptPath, cached.bytesRead, stat.size);
        if (incremental) {
          const merged = this._merge(cached, incremental);
          const hasTokens = Object.keys(merged.tokensByModel).length > 0;
          const hasTurnDurations = merged.turnDurations && merged.turnDurations.length > 0;
          const hasUsageExtras =
            merged.usageExtras &&
            (merged.usageExtras.service_tiers.length > 0 ||
              merged.usageExtras.speeds.length > 0 ||
              merged.usageExtras.inference_geos.length > 0);
          const result = {
            tokensByModel: hasTokens ? merged.tokensByModel : null,
            compaction: merged.compaction,
            errors: merged.errors,
            turnDurations: hasTurnDurations ? merged.turnDurations : null,
            thinkingBlockCount: merged.thinkingBlockCount || 0,
            usageExtras: hasUsageExtras ? merged.usageExtras : null,
            latestModel: merged.latestModel || null,
            customTitle: merged.customTitle || null,
            aiTitle: merged.aiTitle || null,
            firstUserMessage: merged.firstUserMessage || null,
            lastInterruptTs: merged.lastInterruptTs || null,
            lastTurnTs: merged.lastTurnTs || null,
            pendingInterrupt: computePendingInterrupt(merged.lastInterruptTs, merged.lastTurnTs),
          };
          if (
            !result.tokensByModel &&
            !result.compaction &&
            !result.errors &&
            !result.turnDurations &&
            !result.thinkingBlockCount &&
            !result.usageExtras &&
            !result.latestModel &&
            !result.customTitle &&
            !result.aiTitle &&
            !result.firstUserMessage &&
            !result.lastInterruptTs &&
            !result.lastTurnTs
          ) {
            this._set(key, {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              bytesRead: stat.size,
              result: null,
            });
            return null;
          }
          this._set(key, { mtimeMs: stat.mtimeMs, size: stat.size, bytesRead: stat.size, result });
          return result;
        }

        
        this._set(key, {
          ...cached,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          bytesRead: stat.size,
        });
        return cached.result;
      }

      
      const result = this._fullRead(transcriptPath);
      this._set(key, { mtimeMs: stat.mtimeMs, size: stat.size, bytesRead: stat.size, result });
      return result;
    } catch {
      return null;
    }
  }

  

  extractCompactions(transcriptPath) {
    const result = this.extract(transcriptPath);
    if (!result || !result.compaction) return [];
    return result.compaction.entries.map((e) => ({ ...e }));
  }

  

  _fullRead(filePath) {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return null;
    }
    return this._streamRange(filePath, 0, size);
  }

  

  _streamRange(filePath, startOffset, endOffset) {
    const state = this._initParseState();
    if (endOffset <= startOffset) return this._finalizeState(state);

    const CHUNK = 4 * 1024 * 1024; 
    const MAX_PENDING = 64 * 1024 * 1024; 
    const buf = Buffer.allocUnsafe(CHUNK);
    let pending = null; 
    let pendingLen = 0;
    let pos = startOffset;
    let fd;
    try {
      try {
        fd = fs.openSync(filePath, "r");
      } catch {
        return this._finalizeState(state);
      }

      while (pos < endOffset) {
        const want = Math.min(CHUNK, endOffset - pos);
        let got;
        try {
          got = fs.readSync(fd, buf, 0, want, pos);
        } catch {
          break;
        }
        if (got <= 0) break;
        pos += got;

        let lineStart = 0;
        for (let i = 0; i < got; i++) {
          if (buf[i] !== 0x0a) continue;

          let line;
          if (pendingLen) {
            const need = pendingLen + (i - lineStart);
            const lineBuf = Buffer.allocUnsafe(need);
            pending.copy(lineBuf, 0, 0, pendingLen);
            buf.copy(lineBuf, pendingLen, lineStart, i);
            line = lineBuf.toString("utf8");
            pending = null;
            pendingLen = 0;
          } else {
            line = buf.toString("utf8", lineStart, i);
          }
          if (line.length && line.charCodeAt(line.length - 1) === 13) {
            line = line.slice(0, -1); 
          }
          if (line) this._consumeLine(line, state);
          lineStart = i + 1;
        }

        if (lineStart < got) {
          const tailLen = got - lineStart;
          const newLen = pendingLen + tailLen;
          if (newLen > MAX_PENDING) {
            
            
            
            pending = null;
            pendingLen = 0;
          } else {
            if (!pending) {
              pending = Buffer.allocUnsafe(Math.max(newLen, 8192));
            } else if (pending.length < newLen) {
              const grow = Buffer.allocUnsafe(Math.max(newLen, pending.length * 2));
              pending.copy(grow, 0, 0, pendingLen);
              pending = grow;
            }
            buf.copy(pending, pendingLen, lineStart, got);
            pendingLen = newLen;
          }
        }
      }

      if (pendingLen) {
        let line = pending.toString("utf8", 0, pendingLen);
        if (line.length && line.charCodeAt(line.length - 1) === 13) {
          line = line.slice(0, -1);
        }
        if (line) this._consumeLine(line, state);
      }
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          
        }
      }
    }

    return this._finalizeState(state);
  }

  _initParseState() {
    return {
      tokensByModel: {},
      compaction: null,
      errors: [],
      turnDurations: [],
      thinkingBlockCount: 0,
      usageExtras: {
        service_tiers: new Set(),
        speeds: new Set(),
        inference_geos: new Set(),
      },
      
      
      
      
      latestModel: null,
      
      
      
      
      
      customTitle: null,
      aiTitle: null,
      
      
      
      
      
      firstUserMessage: null,
      
      
      
      
      
      
      
      
      lastInterruptTs: null,
      lastTurnTs: null,
    };
  }

  _consumeLine(line, state) {
    if (!line) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }

    
    
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

    
    
    
    if (
      entry.type === "user" &&
      (entry.interruptedMessageId != null || hasInterruptText(entry.message))
    ) {
      if (entry.timestamp) state.lastInterruptTs = entry.timestamp;
      return;
    }

    
    
    
    
    if ((entry.type === "assistant" || entry.type === "user") && entry.timestamp) {
      if (!state.lastTurnTs || entry.timestamp > state.lastTurnTs)
        state.lastTurnTs = entry.timestamp;
    }

    
    
    
    if (state.firstUserMessage === null && entry.type === "user") {
      const firstText = extractFirstUserText(entry);
      if (firstText) state.firstUserMessage = firstText;
    }

    if (entry.isCompactSummary) {
      if (!state.compaction) state.compaction = { count: 0, entries: [] };
      state.compaction.count++;
      state.compaction.entries.push({
        uuid: entry.uuid || null,
        timestamp: entry.timestamp || null,
      });
      if (state.compaction.entries.length >= PARSE_TRIM_WATERMARK) {
        this._trimArray(state.compaction.entries);
      }
    }

    if (entry.type === "system" && entry.subtype === "turn_duration" && entry.durationMs) {
      const turnTs = entry.timestamp
        ? typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString()
          : entry.timestamp
        : null;
      state.turnDurations.push({ durationMs: entry.durationMs, timestamp: turnTs });
      if (state.turnDurations.length >= PARSE_TRIM_WATERMARK) {
        this._trimArray(state.turnDurations);
      }
    }

    const msg = entry.message || entry;
    if (msg.type === "error" && msg.error) {
      state.errors.push({
        type: msg.error.type || "unknown_error",
        message: msg.error.message || "Unknown API error",
        timestamp: entry.timestamp || null,
      });
      if (state.errors.length >= PARSE_TRIM_WATERMARK) {
        this._trimArray(state.errors);
      }
      return;
    }

    if (entry.isApiErrorMessage) {
      const errContent = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const errText = errContent[0]?.text ? errContent[0].text.slice(0, 500) : "Unknown error";
      state.errors.push({
        type: entry.error || "unknown_error",
        message: errText,
        timestamp: entry.timestamp || null,
      });
      if (state.errors.length >= PARSE_TRIM_WATERMARK) {
        this._trimArray(state.errors);
      }
      return;
    }

    const model = msg.model;
    if (!model || model === "<synthetic>" || !msg.usage) return;
    state.latestModel = model;
    
    
    
    const speed = normalizeSpeed(msg.usage);
    const geo = normalizeGeo(msg.usage);
    const tier = normalizeTier(msg.usage);
    const key = bucketKey(model, speed, geo, tier);
    if (!state.tokensByModel[key]) {
      state.tokensByModel[key] = emptyBucket(model, speed, geo, tier);
    }
    accumulateBucket(state.tokensByModel[key], extractUsageFields(msg.usage));

    if (msg.usage.service_tier) state.usageExtras.service_tiers.add(msg.usage.service_tier);
    if (msg.usage.speed) state.usageExtras.speeds.add(msg.usage.speed);
    if (msg.usage.inference_geo && msg.usage.inference_geo !== "not_available") {
      state.usageExtras.inference_geos.add(msg.usage.inference_geo);
    }

    const msgContent = msg.content || [];
    if (Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (block.type === "thinking") state.thinkingBlockCount++;
      }
    }
  }

  _finalizeState(state) {
    const hasTokens = Object.keys(state.tokensByModel).length > 0;
    const hasErrors = state.errors.length > 0;
    const hasTurnDurations = state.turnDurations.length > 0;
    const hasUsageExtras =
      state.usageExtras.service_tiers.size > 0 ||
      state.usageExtras.speeds.size > 0 ||
      state.usageExtras.inference_geos.size > 0;
    if (
      !hasTokens &&
      !state.compaction &&
      !hasErrors &&
      !hasTurnDurations &&
      !state.thinkingBlockCount &&
      !hasUsageExtras &&
      !state.latestModel &&
      !state.customTitle &&
      !state.aiTitle &&
      !state.firstUserMessage &&
      !state.lastInterruptTs &&
      !state.lastTurnTs
    ) {
      return null;
    }

    this._trimArray(state.errors);
    this._trimArray(state.turnDurations);
    if (state.compaction) this._trimArray(state.compaction.entries);

    
    
    const serializedExtras = hasUsageExtras
      ? {
          service_tiers: this._capArrayFromSet(state.usageExtras.service_tiers),
          speeds: this._capArrayFromSet(state.usageExtras.speeds),
          inference_geos: this._capArrayFromSet(state.usageExtras.inference_geos),
        }
      : null;

    return {
      tokensByModel: hasTokens ? state.tokensByModel : null,
      compaction: state.compaction,
      errors: hasErrors ? state.errors : null,
      turnDurations: hasTurnDurations ? state.turnDurations : null,
      thinkingBlockCount: state.thinkingBlockCount,
      usageExtras: serializedExtras,
      latestModel: state.latestModel,
      customTitle: state.customTitle,
      aiTitle: state.aiTitle,
      firstUserMessage: state.firstUserMessage,
      lastInterruptTs: state.lastInterruptTs,
      lastTurnTs: state.lastTurnTs,
      pendingInterrupt: computePendingInterrupt(state.lastInterruptTs, state.lastTurnTs),
    };
  }

  

  _parseContent(content) {
    const state = this._initParseState();
    let start = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) !== 10) continue;
      let line = content.slice(start, i);
      if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (line) this._consumeLine(line, state);
      start = i + 1;
    }
    if (start < content.length) {
      let line = content.slice(start);
      if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (line) this._consumeLine(line, state);
    }
    return this._finalizeState(state);
  }

  _merge(cached, incremental) {
    const tokensByModel = cached.result?.tokensByModel
      ? this._cloneTokens(cached.result.tokensByModel)
      : {};
    if (incremental && incremental.tokensByModel) {
      for (const [key, tokens] of Object.entries(incremental.tokensByModel)) {
        if (!tokensByModel[key]) {
          tokensByModel[key] = emptyBucket(tokens.model, tokens.speed, tokens.geo, tokens.tier);
        }
        accumulateBucket(tokensByModel[key], tokens);
      }
    }

    let compaction = cached.result?.compaction
      ? this._cloneCompaction(cached.result.compaction)
      : null;
    if (incremental && incremental.compaction) {
      if (!compaction) compaction = { count: 0, entries: [] };
      compaction.count += incremental.compaction.count;
      compaction.entries.push(...incremental.compaction.entries);
      this._trimArray(compaction.entries);
    }

    let errors = cached.result?.errors ? [...cached.result.errors] : null;
    if (incremental && incremental.errors) {
      if (!errors) errors = [];
      errors.push(...incremental.errors);
      this._trimArray(errors);
    }

    let turnDurations = cached.result?.turnDurations ? [...cached.result.turnDurations] : null;
    if (incremental && incremental.turnDurations) {
      if (!turnDurations) turnDurations = [];
      turnDurations.push(...incremental.turnDurations);
      this._trimArray(turnDurations);
    }

    const thinkingBlockCount =
      (cached.result?.thinkingBlockCount || 0) + (incremental?.thinkingBlockCount || 0);

    let usageExtras = cached.result?.usageExtras
      ? this._cloneUsageExtras(cached.result.usageExtras)
      : null;
    if (incremental && incremental.usageExtras) {
      if (!usageExtras) {
        usageExtras = { service_tiers: [], speeds: [], inference_geos: [] };
      }
      
      const merged = {
        service_tiers: new Set([
          ...usageExtras.service_tiers,
          ...incremental.usageExtras.service_tiers,
        ]),
        speeds: new Set([...usageExtras.speeds, ...incremental.usageExtras.speeds]),
        inference_geos: new Set([
          ...usageExtras.inference_geos,
          ...incremental.usageExtras.inference_geos,
        ]),
      };
      usageExtras = {
        service_tiers: this._capArrayFromSet(merged.service_tiers),
        speeds: this._capArrayFromSet(merged.speeds),
        inference_geos: this._capArrayFromSet(merged.inference_geos),
      };
    }

    
    
    
    const latestModel =
      (incremental && incremental.latestModel) || cached.result?.latestModel || null;

    
    
    const customTitle =
      (incremental && incremental.customTitle) || cached.result?.customTitle || null;
    const aiTitle = (incremental && incremental.aiTitle) || cached.result?.aiTitle || null;

    
    
    
    const firstUserMessage =
      cached.result?.firstUserMessage || (incremental && incremental.firstUserMessage) || null;

    
    
    
    const lastInterruptTs =
      (incremental && incremental.lastInterruptTs) || cached.result?.lastInterruptTs || null;
    const lastTurnTs = (incremental && incremental.lastTurnTs) || cached.result?.lastTurnTs || null;

    return {
      tokensByModel,
      compaction,
      errors,
      turnDurations,
      thinkingBlockCount,
      usageExtras,
      latestModel,
      customTitle,
      aiTitle,
      firstUserMessage,
      lastInterruptTs,
      lastTurnTs,
    };
  }

  _cloneTokens(tokensByModel) {
    if (!tokensByModel) return null;
    const clone = {};
    for (const [model, t] of Object.entries(tokensByModel)) {
      clone[model] = { ...t };
    }
    return clone;
  }

  _cloneCompaction(compaction) {
    if (!compaction) return null;
    return { count: compaction.count, entries: compaction.entries.map((e) => ({ ...e })) };
  }

  _cloneUsageExtras(extras) {
    if (!extras) return null;
    return {
      service_tiers: [...(extras.service_tiers || [])],
      speeds: [...(extras.speeds || [])],
      inference_geos: [...(extras.inference_geos || [])],
    };
  }

  
  _set(key, entry) {
    
    this._cache.delete(key);
    this._cache.set(key, entry);
    
    while (this._cache.size > this._maxEntries) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  
  _trimArray(arr, maxLen = MAX_ARRAY_LEN) {
    if (!arr || !Array.isArray(arr) || arr.length <= maxLen) return;
    arr.splice(0, arr.length - maxLen);
  }

  
  _capArrayFromSet(set) {
    const arr = [...set];
    this._trimArray(arr);
    return arr;
  }

  
  get size() {
    return this._cache.size;
  }

  
  invalidate(transcriptPath) {
    this._cache.delete(transcriptPath);
  }

  
  clear() {
    this._cache.clear();
  }

  
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
