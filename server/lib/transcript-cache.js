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
  const content = message.content;
  if (typeof content === "string") return INTERRUPT_RE.test(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block.text === "string" && INTERRUPT_RE.test(block.text)) return true;
    }
  }
  return false;
}

const MAX_ARRAY_LEN = (() => {
  const parsedEnvValue = parseInt(process.env.TRANSCRIPT_CACHE_MAX_ARRAY_LEN, 10);
  return Number.isFinite(parsedEnvValue) && parsedEnvValue > 0 ? parsedEnvValue : 1000;
})();

const PARSE_TRIM_WATERMARK = MAX_ARRAY_LEN * 2;

const FIRST_USER_MESSAGE_MAX_LEN = 500;

const SYNTHETIC_USER_TEXT_RE =
  /^<(?:command-name|command-message|local-command-stdout|local-command-caveat)>/;

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
    
    
    if (content.some((block) => block && block.type === "tool_result")) return null;
    text = content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
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
      const cacheKey = transcriptPath;
      const cachedEntry = this._cache.get(cacheKey);

      
      if (cachedEntry && cachedEntry.mtimeMs === stat.mtimeMs && cachedEntry.size === stat.size) {
        this._hits++;
        return cachedEntry.result;
      }

      this._misses++;
      
      if (!cachedEntry || stat.size < cachedEntry.bytesRead) {
        const result = this._fullRead(transcriptPath);
        this._set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, bytesRead: stat.size, result });
        return result;
      }

      
      if (stat.size > cachedEntry.bytesRead) {
        const incrementalResult = this._streamRange(transcriptPath, cachedEntry.bytesRead, stat.size);
        if (incrementalResult) {
          const mergedResult = this._merge(cachedEntry, incrementalResult);
          const hasTokens = Object.keys(mergedResult.tokensByModel).length > 0;
          const hasTurnDurations = mergedResult.turnDurations && mergedResult.turnDurations.length > 0;
          const hasUsageExtras =
            mergedResult.usageExtras &&
            (mergedResult.usageExtras.service_tiers.length > 0 ||
              mergedResult.usageExtras.speeds.length > 0 ||
              mergedResult.usageExtras.inference_geos.length > 0);
          const result = {
            tokensByModel: hasTokens ? mergedResult.tokensByModel : null,
            turnDurations: hasTurnDurations ? mergedResult.turnDurations : null,
            thinkingBlockCount: mergedResult.thinkingBlockCount || 0,
            usageExtras: hasUsageExtras ? mergedResult.usageExtras : null,
            latestModel: mergedResult.latestModel || null,
            customTitle: mergedResult.customTitle || null,
            aiTitle: mergedResult.aiTitle || null,
            firstUserMessage: mergedResult.firstUserMessage || null,
            lastInterruptTs: mergedResult.lastInterruptTs || null,
            lastTurnTs: mergedResult.lastTurnTs || null,
            pendingInterrupt: computePendingInterrupt(mergedResult.lastInterruptTs, mergedResult.lastTurnTs),
          };
          if (
            !result.tokensByModel &&
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
            this._set(cacheKey, {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              bytesRead: stat.size,
              result: null,
            });
            return null;
          }
          this._set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, bytesRead: stat.size, result });
          return result;
        }

        
        this._set(cacheKey, {
          ...cachedEntry,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          bytesRead: stat.size,
        });
        return cachedEntry.result;
      }

      
      const result = this._fullRead(transcriptPath);
      this._set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, bytesRead: stat.size, result });
      return result;
    } catch {
      return null;
    }
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
    const readBuffer = Buffer.allocUnsafe(CHUNK);
    let pendingBuffer = null; 
    let pendingBufferLength = 0;
    let filePosition = startOffset;
    let fileDescriptor;
    try {
      try {
        fileDescriptor = fs.openSync(filePath, "r");
      } catch {
        return this._finalizeState(state);
      }

      while (filePosition < endOffset) {
        const bytesToRead = Math.min(CHUNK, endOffset - filePosition);
        let bytesRead;
        try {
          bytesRead = fs.readSync(fileDescriptor, readBuffer, 0, bytesToRead, filePosition);
        } catch {
          break;
        }
        if (bytesRead <= 0) break;
        filePosition += bytesRead;

        let lineStartOffset = 0;
        for (let byteIndex = 0; byteIndex < bytesRead; byteIndex++) {
          if (readBuffer[byteIndex] !== 0x0a) continue;

          let lineText;
          if (pendingBufferLength) {
            const lineBufferSize = pendingBufferLength + (byteIndex - lineStartOffset);
            const lineBuffer = Buffer.allocUnsafe(lineBufferSize);
            pendingBuffer.copy(lineBuffer, 0, 0, pendingBufferLength);
            readBuffer.copy(lineBuffer, pendingBufferLength, lineStartOffset, byteIndex);
            lineText = lineBuffer.toString("utf8");
            pendingBuffer = null;
            pendingBufferLength = 0;
          } else {
            lineText = readBuffer.toString("utf8", lineStartOffset, byteIndex);
          }
          if (lineText.length && lineText.charCodeAt(lineText.length - 1) === 13) {
            lineText = lineText.slice(0, -1); 
          }
          if (lineText) this._consumeLine(lineText, state);
          lineStartOffset = byteIndex + 1;
        }

        if (lineStartOffset < bytesRead) {
          const tailLength = bytesRead - lineStartOffset;
          const newPendingLength = pendingBufferLength + tailLength;
          if (newPendingLength > MAX_PENDING) {
            
            
            
            pendingBuffer = null;
            pendingBufferLength = 0;
          } else {
            if (!pendingBuffer) {
              pendingBuffer = Buffer.allocUnsafe(Math.max(newPendingLength, 8192));
            } else if (pendingBuffer.length < newPendingLength) {
              const grownBuffer = Buffer.allocUnsafe(Math.max(newPendingLength, pendingBuffer.length * 2));
              pendingBuffer.copy(grownBuffer, 0, 0, pendingBufferLength);
              pendingBuffer = grownBuffer;
            }
            readBuffer.copy(pendingBuffer, pendingBufferLength, lineStartOffset, bytesRead);
            pendingBufferLength = newPendingLength;
          }
        }
      }

      if (pendingBufferLength) {
        let lineText = pendingBuffer.toString("utf8", 0, pendingBufferLength);
        if (lineText.length && lineText.charCodeAt(lineText.length - 1) === 13) {
          lineText = lineText.slice(0, -1);
        }
        if (lineText) this._consumeLine(lineText, state);
      }
    } finally {
      if (fileDescriptor !== undefined) {
        try {
          fs.closeSync(fileDescriptor);
        } catch {
          
        }
      }
    }

    return this._finalizeState(state);
  }

  _initParseState() {
    return {
      tokensByModel: {},
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

    if (entry.type !== "assistant" || !entry.message) return;
    const message = entry.message;
    const model = message.model;
    if (!model || model === "<synthetic>" || !message.usage) return;
    state.latestModel = model;
    
    
    
    const speed = normalizeSpeed(message.usage);
    const geo = normalizeGeo(message.usage);
    const tier = normalizeTier(message.usage);
    const key = bucketKey(model, speed, geo, tier);
    if (!state.tokensByModel[key]) {
      state.tokensByModel[key] = emptyBucket(model, speed, geo, tier);
    }
    accumulateBucket(state.tokensByModel[key], extractUsageFields(message.usage));

    if (message.usage.service_tier) state.usageExtras.service_tiers.add(message.usage.service_tier);
    if (message.usage.speed) state.usageExtras.speeds.add(message.usage.speed);
    if (message.usage.inference_geo && message.usage.inference_geo !== "not_available") {
      state.usageExtras.inference_geos.add(message.usage.inference_geo);
    }

    const messageContent = message.content || [];
    if (Array.isArray(messageContent)) {
      for (const block of messageContent) {
        if (block.type === "thinking") state.thinkingBlockCount++;
      }
    }
  }

  _finalizeState(state) {
    const hasTokens = Object.keys(state.tokensByModel).length > 0;
    const hasTurnDurations = state.turnDurations.length > 0;
    const hasUsageExtras =
      state.usageExtras.service_tiers.size > 0 ||
      state.usageExtras.speeds.size > 0 ||
      state.usageExtras.inference_geos.size > 0;
    if (
      !hasTokens &&
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

    this._trimArray(state.turnDurations);

    
    
    const serializedUsageExtras = hasUsageExtras
      ? {
          service_tiers: this._capArrayFromSet(state.usageExtras.service_tiers),
          speeds: this._capArrayFromSet(state.usageExtras.speeds),
          inference_geos: this._capArrayFromSet(state.usageExtras.inference_geos),
        }
      : null;

    return {
      tokensByModel: hasTokens ? state.tokensByModel : null,
      turnDurations: hasTurnDurations ? state.turnDurations : null,
      thinkingBlockCount: state.thinkingBlockCount,
      usageExtras: serializedUsageExtras,
      latestModel: state.latestModel,
      customTitle: state.customTitle,
      aiTitle: state.aiTitle,
      firstUserMessage: state.firstUserMessage,
      lastInterruptTs: state.lastInterruptTs,
      lastTurnTs: state.lastTurnTs,
      pendingInterrupt: computePendingInterrupt(state.lastInterruptTs, state.lastTurnTs),
    };
  }

  

  _merge(cachedEntry, incrementalResult) {
    const tokensByModel = cachedEntry.result?.tokensByModel
      ? this._cloneTokens(cachedEntry.result.tokensByModel)
      : {};
    if (incrementalResult && incrementalResult.tokensByModel) {
      for (const [key, tokens] of Object.entries(incrementalResult.tokensByModel)) {
        if (!tokensByModel[key]) {
          tokensByModel[key] = emptyBucket(tokens.model, tokens.speed, tokens.geo, tokens.tier);
        }
        accumulateBucket(tokensByModel[key], tokens);
      }
    }

    let turnDurations = cachedEntry.result?.turnDurations ? [...cachedEntry.result.turnDurations] : null;
    if (incrementalResult && incrementalResult.turnDurations) {
      if (!turnDurations) turnDurations = [];
      turnDurations.push(...incrementalResult.turnDurations);
      this._trimArray(turnDurations);
    }

    const thinkingBlockCount =
      (cachedEntry.result?.thinkingBlockCount || 0) + (incrementalResult?.thinkingBlockCount || 0);

    let usageExtras = cachedEntry.result?.usageExtras
      ? this._cloneUsageExtras(cachedEntry.result.usageExtras)
      : null;
    if (incrementalResult && incrementalResult.usageExtras) {
      if (!usageExtras) {
        usageExtras = { service_tiers: [], speeds: [], inference_geos: [] };
      }
      
      const mergedUsageSets = {
        service_tiers: new Set([
          ...usageExtras.service_tiers,
          ...incrementalResult.usageExtras.service_tiers,
        ]),
        speeds: new Set([...usageExtras.speeds, ...incrementalResult.usageExtras.speeds]),
        inference_geos: new Set([
          ...usageExtras.inference_geos,
          ...incrementalResult.usageExtras.inference_geos,
        ]),
      };
      usageExtras = {
        service_tiers: this._capArrayFromSet(mergedUsageSets.service_tiers),
        speeds: this._capArrayFromSet(mergedUsageSets.speeds),
        inference_geos: this._capArrayFromSet(mergedUsageSets.inference_geos),
      };
    }

    
    
    
    const latestModel =
      (incrementalResult && incrementalResult.latestModel) || cachedEntry.result?.latestModel || null;

    
    
    const customTitle =
      (incrementalResult && incrementalResult.customTitle) || cachedEntry.result?.customTitle || null;
    const aiTitle = (incrementalResult && incrementalResult.aiTitle) || cachedEntry.result?.aiTitle || null;

    
    
    
    const firstUserMessage =
      cachedEntry.result?.firstUserMessage || (incrementalResult && incrementalResult.firstUserMessage) || null;

    
    
    
    const lastInterruptTs =
      (incrementalResult && incrementalResult.lastInterruptTs) || cachedEntry.result?.lastInterruptTs || null;
    const lastTurnTs = (incrementalResult && incrementalResult.lastTurnTs) || cachedEntry.result?.lastTurnTs || null;

    return {
      tokensByModel,
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
    for (const [model, tokenBucket] of Object.entries(tokensByModel)) {
      clone[model] = { ...tokenBucket };
    }
    return clone;
  }

  _cloneUsageExtras(usageExtras) {
    if (!usageExtras) return null;
    return {
      service_tiers: [...(usageExtras.service_tiers || [])],
      speeds: [...(usageExtras.speeds || [])],
      inference_geos: [...(usageExtras.inference_geos || [])],
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

  
  _trimArray(array, maxLength = MAX_ARRAY_LEN) {
    if (!array || !Array.isArray(array) || array.length <= maxLength) return;
    array.splice(0, array.length - maxLength);
  }

  
  _capArrayFromSet(set) {
    const array = [...set];
    this._trimArray(array);
    return array;
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
