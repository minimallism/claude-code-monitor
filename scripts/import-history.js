#!/usr/bin/env node

/**
 * 历史会话导入脚本。
 *
 * 该脚本读取 Claude Code 在 ~/.claude/projects/ 下保存的 *.jsonl 会话转录文件，
 * 把会话、子 agent、token 用量、工具调用等数据导入到 dashboard 的 SQLite 数据库中。
 *
 * 主要能力：
 * - 首次全量导入（importAllSessions / importFromDirectory）。
 * - 基于文件 mtime 的增量同步（syncDefaultProjects）。
 * - token 总量校正（reconcileTokens）。
 * - 子 agent 关系重建（reconcileSubagentParents）。
 *
 * 设计要点：
 * - 幂等：重复导入同一文件不会创建重复记录，会更新元数据和缺失字段。
 * - 事务：批量导入使用 SQLite transaction，减少 I/O 开销。
 * - 容错：单文件解析失败不会中断整个导入流程。
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  bucketKey,
  emptyBucket,
  extractUsageFields,
  accumulateBucket,
} = require("../server/lib/token-usage");

const { getProjectsDir } = require("../server/lib/claude-home");
const { extractFirstUserText } = require("../server/lib/transcript-cache");
const PROJECTS_DIR = getProjectsDir();

/**
 * 把用户第一条消息截断为适合作为会话标题的短文本。
 * 超过 60 字符时保留前 57 字符并加省略号。
 */
function firstUserLabel(text) {
  const trimmedText = typeof text === "string" ? text.trim() : "";
  if (!trimmedText) return null;
  return trimmedText.length > 60 ? trimmedText.slice(0, 57) + "..." : trimmedText;
}

/**
 * 解析单个会话 JSONL 文件，提取会话级元数据和统计信息。
 *
 * 该函数逐行读取 JSONL，避免一次性加载大文件；返回的对象会被后续
 * importSession 写入数据库。关键字段：
 * - cwd / slug / model：会话上下文信息。
 * - tokensByModel：按模型/速度/地区/服务层级聚合的 token 用量。
 * - assistantToolUses / toolResultById：工具调用与结果，用于生成 events。
 * - parsedSubagents：由 parseSessionForImport 填充的子 agent 数据。
 */
async function parseSessionFile(filePath) {
  const sessionId = path.basename(filePath, ".jsonl");

  const lineReader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  // 会话上下文字段：按 JSONL 中首次出现的值为准，后续重复出现被忽略。
  let cwd = null;
  let model = null;
  let slug = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  const teams = new Set();
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  // Token 与工具调用统计。
  const tokensByModel = {};
  const assistantMessageTimestamps = [];
  const assistantToolUses = [];
  const turnDurationRecords = [];
  const toolResultErrors = [];
  const toolResultById = new Map();

  // 标题相关：custom-title / ai-title 条目优先级最高；否则用第一条用户消息。
  let customTitle = null;
  let aiTitle = null;
  let firstUserMessage = null;

  for await (const line of lineReader) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      if (entry.customTitle.trim()) customTitle = entry.customTitle.trim();
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
      if (entry.aiTitle.trim()) aiTitle = entry.aiTitle.trim();
      continue;
    }

    
    // 记录每轮对话的耗时（CC 在 system/turn_duration 中输出）。
    if (entry.type === "system" && entry.subtype === "turn_duration" && entry.durationMs) {
      const turnTimestamp = entry.timestamp
        ? typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString()
          : entry.timestamp
        : null;
      turnDurationRecords.push({ durationMs: entry.durationMs, timestamp: turnTimestamp });
    }

    // 首次出现的上下文字段生效；后续重复条目被忽略。
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!slug && entry.slug) slug = entry.slug;

    // 时间戳可能是 Unix 毫秒数或 ISO 字符串；统一转换为 ISO 字符串后比较。
    const ts = entry.timestamp;
    if (ts) {
      const isoTimestamp = typeof ts === "number" ? new Date(ts).toISOString() : ts;
      if (!firstTimestamp || isoTimestamp < firstTimestamp) firstTimestamp = isoTimestamp;
      if (!lastTimestamp || isoTimestamp > lastTimestamp) lastTimestamp = isoTimestamp;
    }

    if (entry.teamName) teams.add(entry.teamName);

    if (entry.type === "user") {
      userMessageCount++;
      if (firstUserMessage === null) {
        const firstText = extractFirstUserText(entry);
        if (firstText) firstUserMessage = firstText;
      }

      // 记录用户消息中的 tool result 错误（is_error=true）。
      if (
        entry.toolUseResult &&
        typeof entry.toolUseResult === "object" &&
        entry.toolUseResult.is_error
      ) {
        const content =
          typeof entry.toolUseResult.content === "string"
            ? entry.toolUseResult.content.slice(0, 500)
            : JSON.stringify(entry.toolUseResult.content || "").slice(0, 500);
        const errTs = entry.timestamp
          ? typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString()
            : entry.timestamp
          : null;
        toolResultErrors.push({ content, timestamp: errTs });
      }

      // 收集 tool_result 块，按 tool_use_id 索引，后续与 assistant 的 tool_use 配对。
      const messageContent = entry.message?.content;
      if (Array.isArray(messageContent)) {
        const resultTs = ts ? (typeof ts === "number" ? new Date(ts).toISOString() : ts) : null;
        for (const block of messageContent) {
          if (block && block.type === "tool_result" && block.tool_use_id) {
            toolResultById.set(block.tool_use_id, {
              content: block.content,
              is_error: !!block.is_error,
              timestamp: resultTs,
            });
          }
        }
      }
    }

    if (entry.type === "assistant") {
      assistantMessageCount++;
      const isoTimestamp = ts ? (typeof ts === "number" ? new Date(ts).toISOString() : ts) : null;
      if (isoTimestamp) assistantMessageTimestamps.push(isoTimestamp);

      const message = entry.message || {};
      const messageModel = message.model || null;
      if (!model && messageModel && messageModel !== "<synthetic>") model = messageModel;

      // 累积 token 用量，按模型分桶。
      if (messageModel && messageModel !== "<synthetic>" && message.usage) {
        const usage = message.usage;
        const key = bucketKey(messageModel);
        if (tokensByModel[key] === undefined) {
          tokensByModel[key] = emptyBucket(messageModel);
        }
        accumulateBucket(tokensByModel[key], extractUsageFields(usage));
      }

      // 收集 assistant 发起的 tool_use，后续生成 PreToolUse/PostToolUse 事件。
      const content = message.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            assistantToolUses.push({
              id: block.id || null,
              name: block.name,
              timestamp: isoTimestamp || firstTimestamp,
              input: block.input || null,
            });
          }
        }
      }
    }
  }

  // 没有时间戳说明是空文件或无效文件，直接丢弃。
  if (!firstTimestamp) return null;

  // 构造会话显示名称：customTitle > aiTitle > 第一条用户消息 > 回退名称。
  const projectName = cwd ? path.basename(cwd) : slug || `Session ${sessionId.slice(0, 8)}`;
  const fallbackName = slug
    ? `${projectName} (${slug})`
    : `${projectName} - ${sessionId.slice(0, 8)}`;
  const sessionName = customTitle || aiTitle || firstUserLabel(firstUserMessage) || fallbackName;

  // 记录文件修改时间，用于判断会话是否仍可能处于活跃状态。
  let fileModifiedAt = null;
  try {
    const stat = fs.statSync(filePath);
    fileModifiedAt = stat.mtimeMs;
  } catch {
    // 忽略无法获取 stat 的情况。
  }

  return {
    sessionId,
    name: sessionName,
    customTitle,
    aiTitle,
    firstUserMessage,
    cwd,
    model,
    slug,
    transcriptPath: filePath,
    startedAt: firstTimestamp,
    endedAt: lastTimestamp,
    teams: [...teams],
    tokensByModel,
    assistantMessageTimestamps,
    assistantToolUses,
    toolResultById,
    fileModifiedAt,
    turnDurationRecords,
    toolResultErrors,
  };
}

/**
 * 解析子 agent 的 JSONL 转录文件。
 *
 * 结构与 parseSessionFile 类似，但关注的是子 agent 特有字段：
 * - task：第一条用户消息内容，作为子 agent 的任务描述。
 * - agentType：从同名的 .meta.json（CC 2.x+）或 .existingMetadata.json 中读取。
 * - spawnedChildAgentIds：子 agent 通过 Agent 工具创建的孙 agent id 集合，
 *   用于后续 reconcileSubagentParents 重建层级关系。
 */
async function parseSubagentFile(filePath) {
  const agentId = path.basename(filePath, ".jsonl").replace(/^agent-/, "");

  const lineReader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let task = null;
  let model = null;
  let agentType = null;
  let description = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  const tokensByModel = {};
  const toolNames = new Set();

  // 子 agent 的工具调用与结果配对。
  const subagentToolCalls = [];
  const toolResultById = new Map();

  // 记录该子 agent 创建的子级 agent id。
  const spawnedChildAgentIds = new Set();

  for await (const line of lineReader) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // 子 agent 通过 Agent 工具创建新 agent 时，toolUseResult.agentId 会记录被创建 agent 的 id。
    if (entry.toolUseResult && entry.toolUseResult.agentId) {
      spawnedChildAgentIds.add(entry.toolUseResult.agentId);
    }

    const ts = entry.timestamp;
    let isoTimestamp = null;
    if (ts) {
      isoTimestamp = typeof ts === "number" ? new Date(ts).toISOString() : ts;
      if (!firstTimestamp || isoTimestamp < firstTimestamp) firstTimestamp = isoTimestamp;
      if (!lastTimestamp || isoTimestamp > lastTimestamp) lastTimestamp = isoTimestamp;
    }

    if (entry.type === "user") {
      const messageContent = entry.message?.content;
      // 用第一条用户文本作为子 agent 的 task 描述。
      if (!task) {
        if (typeof messageContent === "string") {
          task = messageContent.slice(0, 500);
        } else if (Array.isArray(messageContent)) {
          const textBlock = messageContent.find((tokenBucket) => tokenBucket && tokenBucket.type === "text");
          if (textBlock) task = (textBlock.text || "").slice(0, 500);
        }
      }
      if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (block && block.type === "tool_result" && block.tool_use_id) {
            toolResultById.set(block.tool_use_id, {
              content: block.content,
              is_error: !!block.is_error,
              timestamp: isoTimestamp,
            });
          }
        }
      }
    }

    if (entry.type === "assistant") {
      const message = entry.message || {};
      const messageModel = message.model || null;
      if (!model && messageModel && messageModel !== "<synthetic>") model = messageModel;
      if (messageModel && messageModel !== "<synthetic>" && message.usage) {
        const usage = message.usage;
        const key = bucketKey(messageModel);
        if (!tokensByModel[key]) {
          tokensByModel[key] = emptyBucket(messageModel);
        }
        accumulateBucket(tokensByModel[key], extractUsageFields(usage));
      }
      const content = message.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            toolNames.add(block.name);
            if (block.id) {
              subagentToolCalls.push({
                id: block.id,
                name: block.name,
                input: block.input || null,
                timestamp: isoTimestamp,
              });
            }
          }
        }
      }
    }
  }

  // 把子 agent 的工具调用和 tool_result 配对，生成标准化的工具事件。
  const normalizedToolEvents = subagentToolCalls.map((call) => {
    const result = toolResultById.get(call.id) || null;
    return {
      tool_use_id: call.id,
      tool_name: call.name,
      tool_input: call.input,
      pre_timestamp: call.timestamp,
      tool_response: result ? result.content : null,
      is_error: result ? result.is_error : false,
      post_timestamp: result ? result.timestamp : null,
    };
  });

  if (!firstTimestamp) return null;

  // 读取 CC 生成的元数据文件，获取 agentType 等额外信息。
  // 先尝试 .meta.json（CC 2.x+），再回退 .existingMetadata.json（旧版）。
  const metaPath = filePath.replace(/\.jsonl$/, ".meta.json");
  const legacyMetaPath = filePath.replace(/\.jsonl$/, ".existingMetadata.json");
  try {
    const resolvedMeta = fs.existsSync(metaPath) ? metaPath : (fs.existsSync(legacyMetaPath) ? legacyMetaPath : null);
    if (resolvedMeta) {
      const existingMetadata = JSON.parse(fs.readFileSync(resolvedMeta, "utf8"));
      if (existingMetadata.agentType) agentType = existingMetadata.agentType;
      if (existingMetadata.description) description = existingMetadata.description;
    }
  } catch {
    // 元数据文件不存在或损坏时忽略，agentType 保持 null。
  }

  return {
    agentId,
    agentType,
    description,
    task,
    model,
    startedAt: firstTimestamp,
    endedAt: lastTimestamp,
    tokensByModel,
    toolNames: [...toolNames],
    normalizedToolEvents,
    spawnedChildAgentIds: [...spawnedChildAgentIds],
  };
}

/**
 * 从主会话的 assistantToolUses 中推断出由 "Agent" 工具创建的子 agent。
 *
 * 旧版 CC 不会在子 agent 目录下生成独立 JSONL，只会在主会话中留下 Agent 工具的调用记录。
 * 该函数根据这些记录创建占位子 agent，状态固定为 completed。
 */
function importSubagents(dbModule, sessionId, mainAgentId, assistantToolUses) {
  if (!assistantToolUses || assistantToolUses.length === 0) return 0;
  const { stmts } = dbModule;
  const insertEvent = dbModule.db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  let created = 0;
  let agentIndex = 0;

  for (const toolUse of assistantToolUses) {
    if (toolUse.name !== "Agent" || !toolUse.input) continue;
    const input = toolUse.input;
    agentIndex++;

    // 生成确定性 id；如果已存在则跳过（幂等）。
    const subagentId = `${sessionId}-subagent-${agentIndex}`;
    if (stmts.getAgent.get(subagentId)) continue;

    const rawSubagentName =
      input.description ||
      input.subagent_type ||
      (input.prompt ? input.prompt.split("\n")[0].slice(0, 60) : null) ||
      "Subagent";
    const subagentName = rawSubagentName.length > 60 ? rawSubagentName.slice(0, 57) + "..." : rawSubagentName;
    const timestamp = toolUse.timestamp || new Date().toISOString();

    stmts.insertAgent.run(
      subagentId,
      sessionId,
      subagentName,
      "subagent",
      input.subagent_type || null,
      "completed",
      input.prompt ? input.prompt.slice(0, 500) : null,
      mainAgentId,
      null
    );
    dbModule.db
      .prepare("UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, timestamp, subagentId);

    insertEvent.run(
      sessionId,
      subagentId,
      "PreToolUse",
      "Agent",
      null,
      timestamp
    );
    created++;
  }
  return created;
}

// JSONL 子 agent 与数据库中实时子 agent 匹配时允许的时间误差（30 秒）。
const SUBAGENT_LIVE_MATCH_TOLERANCE_MS = 30_000;

/**
 * 根据 agentType 和 startedAt 把 JSONL 解析出的子 agent 与数据库中已有的实时子 agent 匹配。
 *
 * 实时子 agent 由 hooks 在会话运行期间创建，JSONL 子 agent 由历史导入创建；
 * 如果两者时间接近，则认为是同一个 agent，避免重复记录。
 */
function findLiveSubagentForJsonl(dbModule, sessionId, subagentData) {
  if (!subagentData.startedAt) return null;

  // 优先按 agentType + startedAt（30 秒容差）匹配。
  if (subagentData.agentType) {
    const match = dbModule.db
      .prepare(
        `SELECT id FROM agents
         WHERE session_id = ?
           AND type = 'subagent'
           AND subagent_type = ?
           AND id NOT LIKE ?
           AND ABS(CAST(strftime('%s', started_at) AS INTEGER) -
                   CAST(strftime('%s', ?) AS INTEGER)) <= ?
         ORDER BY ABS(CAST(strftime('%s', started_at) AS INTEGER) -
                      CAST(strftime('%s', ?) AS INTEGER)) ASC
         LIMIT 1`
      )
      .get(
        sessionId,
        subagentData.agentType,
        `${sessionId}-jsonl-%`,
        subagentData.startedAt,
        SUBAGENT_LIVE_MATCH_TOLERANCE_MS / 1000,
        subagentData.startedAt
      );
    if (match) return match;
  }

  // 回退：按 description 与数据库中的 name 前缀匹配。
  // live hook 创建时 name 截断到 57 字符 + "..."，这里截断到相同长度再匹配。
  if (subagentData.description) {
    const descPrefix = subagentData.description.length > 57
      ? subagentData.description.slice(0, 57)
      : subagentData.description;
    const match = dbModule.db
      .prepare(
        `SELECT id FROM agents
         WHERE session_id = ?
           AND type = 'subagent'
           AND id NOT LIKE ?
           AND name LIKE ?
         ORDER BY ABS(CAST(strftime('%s', started_at) AS INTEGER) -
                      CAST(strftime('%s', ?) AS INTEGER)) ASC
         LIMIT 1`
      )
      .get(
        sessionId,
        `${sessionId}-jsonl-%`,
        `${descPrefix}%`,
        subagentData.startedAt
      );
    if (match) return match;
  }

  return null;
}

/**
 * 合并主会话和所有子 agent 的 token 用量桶。
 *
 * 同一模型在不同 agent 间会产生独立的桶；
 * 合并后按 bucketKey 累加，得到会话级别的总用量。
 */
function combineSessionTokens(session) {
  const combined = {};
  const merge = (src) => {
    if (!src) return;
    for (const [key, tok] of Object.entries(src)) {
      if (!combined[key]) {
        combined[key] = emptyBucket(tok.model);
      }
      accumulateBucket(combined[key], tok);
    }
  };
  merge(session.tokensByModel);
  if (Array.isArray(session.parsedSubagents)) {
    for (const subagent of session.parsedSubagents) merge(subagent.tokensByModel);
  }
  return combined;
}

/**
 * 把合并后的 token 桶写入 token_usage 表。
 * 只有至少有一个非零用量字段的桶才会被写入。
 */
function writeSessionTokens(dbModule, sessionId, tokensByModel) {
  const { stmts } = dbModule;
  let written = 0;
  for (const tokens of Object.values(tokensByModel || {})) {
    if (
      (tokens.input || 0) > 0 ||
      (tokens.output || 0) > 0 ||
      (tokens.cacheRead || 0) > 0 ||
      (tokens.cacheWrite || 0) > 0
    ) {
      stmts.replaceTokenUsage.run(
        sessionId,
        tokens.model,
        tokens.input || 0,
        tokens.output || 0,
        tokens.cacheRead || 0,
        tokens.cacheWrite || 0
      );
      written++;
    }
  }
  return written;
}

/**
 * 把 JSONL 解析出的子 agent 导入数据库。
 *
 * 关键概念：
 * - jsonlDerivedSubagentId：由文件内容推导出的子 agent id，格式为 `<sessionId>-jsonl-<agentId>`。
 * - liveSubagentMatch：数据库中已存在、由实时 hooks 创建的子 agent；
 *   若匹配成功，则把 JSONL 中的元数据合并到该 live agent，而不是新建记录。
 * - targetAgentId：最终要写入元数据和事件的目标 agent id。
 *
 * 返回 { created, updated }，用于调用方判断是否需要刷新 UI。
 */
function importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subagentData) {
  if (!subagentData) return 0;
  const { db, stmts } = dbModule;

  const jsonlDerivedSubagentId = `${sessionId}-jsonl-${subagentData.agentId}`;
  const liveSubagentMatch = findLiveSubagentForJsonl(dbModule, sessionId, subagentData);
  const targetAgentId = liveSubagentMatch ? liveSubagentMatch.id : jsonlDerivedSubagentId;
  const existingJsonlAgent = stmts.getAgent.get(jsonlDerivedSubagentId);

  const subName = subagentData.agentType ? subagentData.agentType : `Subagent ${subagentData.agentId.slice(0, 8)}`;

  let created = 0;
  let updated = 0;

  // 如果既没有匹配到 live agent，也没有 jsonl 占位 agent，则新建一条 jsonl 来源记录。
  if (!liveSubagentMatch && !existingJsonlAgent) {
    stmts.insertAgent.run(
      jsonlDerivedSubagentId,
      sessionId,
      subName,
      "subagent",
      subagentData.agentType || null,
      "completed",
      subagentData.task,
      mainAgentId,
      JSON.stringify({
        imported: true,
        model: subagentData.model,
      })
    );
    db.prepare("UPDATE agents SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(
      subagentData.startedAt,
      subagentData.endedAt,
      subagentData.endedAt,
      jsonlDerivedSubagentId
    );
    created++;
  }

  // 无论新建还是匹配到 live agent，都尝试把缺失的元数据字段补齐到 targetAgentId。
  {
    const row = stmts.getAgent.get(targetAgentId);
    if (row) {
      let existingMetadata = {};
      try {
        existingMetadata = row.metadata ? JSON.parse(row.metadata) : {};
      } catch {
        existingMetadata = {};
      }
      let changed = false;
      if (subagentData.model && !existingMetadata.model) {
        existingMetadata.model = subagentData.model;
        changed = true;
      }
      if (changed) {
        db.prepare("UPDATE agents SET metadata = ? WHERE id = ?").run(
          JSON.stringify(existingMetadata),
          targetAgentId
        );
        updated++;
      }
    }
  }

  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  // 如果没匹配到 live agent，在主 agent 下补一条 Agent 工具的 PreToolUse 事件，表示子 agent 被创建。
  if (!liveSubagentMatch) {
    const spawnExists = db
      .prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND agent_id = ? AND event_type = 'PreToolUse' AND tool_name = 'Agent' AND tool_use_id = ? LIMIT 1"
      )
      .get(sessionId, mainAgentId, targetAgentId);
    if (!spawnExists) {
      insertEvent.run(
        sessionId,
        mainAgentId,
        "PreToolUse",
        "Agent",
        targetAgentId,
        subagentData.startedAt
      );
      created++;
    }
  }

  // 把子 agent 内部的标准化工具事件写入 events 表；已存在的事件跳过。
  if (Array.isArray(subagentData.normalizedToolEvents) && subagentData.normalizedToolEvents.length > 0) {
    const eventExists = db.prepare(
      "SELECT 1 FROM events WHERE agent_id = ? AND event_type = ? AND tool_use_id = ? LIMIT 1"
    );
    for (const toolEvent of subagentData.normalizedToolEvents) {
      if (!toolEvent.tool_use_id) continue;
      const timestamp = toolEvent.pre_timestamp || subagentData.startedAt;

      if (!eventExists.get(targetAgentId, "PreToolUse", toolEvent.tool_use_id)) {
        insertEvent.run(
          sessionId,
          targetAgentId,
          "PreToolUse",
          toolEvent.tool_name,
          toolEvent.tool_use_id,
          timestamp
        );
        created++;
      }

      if (toolEvent.post_timestamp && !eventExists.get(targetAgentId, toolEvent.is_error ? "PostToolUseFailure" : "PostToolUse", toolEvent.tool_use_id)) {
        insertEvent.run(
          sessionId,
          targetAgentId,
          toolEvent.is_error ? "PostToolUseFailure" : "PostToolUse",
          toolEvent.tool_name,
          toolEvent.tool_use_id,
          toolEvent.post_timestamp
        );
        created++;
      }
    }
  }

  return { created, updated };
}

/**
 * 把 JSONL 解析出的子 agent 映射到数据库中实际使用的 agent id。
 *
 * 优先查找由实时 hooks 创建的 live subagent（按 agentType + startedAt 模糊匹配）；
 * 未匹配到时回退到 JSONL 推导出的占位 id `<sessionId>-jsonl-<agentId>`。
 */
function resolveSubagentDbId(dbModule, sessionId, subagentData) {
  const liveSubagentRow = findLiveSubagentForJsonl(dbModule, sessionId, subagentData);
  return liveSubagentRow ? liveSubagentRow.id : `${sessionId}-jsonl-${subagentData.agentId}`;
}

/**
 * 根据子 agent 的 spawnedChildAgentIds 重建 parent_agent_id 层级关系。
 *
 * 处理流程：
 * 1. 先构建 childId → parentId 的映射。
 * 2. 对每个孩子，解析出 childDbId 和 parentDbId。
 * 3. 无重复时更新 agents.parent_agent_id。
 */
function reconcileSubagentParents(dbModule, sessionId, mainAgentId, parsedSubagents) {
  if (!Array.isArray(parsedSubagents) || parsedSubagents.length < 2) return 0;
  const { stmts } = dbModule;

  const subagentById = new Map();
  for (const subagent of parsedSubagents) if (subagent && subagent.agentId) subagentById.set(subagent.agentId, subagent);

  // 根据 spawnedChildAgentIds 推断父子关系：孩子 id → 当前 agent id。
  const childToParentMap = new Map();
  for (const subagent of parsedSubagents) {
    if (!subagent || !Array.isArray(subagent.spawnedChildAgentIds)) continue;
    for (const childId of subagent.spawnedChildAgentIds) {
      if (childId && childId !== subagent.agentId && subagentById.has(childId)) {
        childToParentMap.set(childId, subagent.agentId);
      }
    }
  }
  if (childToParentMap.size === 0) return 0;

  let updated = 0;
  for (const subagent of parsedSubagents) {
    const parentAgentId = childToParentMap.get(subagent.agentId);
    if (!parentAgentId) continue;
    const parentData = subagentById.get(parentAgentId);
    if (!parentData) continue;

    const childDbId = resolveSubagentDbId(dbModule, sessionId, subagent);
    const parentDbId = resolveSubagentDbId(dbModule, sessionId, parentData);
    if (!childDbId || !parentDbId || childDbId === parentDbId) continue;

    const childRow = stmts.getAgent.get(childDbId);
    const parentRow = stmts.getAgent.get(parentDbId);
    if (!childRow || !parentRow) continue;
    if (childRow.parent_agent_id === parentDbId) continue;

    stmts.setAgentParent.run(parentDbId, childDbId);
    updated++;
  }
  return updated;
}

/**
 * 把单个解析后的会话对象导入数据库。
 *
 * 分支：
 * - 如果会话已存在且不是 imported 来源，则跳过（保护实时 hooks 创建的会话）。
 * - 如果会话已存在且是 imported 来源，则只增量补充缺失的事件和元数据。
 * - 如果会话不存在，则新建 sessions、agents、events、token_usage 记录。
 */
function importSession(dbModule, session) {
  const { db, stmts } = dbModule;
  const existing = stmts.getSession.get(session.sessionId);
  if (existing) {
    const existingMetadata = existing.metadata ? JSON.parse(existing.metadata) : {};
    if (!existingMetadata.imported) return { skipped: true };

    const mainAgentId = `${session.sessionId}-main`;
    const insertEvent = db.prepare(
      "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    let wasModified = false;

    // 预计算每种 event_type 的最晚时间，后续避免写入重复或更旧的事件。
    const latestEventByTypeRows = db
      .prepare(
        "SELECT event_type, MAX(created_at) AS m FROM events WHERE session_id = ? GROUP BY event_type"
      )
      .all(session.sessionId);
    const latestEventTimeByType = Object.create(null);
    for (const result of latestEventByTypeRows) latestEventTimeByType[result.event_type] = result.m;
    const isTimestampNewerThanLatest = (type, timestamp) => {
      if (!timestamp) return false;
      const candidate = latestEventTimeByType[type];
      return !candidate || timestamp > candidate;
    };

    // 用 assistant 消息时间戳生成 Stop 事件；如果没有 assistant 消息，用 startedAt 兜底。
    if (session.assistantMessageTimestamps && session.assistantMessageTimestamps.length > 0) {
      let added = 0;
      for (const timestamp of session.assistantMessageTimestamps) {
        if (!isTimestampNewerThanLatest("Stop", timestamp)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "Stop",
          null,
          null,
          timestamp
        );
        added++;
      }
      if (added > 0) wasModified = true;
    } else if (!latestEventTimeByType.Stop) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        null,
        session.startedAt
      );
      wasModified = true;
    }

    // 把主会话中的 tool_use / tool_result 配对为 PreToolUse / PostToolUse(PostToolUseFailure) 事件。
    if (session.assistantToolUses && session.assistantToolUses.length > 0) {
      const toolExists = db.prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND agent_id = ? AND event_type = ? AND tool_use_id = ? LIMIT 1"
      );
      let added = 0;
      for (const toolUse of session.assistantToolUses) {
        if (!toolUse.id || !toolUse.timestamp) continue;
        const result = session.toolResultById && session.toolResultById.get(toolUse.id);
        const postType = result && result.is_error ? "PostToolUseFailure" : "PostToolUse";

        if (!toolExists.get(session.sessionId, mainAgentId, "PreToolUse", toolUse.id)) {
          insertEvent.run(
            session.sessionId,
            mainAgentId,
            "PreToolUse",
            toolUse.name,
            toolUse.id,
            toolUse.timestamp
          );
          added++;
        }

        if (!toolExists.get(session.sessionId, mainAgentId, postType, toolUse.id)) {
          insertEvent.run(
            session.sessionId,
            mainAgentId,
            postType,
            toolUse.name,
            toolUse.id,
            result && result.timestamp ? result.timestamp : toolUse.timestamp
          );
          added++;
        }
      }
      if (added > 0) wasModified = true;
    }

    // 如果 JSONL 路径已知，同步更新 sessions.transcript_path。
    if (session.transcriptPath) {
      stmts.setSessionTranscriptPath.run(session.transcriptPath, session.sessionId);
    }

    // 如果没有独立的子 agent JSONL，就从主会话的 Agent 工具调用推断子 agent。
    const hasParsedSubs = session.parsedSubagents && session.parsedSubagents.length > 0;
    if (!hasParsedSubs) {
      const subagentCount = importSubagents(
        dbModule,
        session.sessionId,
        mainAgentId,
        session.assistantToolUses
      );
      if (subagentCount > 0) wasModified = true;
    }

    // 导入真正的子 agent JSONL，并重建父子关系。
    if (session.parsedSubagents && session.parsedSubagents.length > 0) {
      for (const subagentData of session.parsedSubagents) {
        const result = importSubagentFromJsonl(dbModule, session.sessionId, mainAgentId, subagentData);
        if (result.created > 0 || result.updated > 0) wasModified = true;
      }

      if (
        reconcileSubagentParents(
          dbModule,
          session.sessionId,
          mainAgentId,
          session.parsedSubagents
        ) > 0
      )
        wasModified = true;
    }

    // 把用户消息中标记为 is_error 的 tool result 记录为 ToolError 事件。
    if (session.toolResultErrors && session.toolResultErrors.length > 0) {
      let added = 0;
      for (const toolResultError of session.toolResultErrors) {
        const timestamp = toolResultError.timestamp || session.startedAt;
        if (!isTimestampNewerThanLatest("ToolError", timestamp)) continue;
        insertEvent.run(
          session.sessionId,
          mainAgentId,
          "ToolError",
          null,
          null,
          timestamp
        );
        added++;
      }
      if (added > 0) wasModified = true;
    }

    // 当轮次元数据发生变化时更新 sessions.metadata。
    const metaChanged =
      session.turnDurationRecords && (existingMetadata.turn_count || 0) !== session.turnDurationRecords.length;
    if (metaChanged) {
      existingMetadata.turn_count = session.turnDurationRecords ? session.turnDurationRecords.length : existingMetadata.turn_count || 0;
      stmts.updateSession.run(null, null, null, JSON.stringify(existingMetadata), session.sessionId);
      wasModified = true;
    }

    // 如果会话名是自动生成的，且 JSONL 中发现了更好的标题（custom/ai/第一条用户消息），则更新会话名。
    const firstUserMessagePreview = firstUserLabel(session.firstUserMessage);
    const transcriptTitle = session.customTitle || session.aiTitle || firstUserMessagePreview || null;
    if (transcriptTitle) {
      const base = session.cwd ? path.basename(session.cwd) : null;
      const storedSessionName = existing.name || "";
      const isAutoGeneratedName =
        !storedSessionName.trim() ||
        storedSessionName === `Session ${session.sessionId.slice(0, 8)}` ||
        (firstUserMessagePreview !== null && storedSessionName === firstUserMessagePreview) ||
        (base &&
          (storedSessionName === base || storedSessionName.startsWith(`${base} - `) || storedSessionName.startsWith(`${base} (`)));
      if (isAutoGeneratedName && storedSessionName !== transcriptTitle) {
        stmts.updateSession.run(transcriptTitle, null, null, null, session.sessionId);
        wasModified = true;
      }
    }

    // 如果主 agent 的名称/任务还是自动生成的，用第一条用户消息补齐。
    if (firstUserMessagePreview) {
      const mainRow = stmts.getAgent.get(`${session.sessionId}-main`);
      if (mainRow) {
        const base = session.cwd ? path.basename(session.cwd) : null;
        const storedAgent = mainRow.name || "";
        const suffix = storedAgent.startsWith("Main Agent - ")
          ? storedAgent.slice("Main Agent - ".length)
          : null;
        const suffixIsAuto =
          suffix !== null &&
          (!suffix.trim() ||
            suffix === `Session ${session.sessionId.slice(0, 8)}` ||
            (base &&
              (suffix === base ||
                suffix.startsWith(`${base} - `) ||
                suffix.startsWith(`${base} (`))));
        const agentNameIsAuto = !storedAgent.trim() || storedAgent === "Main Agent" || suffixIsAuto;
        const desiredAgentName = `Main Agent - ${firstUserMessagePreview}`;
        const fillName = agentNameIsAuto && storedAgent !== desiredAgentName;
        const fillTask = !mainRow.task || !String(mainRow.task).trim();
        if (fillName || fillTask) {
          stmts.updateAgent.run(
            fillName ? desiredAgentName : null,
            null,
            fillTask ? session.firstUserMessage : null,
            mainRow.current_tool,
            null,
            null,
            mainRow.id
          );
          wasModified = true;
        }
      }
    }

    // 更新会话结束时间，但不覆盖 active 状态的实时会话。
    if (
      session.endedAt &&
      (!existing.ended_at || session.endedAt > existing.ended_at) &&
      existing.status !== "active"
    ) {
      db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(
        session.endedAt,
        session.sessionId
      );
      wasModified = true;
    }

    // 只有当子 agent 有实际 token 用量时才重新合并并写入，减少无意义更新。
    if (
      session.parsedSubagents &&
      session.parsedSubagents.some(
        (subagent) =>
          subagent.tokensByModel &&
          Object.values(subagent.tokensByModel).some(
            (tokenBucket) => (tokenBucket.input || 0) + (tokenBucket.output || 0) + (tokenBucket.cacheRead || 0) + (tokenBucket.cacheWrite || 0) > 0
          )
      )
    ) {
      const written = writeSessionTokens(
        dbModule,
        session.sessionId,
        combineSessionTokens(session)
      );
      if (written > 0) wasModified = true;
    }

    return wasModified ? { skipped: false, wasModified: true } : { skipped: true };
  }

  // 以下处理会话尚不存在的情况：新建 sessions、agents、events、token_usage。
  const RECENT_THRESHOLD_MS = 10 * 60 * 1000;
  const isRecentlyActive =
    session.fileModifiedAt && Date.now() - session.fileModifiedAt < RECENT_THRESHOLD_MS;
  const sessionStatus = isRecentlyActive ? "active" : "completed";
  const agentStatus = isRecentlyActive ? "waiting" : "completed";

  const metadata = JSON.stringify({
    imported: true,
    turn_count: session.turnDurationRecords ? session.turnDurationRecords.length : 0,
  });

  // 先插入会话记录，再用 UPDATE 设置 started_at / ended_at（避免 insertSession 语句参数过多）。
  stmts.insertSession.run(
    session.sessionId,
    session.name,
    sessionStatus,
    session.cwd,
    session.model,
    metadata
  );

  db.prepare("UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?").run(
    session.startedAt,
    isRecentlyActive ? null : session.endedAt,
    session.sessionId
  );

  if (session.transcriptPath) {
    stmts.setSessionTranscriptPath.run(session.transcriptPath, session.sessionId);
  }

  // 创建主 agent；如果是最近活跃的会话，则不设置 ended_at，让后续 hooks 更新。
  const mainAgentId = `${session.sessionId}-main`;
  const agentLabel = `Main Agent - ${session.name}`;
  stmts.insertAgent.run(
    mainAgentId,
    session.sessionId,
    agentLabel,
    "main",
    null,
    agentStatus,
    session.firstUserMessage || null,
    null,
    null
  );
  db.prepare("UPDATE agents SET started_at = ?, ended_at = ? WHERE id = ?").run(
    session.startedAt,
    isRecentlyActive ? null : session.endedAt,
    mainAgentId
  );

  // 把 teamName 列表转换为 team 类型的占位子 agent。
  for (const teamName of session.teams) {
    const teamAgentId = `${session.sessionId}-team-${teamName}`;
    stmts.insertAgent.run(
      teamAgentId,
      session.sessionId,
      teamName,
      "subagent",
      "team",
      "completed",
      null,
      mainAgentId,
      null
    );
    db.prepare("UPDATE agents SET started_at = ?, ended_at = ? WHERE id = ?").run(
      session.startedAt,
      session.endedAt,
      teamAgentId
    );
  }

  const insertEvent = db.prepare(
    "INSERT INTO events (session_id, agent_id, event_type, tool_name, tool_use_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  if (session.assistantMessageTimestamps && session.assistantMessageTimestamps.length > 0) {
    for (const timestamp of session.assistantMessageTimestamps) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        null,
        timestamp
      );
    }
  } else {
    insertEvent.run(
      session.sessionId,
      mainAgentId,
      "Stop",
      null,
      null,
      session.startedAt
    );
    if (session.endedAt && session.endedAt !== session.startedAt) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "Stop",
        null,
        null,
        session.endedAt
      );
    }
  }

  if (session.assistantToolUses && session.assistantToolUses.length > 0) {
    for (const toolUse of session.assistantToolUses) {
      if (!toolUse.id || !toolUse.timestamp) continue;
      const result = session.toolResultById && session.toolResultById.get(toolUse.id);
      const postType = result && result.is_error ? "PostToolUseFailure" : "PostToolUse";
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "PreToolUse",
        toolUse.name,
        toolUse.id,
        toolUse.timestamp
      );
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        postType,
        toolUse.name,
        toolUse.id,
        result && result.timestamp ? result.timestamp : toolUse.timestamp
      );
    }
  }

  if (!(session.parsedSubagents && session.parsedSubagents.length > 0)) {
    importSubagents(dbModule, session.sessionId, mainAgentId, session.assistantToolUses);
  }

  if (session.toolResultErrors && session.toolResultErrors.length > 0) {
    for (const toolResultError of session.toolResultErrors) {
      insertEvent.run(
        session.sessionId,
        mainAgentId,
        "ToolError",
        null,
        null,
        toolResultError.timestamp || session.startedAt
      );
    }
  }

  // 导入子 agent JSONL 并重建层级。
  if (session.parsedSubagents && session.parsedSubagents.length > 0) {
    for (const subagentData of session.parsedSubagents) {
      importSubagentFromJsonl(dbModule, session.sessionId, mainAgentId, subagentData);
    }

    reconcileSubagentParents(dbModule, session.sessionId, mainAgentId, session.parsedSubagents);
  }

  // 首次导入时直接写入合并后的 token 总量。
  writeSessionTokens(dbModule, session.sessionId, combineSessionTokens(session));

  return { skipped: false };
}

/**
 * 解析会话文件并同时加载其 subagents 目录下的子 agent JSONL。
 *
 * 子 agent 路径约定：
 *   <projectPath>/<sessionId>/subagents/*.jsonl
 */
async function parseSessionForImport(projectPath, sourcePath) {
  const session = await parseSessionFile(sourcePath);
  if (!session) return null;

  const subDir = path.join(projectPath, session.sessionId, "subagents");
  if (fs.existsSync(subDir)) {
    const subFiles = fs.readdirSync(subDir).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    session.parsedSubagents = [];
    for (const subagentFile of subFiles) {
      try {
        const subagentData = await parseSubagentFile(path.join(subDir, subagentFile));
        if (subagentData) session.parsedSubagents.push(subagentData);
      } catch {
        // 单个子 agent 文件解析失败不影响整体导入。
      }
    }
  }

  session._sourceJsonlPath = sourcePath;
  return session;
}

/**
 * 全量导入 ~/.claude/projects/ 下所有 JSONL 文件。
 *
 * 每个 project 目录下的会话会先解析到内存，然后以事务批量导入，
 * 提升性能并保证原子性。
 */
async function importAllSessions(dbModule) {
  if (!fs.existsSync(PROJECTS_DIR)) return { imported: 0, skipped: 0, errors: 0 };

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((directoryEntry) => directoryEntry.isDirectory())
    .map((directoryEntry) => directoryEntry.name);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const importBatch = dbModule.db.transaction((sessions) => {
    for (const session of sessions) {
      const result = importSession(dbModule, session);
      if (result.skipped) skipped++;
      else imported++;
    }
  });

  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    const files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    if (files.length === 0) continue;

    const tokenUpdateBatch = [];
    for (const file of files) {
      try {
        const sourcePath = path.join(projectPath, file);
        const session = await parseSessionForImport(projectPath, sourcePath);
        if (!session) {
          skipped++;
          continue;
        }
        tokenUpdateBatch.push(session);
      } catch {
        errors++;
      }
    }

    if (tokenUpdateBatch.length > 0) {
      importBatch(tokenUpdateBatch);
    }
  }

  return { imported, skipped, errors };
}

/**
 * 增量同步默认项目目录。
 *
 * 使用 mtimeCache 记录每个文件上次修改时间，只有文件发生变更或数据库中的
 * updated_at 早于文件 mtime 时才重新解析导入。返回 changed 列表供调用方
 * 向 SSE 客户端推送更新。
 */
async function syncDefaultProjects(dbModule, options = {}) {
  const mtimeCache = options.mtimeCache instanceof Map ? options.mtimeCache : new Map();
  const changed = [];
  if (!fs.existsSync(PROJECTS_DIR)) return { changed };

  let projectDirs;
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((directoryEntry) => directoryEntry.isDirectory())
      .map((directoryEntry) => directoryEntry.name);
  } catch {
    return { changed };
  }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sourcePath = path.join(projectPath, file);
      let mtime;
      try {
        mtime = fs.statSync(sourcePath).mtimeMs;
      } catch {
        continue;
      }
      // 文件 mtime 与缓存一致时直接跳过。
      if (mtimeCache.get(sourcePath) === mtime) continue;

      try {
        const sessionId = path.basename(file, ".jsonl");
        const existingRow = dbModule.stmts.getSession.get(sessionId);

        // 如果数据库中的 updated_at 已经不早于文件 mtime，说明已经同步过。
        if (existingRow) {
          const seenMs = Date.parse(existingRow.updated_at);
          if (Number.isFinite(seenMs) && mtime <= seenMs) {
            mtimeCache.set(sourcePath, mtime);
            continue;
          }
        }
        const existed = !!existingRow;
        const session = await parseSessionForImport(projectPath, sourcePath);

        mtimeCache.set(sourcePath, mtime);
        if (!session) continue;

        const result = importSession(dbModule, session);

        // 新会话或非 skipped（即有更新）才加入 changed 列表。
        if (!existed || !result.skipped) {
          changed.push({ sessionId: session.sessionId, isNew: !existed });
        }

        // 每处理完一个文件让出事件循环，避免阻塞服务端其他请求。
        await new Promise((resolve) => setImmediate(resolve));
      } catch {
        // 单个文件失败不影响后续文件。
      }
    }
  }

  return { changed };
}

/**
 * 重新计算所有 imported 会话的 token 总量。
 *
 * 用于修复早期导入逻辑中的 token 统计遗漏，或子 agent token 未合并到会话级别的问题。
 * 每 50 条记录批量 flush 一次，并定期调用 onProgress 回调。
 */
async function reconcileTokens(dbModule, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const counters = { reconciled: 0, sessionsTouched: 0, modelsWritten: 0, missingFiles: 0 };
  if (!fs.existsSync(PROJECTS_DIR)) return counters;

  const projectDirs = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((directoryEntry) => directoryEntry.isDirectory())
    .map((directoryEntry) => directoryEntry.name);

  // 建立 sessionId → JSONL 路径的索引，方便后续快速定位文件。
  const sessionPaths = new Map();
  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    let files;
    try {
      files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const sessionFile of files) {
      const sessionId = path.basename(sessionFile, ".jsonl");
      sessionPaths.set(sessionId, path.join(projectPath, sessionFile));
    }
  }

  // 只处理 metadata 中标记为 imported 的会话，避免覆盖实时 hooks 生成的数据。
  const importedSessionIds = dbModule.db
    .prepare("SELECT id FROM sessions WHERE metadata LIKE '%\"imported\":true%'")
    .all();

  const total = importedSessionIds.length;
  let processed = 0;

  const tx = dbModule.db.transaction((tokenUpdateBatch) => {
    for (const { sessionId, tokens } of tokenUpdateBatch) {
      const written = writeSessionTokens(dbModule, sessionId, tokens);
      if (written > 0) {
        counters.sessionsTouched++;
        counters.modelsWritten += written;
      }
      counters.reconciled++;
    }
  });

  let tokenUpdateBatch = [];
  const FLUSH = 50;

  for (const { id: sessionId } of importedSessionIds) {
    processed++;
    const jsonlPath = sessionPaths.get(sessionId);
    if (!jsonlPath) {
      counters.missingFiles++;
      if (processed % 25 === 0) onProgress({ processed, total, counters });
      continue;
    }

    try {
      const session = await parseSessionFile(jsonlPath);
      if (!session) {
        if (processed % 25 === 0) onProgress({ processed, total, counters });
        continue;
      }

      // 重新加载子 agent 并合并 token。
      const subPaths = findSessionSubagents(jsonlPath);
      if (subPaths.length > 0) {
        session.parsedSubagents = [];
        for (const subagentPath of subPaths) {
          try {
            const subagentData = await parseSubagentFile(subagentPath);
            if (subagentData) session.parsedSubagents.push(subagentData);
          } catch {
            // 单个子 agent 失败不影响会话级校正。
          }
        }
      }

      const tokens = combineSessionTokens(session);
      if (Object.keys(tokens).length > 0) {
        tokenUpdateBatch.push({ sessionId, tokens });
        if (tokenUpdateBatch.length >= FLUSH) {
          tx(tokenUpdateBatch);
          tokenUpdateBatch = [];
        }
      } else {
        counters.reconciled++;
      }
    } catch {
      // 单个会话失败继续处理下一个。
    }

    if (processed % 25 === 0) onProgress({ processed, total, counters });
  }
  if (tokenUpdateBatch.length > 0) tx(tokenUpdateBatch);

  onProgress({ processed, total, counters });
  return counters;
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  const reconcile = process.argv.includes("--reconcile-tokens");
  const projectArgIndex = process.argv.indexOf("--project");
  const projectFilter = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

  (async () => {
    console.log("Claude Code Session Importer");
    console.log("============================");
    if (dryRun) console.log("DRY RUN - no data will be written\n");
    if (reconcile)
      console.log("RECONCILE — refreshing token totals for already-imported sessions\n");
    if (projectFilter) console.log(`Filtering to project: ${projectFilter}\n`);

    if (!fs.existsSync(PROJECTS_DIR)) {
      console.error(`Projects directory not found: ${PROJECTS_DIR}`);
      process.exit(1);
    }

    if (reconcile) {
      const dbModule = require("../server/db");
      const before = dbModule.db
        .prepare(
          `SELECT
             COALESCE(SUM(input_tokens), 0) AS i,
             COALESCE(SUM(output_tokens), 0) AS o,
             COALESCE(SUM(cache_read_tokens), 0) AS cr,
             COALESCE(SUM(cache_write_tokens), 0) AS cw
           FROM token_usage`
        )
        .get();
      const result = await reconcileTokens(dbModule, {
        onProgress: ({ processed, total, counters }) => {
          process.stdout.write(
            `  reconciling ${processed}/${total} (touched: ${counters.sessionsTouched}, models: ${counters.modelsWritten})\r`
          );
        },
      });
      const after = dbModule.db
        .prepare(
          `SELECT
             COALESCE(SUM(input_tokens), 0) AS i,
             COALESCE(SUM(output_tokens), 0) AS o,
             COALESCE(SUM(cache_read_tokens), 0) AS cr,
             COALESCE(SUM(cache_write_tokens), 0) AS cw
           FROM token_usage`
        )
        .get();
      console.log(`\nReconciled ${result.reconciled} sessions.`);
      console.log(`Sessions whose tokens changed: ${result.sessionsTouched}`);
      console.log(`Token rows written: ${result.modelsWritten}`);
      if (result.missingFiles > 0) {
        console.log(`Sessions with no JSONL on disk (skipped): ${result.missingFiles}`);
      }
      const formatNumber = (n) => Number(n).toLocaleString();
      console.log("");
      console.log("Token totals (before → after):");
      console.log(
        `  input:       ${formatNumber(before.i)}  →  ${formatNumber(after.i)}  (Δ ${formatNumber(after.i - before.i)})`
      );
      console.log(
        `  output:      ${formatNumber(before.o)}  →  ${formatNumber(after.o)}  (Δ ${formatNumber(after.o - before.o)})`
      );
      console.log(
        `  cache_read:  ${formatNumber(before.cr)}  →  ${formatNumber(after.cr)}  (Δ ${formatNumber(after.cr - before.cr)})`
      );
      console.log(
        `  cache_write: ${formatNumber(before.cw)}  →  ${formatNumber(after.cw)}  (Δ ${formatNumber(after.cw - before.cw)})`
      );
      console.log("\nDone.");
      return;
    }

    if (dryRun) {
      const projectDirs = fs
        .readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((directoryEntry) => directoryEntry.isDirectory())
        .map((directoryEntry) => directoryEntry.name);

      let total = 0;
      for (const projectDir of projectDirs) {
        if (projectFilter && !projectDir.includes(projectFilter)) continue;
        const projectPath = path.join(PROJECTS_DIR, projectDir);
        const files = fs.readdirSync(projectPath).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
        if (files.length === 0) continue;

        const label = projectDir.replace(/^C--/, "").replace(/-/g, "/");
        console.log(`\nProject: ${label} (${files.length} sessions)`);

        for (const file of files) {
          total++;
          try {
            const session = await parseSessionFile(path.join(projectPath, file));
            if (!session) {
              console.log(`  SKIP ${file} (empty)`);
              continue;
            }
            const totalTokens = Object.values(session.tokensByModel).reduce(
              (sum, tokenBucket) => sum + tokenBucket.input + tokenBucket.output,
              0
            );
            console.log(
              `  ${session.sessionId.slice(0, 12)}... | ${session.name.slice(0, 40).padEnd(40)} | teams: ${session.teams.length} | models: ${[...new Set(Object.values(session.tokensByModel).map((tokenBucket) => tokenBucket.model))].join(",")} | tokens: ${totalTokens}`
            );
          } catch (err) {
            console.error(`  ERROR ${file}: ${err.message}`);
          }
        }
      }
      console.log(`\nTotal: ${total} session files`);
    } else {
      const dbModule = require("../server/db");
      const result = await importAllSessions(dbModule);
      console.log(`Imported: ${result.imported}`);
      console.log(`Skipped: ${result.skipped}`);
      if (result.errors > 0) console.log(`Errors: ${result.errors}`);
    }
    console.log("Done.");
  })().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

/**
 * 递归收集目录下所有 .jsonl 文件。
 *
 * 特点：
 * - 使用栈实现深度优先遍历，避免递归调用栈溢出。
 * - 通过 realpath 和 seen 集合处理符号链接，防止循环链接导致死循环。
 * - 同时处理普通文件、目录和符号链接。
 */
function collectJsonlFiles(rootDir) {
  const jsonlFilePaths = [];
  const stack = [rootDir];
  const seen = new Set();
  while (stack.length) {
    const dir = stack.pop();
    let realPath;
    try {
      realPath = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const directoryEntry of entries) {
      const fullPath = path.join(dir, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        stack.push(fullPath);
      } else if (directoryEntry.isFile() && directoryEntry.name.endsWith(".jsonl")) {
        jsonlFilePaths.push(fullPath);
      } else if (directoryEntry.isSymbolicLink()) {
        try {
          const rootStats = fs.statSync(fullPath);
          if (rootStats.isDirectory()) stack.push(fullPath);
          else if (rootStats.isFile() && fullPath.endsWith(".jsonl")) jsonlFilePaths.push(fullPath);
        } catch {
          // 忽略无法解析的符号链接。
        }
      }
    }
  }
  return jsonlFilePaths;
}

/**
 * 根据文件所在目录判断 JSONL 是主会话还是子 agent。
 *
 * 约定：路径中包含 "subagents" 目录的为子 agent。
 */
function classifyJsonl(filePath) {
  const segments = path.dirname(filePath).split(path.sep);
  if (segments.includes("subagents")) return "subagent";
  return "session";
}

/**
 * 查找某个会话 JSONL 对应的子 agent 文件列表。
 *
 * 兼容两种目录结构：
 * - <dir>/<sessionId>/subagents/*.jsonl
 * - <dir>/subagents/<sessionId>/*.jsonl
 */
function findSessionSubagents(sessionJsonlPath) {
  const dir = path.dirname(sessionJsonlPath);
  const sessionId = path.basename(sessionJsonlPath, ".jsonl");
  const candidates = [
    path.join(dir, sessionId, "subagents"),
    path.join(dir, "subagents", sessionId),
  ];
  const result = [];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const files = fs.readdirSync(candidate).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
      for (const sessionFile of files) result.push(path.join(candidate, sessionFile));
    } catch {
      // 忽略无法读取的目录。
    }
  }
  return result;
}

/**
 * 从任意目录递归扫描 JSONL 并导入。
 *
 * 与 importAllSessions 不同，该方法不限于 ~/.claude/projects/，
 * 支持用户指定自定义目录；同时会处理独立的子 agent JSONL 文件。
 */
async function importFromDirectory(dbModule, rootDir, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const counters = {
    imported: 0,
    skipped: 0,
    wasModified: 0,
    errors: 0,
    sessionsSeen: 0,
    filesScanned: 0,
  };

  if (!fs.existsSync(rootDir)) return counters;
  const rootStats = fs.statSync(rootDir);
  if (!rootStats.isDirectory()) return counters;

  onProgress({ phase: "scan", processed: 0, total: 0, counters });
  const jsonlFiles = collectJsonlFiles(rootDir);
  counters.filesScanned = jsonlFiles.length;
  onProgress({ phase: "parse", processed: 0, total: jsonlFiles.length, counters });

  const sessionFiles = [];
  const standaloneSubagentFiles = [];
  for (const sessionFile of jsonlFiles) {
    if (classifyJsonl(sessionFile) === "subagent") standaloneSubagentFiles.push(sessionFile);
    else sessionFiles.push(sessionFile);
  }

  const parsedSessions = [];
  for (let i = 0; i < sessionFiles.length; i++) {
    const sessionFile = sessionFiles[i];
    try {
      const session = await parseSessionFile(sessionFile);
      if (!session) {
        counters.skipped++;
        onProgress({
          phase: "parse",
          processed: i + 1,
          total: sessionFiles.length,
          current: sessionFile,
          counters,
        });
        continue;
      }

      // 尝试加载该会话对应的子 agent JSONL。
      const subPaths = findSessionSubagents(sessionFile);
      if (subPaths.length > 0) {
        session.parsedSubagents = [];
        for (const subagentPath of subPaths) {
          try {
            const subagentData = await parseSubagentFile(subagentPath);
            if (subagentData) session.parsedSubagents.push(subagentData);
          } catch {
            // 单个子 agent 失败不影响主会话。
          }
        }
      }

      session._sourceJsonlPath = sessionFile;
      parsedSessions.push(session);
      counters.sessionsSeen++;
    } catch {
      counters.errors++;
    }
    if ((i + 1) % 5 === 0 || i === sessionFiles.length - 1) {
      onProgress({
        phase: "parse",
        processed: i + 1,
        total: sessionFiles.length,
        current: sessionFile,
        counters,
      });
    }
  }

  // 事务批量导入主会话。
  if (parsedSessions.length > 0) {
    const importBatch = dbModule.db.transaction((sessions) => {
      for (const session of sessions) {
        try {
          const result = importSession(dbModule, session);
          if (result.skipped && !result.wasModified) counters.skipped++;
          else if (result.wasModified) counters.wasModified++;
          else counters.imported++;
        } catch {
          counters.errors++;
        }
      }
    });
    importBatch(parsedSessions);
  }

  // 处理独立的子 agent JSONL（路径结构与传统不同），尝试从目录名推断所属 sessionId。
  if (standaloneSubagentFiles.length > 0) {
    for (const subagentFile of standaloneSubagentFiles) {
      try {
        const subagentData = await parseSubagentFile(subagentFile);
        if (!subagentData) continue;
        const parts = subagentFile.split(path.sep);
        const subagentsDirIndex = parts.lastIndexOf("subagents");
        if (subagentsDirIndex < 0) continue;
        // 可能的 sessionId 候选：subagents 的父目录名或子目录名。
        const candidates = [];
        if (subagentsDirIndex - 1 >= 0) candidates.push(parts[subagentsDirIndex - 1]);
        if (subagentsDirIndex + 1 < parts.length) candidates.push(parts[subagentsDirIndex + 1]);
        let sessionId = null;
        for (const candidate of candidates) {
          if (!candidate) continue;
          if (dbModule.stmts.getSession.get(candidate)) {
            sessionId = candidate;
            break;
          }
        }
        if (!sessionId) continue;
        const mainAgentId = `${sessionId}-main`;
        const result = importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subagentData);
        if (result.created > 0 || result.updated > 0) {
          counters.wasModified++;
        }
      } catch {
        counters.errors++;
      }
    }
  }

  onProgress({
    phase: "complete",
    processed: sessionFiles.length,
    total: sessionFiles.length,
    counters,
  });
  return counters;
}

/**
 * 根据 transcript 路径扫描并导入该会话的子 agent JSONL。
 *
 * 常用于实时 hooks 触发：当检测到会话的 transcript 文件更新时，
 * 扫描同目录下的 subagents 文件夹，把新的子 agent 数据补充进数据库。
 */
async function scanAndImportSubagents(dbModule, sessionId, transcriptPath, opts = {}) {
  if (!sessionId || !transcriptPath) return { imported: 0, created: 0 };
  const subDir = path.join(path.dirname(transcriptPath), sessionId, "subagents");
  try {
    await fs.promises.access(subDir);
  } catch {
    return { imported: 0, created: 0 };
  }

  const subFiles = (await fs.promises.readdir(subDir)).filter((sessionFile) => sessionFile.endsWith(".jsonl"));
  if (subFiles.length === 0) return { imported: 0, created: 0 };

  const { db } = dbModule;
  const mainAgentId = `${sessionId}-main`;
  let created = 0;
  const parsedSubagents = [];
  for (const subagentFile of subFiles) {
    try {
      const subagentData = await parseSubagentFile(path.join(subDir, subagentFile));
      if (!subagentData) continue;
      parsedSubagents.push(subagentData);
      created += importSubagentFromJsonl(dbModule, sessionId, mainAgentId, subagentData).created;
    } catch {
      // 单个子 agent 失败不影响整体扫描。
    }
  }

  // 重建父子关系。
  let reparented = 0;
  try {
    reparented = reconcileSubagentParents(dbModule, sessionId, mainAgentId, parsedSubagents);
  } catch {
    // 关系重建失败不影响已导入数据。
  }

  // 只把父 agent（主会话）没有用到的模型 token 写入会话级别，
  // 避免重复统计已经通过主会话 events 计算过的 token。
  if (parsedSubagents.length > 0) {
    try {
      const parentModels = new Set();
      const sessionRow = db.prepare("SELECT model FROM sessions WHERE id = ?").get(sessionId);
      if (sessionRow && sessionRow.model) parentModels.add(sessionRow.model);
      if (Array.isArray(opts.parentModels)) {
        for (const model of opts.parentModels) if (model) parentModels.add(model);
      }
      const combined = combineSessionTokens({ tokensByModel: null, parsedSubagents });
      const subOnly = {};
      for (const [key, tokenBucket] of Object.entries(combined)) {
        if (tokenBucket.model && !parentModels.has(tokenBucket.model)) subOnly[key] = tokenBucket;
      }
      writeSessionTokens(dbModule, sessionId, subOnly);
    } catch {
      // token 写入失败不中断流程。
    }
  }

  return { imported: subFiles.length, created, reparented };
}

module.exports = {
  importAllSessions,
  syncDefaultProjects,
  importFromDirectory,
  importSubagents,
  importSubagentFromJsonl,
  reconcileSubagentParents,
  parseSessionFile,
  parseSubagentFile,
  collectJsonlFiles,
  classifyJsonl,
  findSessionSubagents,
  importSession,
  scanAndImportSubagents,
  combineSessionTokens,
  writeSessionTokens,
  reconcileTokens,
};
