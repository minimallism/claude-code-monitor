/**
 * Claude Code hook 处理路由。
 *
 * Claude Code 通过 user hooks 在关键生命周期节点调用本服务的 /api/hooks/event，
 * 把会话、工具调用、子 agent、停止等事件推送过来。本路由负责：
 * 1. 维护 sessions / agents / events 表的状态机。
 * 2. 从 transcript_path 指向的 JSONL 增量提取 token、标题、模型等信息。
 * 3. 通过 SSE broadcast 把变化实时推送给前端。
 * 4. 启动看门狗定时器，处理用户中断、进程崩溃等兜底场景。
 */

const { Router } = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const dbModule = require("../db");
const { stmts, db } = dbModule;
const { broadcast } = require("../sse");
const TranscriptCache = require("../lib/transcript-cache");

const liveness = require("../lib/session-liveness");
const { scanAndImportSubagents } = require("../../scripts/import-history");

const router = Router();

const transcriptCache = new TranscriptCache();

/**
 * 从 working 子 agent 列表中匹配 SubagentStop 事件对应的 agent。
 * 优先级：名称前缀 > agent_type > prompt 全文本 > 兜底取第一个。
 */
function findMatchingSubagent(subagents, data) {
  const working = subagents.filter((a) => a.type === "subagent" && a.status === "working");
  if (!working.length) return null;

  const desc = data.description || data.agent_type || data.subagent_type;
  const prefix = desc && (desc.length > 57 ? desc.slice(0, 57) : desc);

  return (
    (prefix && working.find((a) => a.name.startsWith(prefix))) ||
    (data.agent_type && working.find((a) => a.subagent_type === data.agent_type)) ||
    (data.prompt && working.find((a) => a.task === data.prompt.slice(0, 500))) ||
    working[0]
  );
}

/**
 * 在并行子 agent 场景下，通过反查子 agent 转录本 JSONL 中的 tool_use_id
 * 精确匹配该工具调用归属于哪个子 agent。
 *
 * 遍历方向：先遍历所有 JSONL 文件搜索 tool_use_id，找到后再用 meta.json
 * 的 description 反查 DB 中的 working 子 agent。这样即使两个子 agent 的
 * description 相同，也不会遗漏搜索任何一个 JSONL。
 *
 * DB agent.name 可能被截断到 60 字符（57 + "..."），
 * 匹配时去掉尾部 "..." 后用 startsWith 兼容截断。
 *
 * 有 tool_use_id 时始终走文件查找。搜不到时返回 null，由调用方决定是否覆盖 agentId。
 */
function findToolCallingSubagent(sessionId, toolUseId) {
  const working = stmts
    .listAgentsBySession.all(sessionId)
    .filter((a) => a.type === "subagent" && a.status === "working");
  if (working.length === 0) return null;
  if (!toolUseId) return null;

  const session = stmts.getSession.get(sessionId);
  if (!session || !session.transcript_path) return null;

  const subDir = path.join(path.dirname(session.transcript_path), sessionId, "subagents");

  // 读取所有 meta.json，收集 {description, fileUuid} 列表
  const metaEntries = [];
  try {
    const entries = fs.readdirSync(subDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".meta.json")) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, entry.name), "utf8"));
      const desc = meta.description;
      if (!desc) continue;
      const fileUuid = entry.name.replace(".meta.json", "").replace("agent-", "");
      metaEntries.push({ description: desc, fileUuid });
    }
  } catch {
    return null;
  }

  // 遍历每个 JSONL 文件搜索 tool_use_id，
  // 避免先匹配 description 导致碰撞时跳过正确的 JSONL
  for (const metaEntry of metaEntries) {
    const jsonlPath = path.join(subDir, `agent-${metaEntry.fileUuid}.jsonl`);
    try {
      const content = fs.readFileSync(jsonlPath, "utf8");
      if (!content.includes(`"${toolUseId}"`)) continue;

      // 找到了 tool_use_id，用 meta description 反查 DB agent。
      // 去掉 agent.name 尾部 "..." 后用 startsWith 匹配完整的 description，
      // 兼容 name 被截断到 60 字符（57 + "..."）的情况。
      const agent = working.find((a) => {
        const nameCore = a.name.endsWith("...") ? a.name.slice(0, -3) : a.name;
        return metaEntry.description.startsWith(nameCore);
      });
      if (agent) return agent;
    } catch {
      // 文件可能尚不存在或已被删除，继续检查下一个
    }
  }

  // 所有 JSONL 都没有该 tool_use_id，说明不是子 agent 调用的
  return null;
}

// 用于识别 Claude Code 推送的系统通知是否表示正在等待用户输入。
// 匹配 "waiting for your input"、"approval needed"、"permission" 等常见文案。
const WAITING_INPUT_PATTERN =
  /\bpermission\b|waiting (?:for )?(?:your )?(?:input|response|reply|approval)|needs?\s+your\s+(?:input|approval|response|attention)|approval\s+(?:needed|required)|awaiting\s+(?:your\s+)?(?:input|approval|response)/i;

/**
 * 判断一条 Notification hook 的消息是否在请求用户介入。
 */
function isWaitingForUserMessage(notificationMessage) {
  if (!notificationMessage || typeof notificationMessage !== "string") return false;
  return WAITING_INPUT_PATTERN.test(notificationMessage);
}

/**
 * 清除会话及其所有 agent 的 awaiting_input_since 标记。
 *
 * 调用时机：用户提交新输入、工具开始执行、子 agent 停止等"会话重新动起来"的事件。
 * broadcastUpdates 为 false 时只清理数据库不广播，用于 SessionEnd 这种最终状态场景。
 */
function clearAwaitingInput(sessionId, mainAgentId, broadcastUpdates) {
  const cleared = stmts.clearSessionAgentsAwaitingInput.run(sessionId);
  const sessCleared = stmts.clearSessionAwaitingInput.run(sessionId);
  if (broadcastUpdates && cleared.changes > 0 && mainAgentId) {
    const refreshedMain = stmts.getAgent.get(mainAgentId);
    if (refreshedMain) broadcast("agent_updated", refreshedMain);
  }
  if (broadcastUpdates && sessCleared.changes > 0) {
    const refreshedSess = stmts.getSession.get(sessionId);
    if (refreshedSess) broadcast("session_updated", refreshedSess);
  }
}

/**
 * 把被用户中断、或长时间 idle 的会话恢复为 waiting 状态。
 * 调用场景见下方的 watchdogCheck：当转录本里检测到 [Request interrupted by user]，
 * 或主 agent working 但既无 current_tool 也无输入等待且超过空闲阈值时触发。
 */
function recoverInterruptedSession(sessionId, fullSession, mainAgentId) {
  const timestamp = new Date().toISOString();
  if (mainAgentId) {
    stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
  }
  stmts.setSessionAwaitingInput.run(timestamp, sessionId);
  if (mainAgentId) stmts.setAgentAwaitingInput.run(timestamp, mainAgentId);

  broadcast("session_updated", stmts.getSession.get(sessionId));
  if (mainAgentId) broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
}

/**
 * 确保 session 及其主 agent 在数据库中存在。
 * 如果是首次收到该 session 的 hook，则创建 session 记录并自动插入一个 main agent。
 * 同时尝试写入 transcript_path（仅当字段为空时写入，避免覆盖）。
 */
function ensureSession(sessionId, data) {
  let session = stmts.getSession.get(sessionId);
  if (!session) {
    stmts.insertSession.run(
      sessionId,
      data.session_name || `Session ${sessionId.slice(0, 8)}`,
      "active",
      data.cwd || null,
      data.model || null,
      null
    );
    session = stmts.getSession.get(sessionId);
    if (!session) {
      console.error(`[HOOKS] Failed to create session ${sessionId} — insert returned no row`);
      return null;
    }
    broadcast("session_created", session);

    // 每个 session 固定有一个 main agent，id 规则为 "{sessionId}-main"，方便快速查找。
    const mainAgentId = `${sessionId}-main`;
    const sessionLabel = session.name || `Session ${sessionId.slice(0, 8)}`;
    stmts.insertAgent.run(
      mainAgentId,
      sessionId,
      `Main Agent - ${sessionLabel}`,
      "main",
      null,
      "working",
      null,
      null,
      null
    );
    const mainAgent = stmts.getAgent.get(mainAgentId);
    if (mainAgent) broadcast("agent_created", mainAgent);
  }

  // 仅在 transcript_path 为空时写入，因为 hook 可能来自旧路径或临时路径，
  // 不应覆盖已经正确设置的值。
  if (typeof data.transcript_path === "string" && data.transcript_path) {
    stmts.setSessionTranscriptPath.run(data.transcript_path, sessionId);
  }
  return session;
}

/**
 * 获取会话的主 agent。主 agent id 固定为 `{sessionId}-main`。
 */
function getMainAgent(sessionId) {
  return stmts.getAgent.get(`${sessionId}-main`);
}

/**
 * 判断当前 session 名称是否是自动生成的，从而决定是否可以被 hook 中提供的 custom/ai title 覆盖。
 * 自动生成规则包括默认 "Session xxxxxx" 以及基于 cwd 目录名的名称。
 */
function isAutoSessionName(name, sessionId, cwd) {
  if (!name || !name.trim()) return true;
  if (name === `Session ${sessionId.slice(0, 8)}`) return true;
  if (cwd) {
    const base = require("path").basename(cwd);
    if (base && (name === base || name.startsWith(`${base} - `) || name.startsWith(`${base} (`))) {
      return true;
    }
  }
  return false;
}

/**
 * 取第一条真实用户消息的前 60 个字符作为会话/主 agent 的候选名称。
 */
function firstUserLabel(result) {
  const raw = result && typeof result.firstUserMessage === "string" ? result.firstUserMessage : "";
  const text = raw.trim();
  if (!text) return null;
  return text.length > 60 ? text.slice(0, 57) + "..." : text;
}

/**
 * 判断 main agent 名称是否仍是自动生成，规则与 isAutoSessionName 类似，
 * 只是多了 "Main Agent - " 前缀。
 */
function isAutoMainAgentName(name, sessionId, cwd) {
  if (!name || !name.trim()) return true;
  if (name === "Main Agent") return true;
  const prefix = "Main Agent - ";
  if (name.startsWith(prefix)) return isAutoSessionName(name.slice(prefix.length), sessionId, cwd);
  return false;
}

/**
 * 根据转录本里的 custom-title / ai-title 更新 session 名称。
 * 只有名称为自动生成，或用户显式设置了 customTitle 时才允许覆盖，
 * 防止用户手动修改过的名称被 ai 生成的标题意外替换。
 */
function syncSessionName(session, result) {
  if (!session || !result) return;
  const custom = result.customTitle && result.customTitle.trim();
  const ai = result.aiTitle && result.aiTitle.trim();
  const desired = custom || ai || null;
  if (!desired) return;
  const replaceable =
    isAutoSessionName(session.name, session.id, session.cwd) ||
    session.name === firstUserLabel(result);
  if (!custom && !replaceable) return;
  const updateResult = stmts.updateSessionName.run(desired, session.id, desired);
  if (updateResult.changes > 0) {
    const refreshed = stmts.getSession.get(session.id);
    if (refreshed) broadcast("session_updated", refreshed);
  }
}

/**
 * 把第一条用户消息用作 session / main agent 的默认名称和任务描述。
 * 当用户没有手动命名时，这样可以让会话列表更有辨识度。
 */
function applyFirstUserDescriptor(sessionId, result) {
  const label = firstUserLabel(result);
  if (!label) return;

  const session = stmts.getSession.get(sessionId);
  if (session && isAutoSessionName(session.name, session.id, session.cwd)) {
    const updateResult = stmts.updateSessionName.run(label, session.id, label);
    if (updateResult.changes > 0) {
      const refreshed = stmts.getSession.get(session.id);
      if (refreshed) broadcast("session_updated", refreshed);
    }
  }

  const mainAgent = getMainAgent(sessionId);
  if (!mainAgent) return;
  const desiredName = `Main Agent - ${label}`;
  const fillName =
    isAutoMainAgentName(mainAgent.name, sessionId, session?.cwd) && mainAgent.name !== desiredName;
  const fillTask = !mainAgent.task || !String(mainAgent.task).trim();
  if (!fillName && !fillTask) return;

  // updateAgent 参数顺序：name, status, task, current_tool, ended_at, metadata, id。
  // 不需要修改的字段传 null，SQL 中用 COALESCE 保留原值。
  stmts.updateAgent.run(
    fillName ? desiredName : null,
    null,
    fillTask ? result.firstUserMessage : null,
    mainAgent.current_tool,
    null,
    null,
    mainAgent.id
  );
  const refreshedAgent = stmts.getAgent.get(mainAgent.id);
  if (refreshedAgent) broadcast("agent_updated", refreshedAgent);
}

const processEvent = db.transaction((hookType, data) => {
  const sessionId = data.session_id;
  if (!sessionId) return null;

  const session = ensureSession(sessionId, data);

  
  
  
  
  
  if (data.remote_custom_title || data.remote_ai_title) {
    syncSessionName(session, {
      customTitle:
        typeof data.remote_custom_title === "string"
          ? data.remote_custom_title.slice(0, 200)
          : null,
      aiTitle: typeof data.remote_ai_title === "string" ? data.remote_ai_title.slice(0, 200) : null,
    });
  }

  let mainAgent = getMainAgent(sessionId);
  const mainAgentId = mainAgent?.id ?? null;

  
  
  
  
  
  
  
  // 会话状态复活的判定逻辑：
  // - 用户提交新输入、或工具调用/子 agent 活动时，如果会话处于非 active 状态，需要重新激活。
  // - Stop/SubagentStop 事件只应复活那些之前被标记为 completed（例如导入的历史会话）的会话；
  //   对于 error 状态的会话，Stop 不自动复活，必须由用户重新介入。
  // - 子 agent 活动（Agent tool 或 PreToolUse）在 completed 会话上也能触发复活，
  //   因为用户可能在父会话里继续委派任务。
  const isUserAction = hookType === "UserPromptSubmit" || hookType === "PreToolUse";
  const isNonTerminalEvent = hookType !== "SessionEnd";
  const isStopLike = hookType === "Stop" || hookType === "SubagentStop";
  const isImportedOrAbandoned = session.status === "completed";
  const isSubagentActivity = data.tool_name === "Agent" || hookType === "PreToolUse";
  const needsReactivation =
    session.status !== "active" &&
    isNonTerminalEvent &&
    (isUserAction ||
      (!isStopLike && session.status !== "error") ||
      (isStopLike && isImportedOrAbandoned) ||
      (isSubagentActivity && isImportedOrAbandoned));
  if (needsReactivation) {
    stmts.reactivateSession.run(sessionId);
    broadcast("session_updated", stmts.getSession.get(sessionId));

    if (mainAgent && mainAgent.status !== "working") {
      stmts.reactivateAgent.run(mainAgentId);
      mainAgent = stmts.getAgent.get(mainAgentId);
      broadcast("agent_updated", mainAgent);
    }
  }

  let eventType = hookType;
  let toolName = data.tool_name || null;
  let toolUseId = data.tool_use_id || null;
  let agentId = mainAgentId;

  
  
  
  
  
  
  

  switch (hookType) {
    case "PreToolUse": {
      
      
      
      
      clearAwaitingInput(sessionId, mainAgentId, true);

      // 存在 working 子 agent 时，把当前工具调用归因于该子 agent，
      // 而不是 main agent。并行场景下通过 tool_use_id 反查转录本精确匹配。
      // 注意：此逻辑必须在 Agent 创建之前执行，否则刚创建的子 agent 会污染归因查询。
      const toolCallingSubagent = findToolCallingSubagent(sessionId, toolUseId);
      const subagentIsActor = !!toolCallingSubagent;
      if (subagentIsActor) {
        agentId = toolCallingSubagent.id;
      }
      // 如果确实没有子 agent 在执行，则把工具名更新到 main agent 的 current_tool。
      if (
        mainAgent &&
        !subagentIsActor &&
        (mainAgent.status === "working" || mainAgent.status === "waiting")
      ) {
        stmts.updateAgent.run(null, "working", null, toolName, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }

      
      if (toolName === "Agent") {
        const toolInput = data.tool_input || {};
        const subagentId = uuidv4();

        // 子 agent 名称优先级：description > subagent_type > prompt 首行 > 默认 "Subagent"。
        const rawSubagentName =
          toolInput.description ||
          toolInput.subagent_type ||
          (toolInput.prompt ? toolInput.prompt.split("\n")[0].slice(0, 60) : null) ||
          "Subagent";
        const subagentName = rawSubagentName.length > 60 ? rawSubagentName.slice(0, 57) + "..." : rawSubagentName;

        // 父 agent 选择：默认是当前 main agent；
        // 如果 main agent 不处于 working（例如正在等待用户输入），
        // 则把当前嵌套最深的 working 子 agent 作为父级，以正确反映调用链。
        let parentId = mainAgentId;
        if (mainAgent && mainAgent.status !== "working") {
          const deepestWorkingAgent = stmts.findDeepestWorkingAgent.get(sessionId);
          if (deepestWorkingAgent) {
            parentId = deepestWorkingAgent.id;
          }
        }

        stmts.insertAgent.run(
          subagentId,
          sessionId,
          subagentName,
          "subagent",
          toolInput.subagent_type || null,
          "working",
          toolInput.prompt ? toolInput.prompt.slice(0, 500) : null,
          parentId,
          toolInput.metadata ? JSON.stringify(toolInput.metadata) : null
        );
        broadcast("agent_created", stmts.getAgent.get(subagentId));
      }

      
      break;
    }

    case "PostToolUse": {
      // 工具执行成功，清除等待输入标记（用户批准通常是 PreToolUse 之前，但双重保险）。
      clearAwaitingInput(sessionId, mainAgentId, true);

      // 与 PreToolUse 对称：如果存在 working 子 agent，
      // 则把 PostToolUse 事件归因于该子 agent。
      const subagentAfterToolUse = findToolCallingSubagent(sessionId, toolUseId);
      if (subagentAfterToolUse) {
        agentId = subagentAfterToolUse.id;
      }

      // main agent 在 working 时工具结束，清除 current_tool。
      if (mainAgent && mainAgent.status === "working") {
        stmts.updateAgent.run(null, null, null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "PostToolUseFailure": {
      // 工具执行失败，逻辑与 PostToolUse 基本一致，只是事件类型不同。
      clearAwaitingInput(sessionId, mainAgentId, true);

      const subagentAfterFailedTool = findToolCallingSubagent(sessionId, toolUseId);
      if (subagentAfterFailedTool) {
        agentId = subagentAfterFailedTool.id;
      }

      if (mainAgent && mainAgent.status === "working") {
        stmts.updateAgent.run(null, null, null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "Stop": {
      // Claude Code 在停止生成、等待用户下一步指示时发送 Stop hook。
      // 此时把 main agent 设为 waiting，并标记 awaiting_input_since。
      const now = new Date().toISOString();
      const agentMutable =
        !!mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error";

      // 只有 completed/error 等终态才不再修改，避免覆盖 SessionEnd 的结果。
      if (agentMutable) {
        stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
      }
      stmts.setSessionAwaitingInput.run(now, sessionId);
      if (mainAgentId) stmts.setAgentAwaitingInput.run(now, mainAgentId);

      
      broadcast("session_updated", stmts.getSession.get(sessionId));
      if (mainAgentId) {
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "SubagentStop": {
      // 子 agent 完成时，需要把数据库中对应的 working 子 agent 标记为 completed。
      // 但 hook 里通常只包含 description/agent_type/prompt，没有稳定的 agent uuid，
      // 因此需要启发式匹配。
      const subagents = stmts.listAgentsBySession.all(sessionId);
      const matchingSubagent = findMatchingSubagent(subagents, data);

      if (matchingSubagent) {
        stmts.updateAgent.run(
          null,
          "completed",
          null,
          null,
          new Date().toISOString(),
          null,
          matchingSubagent.id
        );
        broadcast("agent_updated", stmts.getAgent.get(matchingSubagent.id));
        agentId = matchingSubagent.id;
      }
      break;
    }

    case "SessionStart": {
      // 会话启动时，如果 main agent 之前是 waiting（例如刚复活），先切回 working。
      if (mainAgent && mainAgent.status === "waiting") {
        stmts.updateAgent.run(null, "working", null, null, null, null, mainAgentId);
      }

      // SessionStart 通常也意味着 Claude 正在等待用户第一句话，
      // 所以把会话和主 agent 标记为 awaiting_input_since，便于 UI 显示"等待输入"。
      const sessionStartTs = new Date().toISOString();
      stmts.setSessionAwaitingInput.run(sessionStartTs, sessionId);
      if (mainAgentId) stmts.setAgentAwaitingInput.run(sessionStartTs, mainAgentId);

      
      
      
      broadcast("session_updated", stmts.getSession.get(sessionId));
      if (mainAgentId) broadcast("agent_updated", stmts.getAgent.get(mainAgentId));

      break;
    }

    case "SessionEnd": {
      const endingSession = stmts.getSession.get(sessionId);

      // 终态事件不需要广播，因为接下来会批量广播 session/agent 更新。
      clearAwaitingInput(sessionId, mainAgentId, false);

      // 如果会话在 SessionEnd 前已经被活性检测标记为 error，则保持 error；否则为 completed。
      const finalSessionStatus =
        endingSession?.status === "error" ? "error" : "completed";
      const sessionAgents = stmts.listAgentsBySession.all(sessionId);
      const now = new Date().toISOString();
      for (const agent of sessionAgents) {
        if (agent.status !== "completed" && agent.status !== "error") {
          const finalAgentStatus = finalSessionStatus === "error" ? "error" : "completed";
          stmts.updateAgent.run(null, finalAgentStatus, null, null, now, null, agent.id);
          broadcast("agent_updated", stmts.getAgent.get(agent.id));
        }
      }
      stmts.updateSession.run(null, finalSessionStatus, now, null, sessionId);
      broadcast("session_updated", stmts.getSession.get(sessionId));

      break;
    }

    case "UserPromptSubmit": {
      // 用户提交新输入，清除等待状态并把 main agent 切回 working。
      clearAwaitingInput(sessionId, mainAgentId, true);
      if (mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error") {
        stmts.updateAgent.run(null, "working", null, null, null, null, mainAgentId);
        broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
      }
      break;
    }

    case "Notification": {
      // Claude Code 的系统通知。如果内容表明需要用户批准/输入，则切换到 waiting。
      const notificationMessage = data.message || "Notification received";
      if (isWaitingForUserMessage(notificationMessage)) {

        const timestamp = new Date().toISOString();
        stmts.setSessionAwaitingInput.run(timestamp, sessionId);
        broadcast("session_updated", stmts.getSession.get(sessionId));
        if (mainAgentId) {
          stmts.updateAgent.run(null, "waiting", null, null, null, null, mainAgentId);
          stmts.setAgentAwaitingInput.run(timestamp, mainAgentId);
          broadcast("agent_updated", stmts.getAgent.get(mainAgentId));
        }
      }
      break;
    }

    default: {
    }
  }

  // 每次 hook 事件后，尝试从转录本 JSONL 中增量提取 token、模型、标题等信息。
  // transcriptCache 会根据文件 mtime 做缓存/增量读取，避免重复全量解析大文件。
  if (data.transcript_path) {
    const result = transcriptCache.extract(data.transcript_path);
    if (result) {
      const { tokensByModel, latestModel } = result;

      // 只有在模型发生变化时才更新 sessions.model，减少无意义更新。
      if (latestModel) {
        const updateResult = stmts.updateSessionModel.run(latestModel, sessionId, latestModel);
        if (updateResult.changes > 0) {
          const refreshed = stmts.getSession.get(sessionId);
          if (refreshed) broadcast("session_updated", refreshed);
        }
      }

      // 用 custom-title / ai-title 覆盖自动生成的会话名称。
      syncSessionName(stmts.getSession.get(sessionId), result);

      // 用第一条真实用户消息填充会话和 main agent 名称/任务。
      applyFirstUserDescriptor(sessionId, result);

      // 将解析出的各模型 token 分桶写入 token_usage 表（INSERT OR REPLACE）。
      if (tokensByModel) {
        for (const tokens of Object.values(tokensByModel)) {
          stmts.replaceTokenUsage.run(
            sessionId,
            tokens.model,
            tokens.input,
            tokens.output,
            tokens.cacheRead,
            tokens.cacheWrite
          );
        }
      }

      // 把轮次信息写入 session.metadata。
      if (result.turnDurations) {
        const session = stmts.getSession.get(sessionId);
        if (session) {
          const meta = session.metadata ? JSON.parse(session.metadata) : {};
          meta.turn_count = (meta.turn_count || 0) + result.turnDurations.length;
          stmts.updateSession.run(null, null, null, JSON.stringify(meta), sessionId);
        }
      }
    }
  }

  // 会话结束后，该转录本不会再有增量更新，清理缓存释放内存。
  if (hookType === "SessionEnd" && data.transcript_path) {
    transcriptCache.invalidate(data.transcript_path);
  }

  // 更新会话的 updated_at，供会话列表排序和活性检测使用。
  stmts.touchSession.run(sessionId);

  // 将事件持久化。tool_use_id 用于后续配对 PreToolUse/PostToolUse/PostToolUseFailure，
  // 计算工具调用成功/失败数。
  stmts.insertEvent.run(
    sessionId,
    agentId,
    eventType,
    toolName,
    toolUseId
  );

  const event = {
    session_id: sessionId,
    agent_id: agentId,
    event_type: eventType,
    tool_name: toolName,
    tool_use_id: toolUseId,
    created_at: new Date().toISOString(),
  };
  broadcast("new_event", event);
  return event;
});

router.post("/event", (req, res) => {
  const { hook_type, data } = req.body;
  if (!hook_type || !data) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "hook_type and data are required" },
    });
  }

  const result = processEvent(hook_type, data);
  if (!result) {
    return res.status(400).json({
      error: { code: "MISSING_SESSION", message: "session_id is required in data" },
    });
  }

  res.json({ ok: true, event: result });

  // SubagentStop 发生时，子 agent 的 JSONL 转录本已经落盘。
  // 扫描并导入这些子 agent 转录本，确保子 agent 的 token 成本被正确归因。
  if (hook_type === "SubagentStop" && data.session_id && data.transcript_path) {
    // 把父会话已知的模型名传给导入流程，便于子 agent token 缺失模型时做合理兜底。
    let parentTokenModelNames = [];
    try {
      const mainResult = transcriptCache.extract(data.transcript_path);
      if (mainResult && mainResult.tokensByModel) {
        parentTokenModelNames = Object.values(mainResult.tokensByModel)
          .map((tokenBucket) => tokenBucket.model)
          .filter(Boolean);
      }
      if (mainResult && mainResult.latestModel) parentTokenModelNames.push(mainResult.latestModel);
    } catch {
      // 即使提取父转录本失败，也继续导入子 agent。
    }
    scanAndImportSubagents(dbModule, data.session_id, data.transcript_path, {
      parentModels: parentTokenModelNames,
    });
  }
});

// 看门狗轮询间隔：15 秒一次。
const WATCHDOG_INTERVAL_MS = 15_000;
// 超过 10 秒没有更新的 active/error 会话才会被视为"可能失活"，进入进一步检查。
const STALE_THRESHOLD_MS = 10_000;

// main agent 在 working 状态、但没有 current_tool 也没有等待输入时，
// 如果超过该时间没有新事件/文件修改，则视为被用户中断或卡死，恢复为 waiting。
const WORKING_IDLE_MS = (() => {
  const raw = parseInt(process.env.DASHBOARD_WORKING_IDLE_SECONDS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 120_000;
})();

/**
 * 看门狗检查：处理两类问题会话。
 * 1. 用户中断 / 主 agent 空转：通过转录本中的 [Request interrupted by user] 或空闲超时判断。
 * 2. 真实 Claude 进程已退出但会话仍 active：通过 livenessReap 探测 /proc/<pid>/cwd。
 */
function watchdogCheck() {
  try {
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    // 找出一段时间内没有更新的 active/error 会话。
    // 子查询取该会话最近一条事件的时间，用于和文件 mtime 比较判断真实空闲时长。
    const staleSessions = db
      .prepare(
        `SELECT s.id, s.status, s.cwd, s.transcript_path,
                (SELECT MAX(e.created_at) FROM events e WHERE e.session_id = s.id) as last_event
         FROM sessions s
         WHERE s.status IN ('active', 'error') AND s.updated_at < ?`
      )
      .all(cutoff);

    for (const staleSession of staleSessions) {
      // 尝试定位主转录本路径；如果数据库里没记录，则按 cwd 推导默认路径。
      let transcriptPath = staleSession.transcript_path || null;

      if (!transcriptPath && staleSession.cwd) {
        const slug = staleSession.cwd.replace(/[\/.]/g, "-");
        const candidate = path.join(os.homedir(), ".claude", "projects", slug, `${staleSession.id}.jsonl`);
        if (fs.existsSync(candidate)) transcriptPath = candidate;
      }
      if (!transcriptPath) continue;

      // 增量提取转录本，获取 token、标题、中断标记等信息。
      const result = transcriptCache.extract(transcriptPath);
      if (!result) continue;

      // 先把转录本里最新的 token 数据同步到数据库，避免看门狗期间数据滞后。
      if (result.tokensByModel) {
        for (const tokens of Object.values(result.tokensByModel)) {
          stmts.replaceTokenUsage.run(
            staleSession.id,
            tokens.model,
            tokens.input || 0,
            tokens.output || 0,
            tokens.cacheRead || 0,
            tokens.cacheWrite || 0
          );
        }
      }

      const fullSession = stmts.getSession.get(staleSession.id);
      if (fullSession) {
        syncSessionName(fullSession, result);
        applyFirstUserDescriptor(staleSession.id, result);
      }

      const mainAgent = db
        .prepare("SELECT * FROM agents WHERE session_id = ? AND type = 'main' LIMIT 1")
        .get(staleSession.id);
      const mainAgentId = mainAgent?.id ?? null;

      // 如果转录本检测到 "[Request interrupted by user]" 且 main agent 仍在 working，
      // 则把会话恢复为 waiting 状态，同时清理被中断的子 agent。
      if (
        result.pendingInterrupt &&
        mainAgent &&
        mainAgent.status === "working" &&
        !mainAgent.awaiting_input_since
      ) {
        recoverInterruptedSession(staleSession.id, fullSession, mainAgentId);

        // Ctrl+C 中断时，CC 不一定会对所有子 agent 发送 SubagentStop，
        // 但会在子 agent 的 JSONL 中写入 [Request interrupted by user] 标记。
        // 在此扫描所有 working 子 agent 的转录本，清理被中断的残留。
        const orphanedSubs = db
          .prepare("SELECT * FROM agents WHERE session_id = ? AND type = 'subagent' AND status = 'working'")
          .all(staleSession.id);
        if (orphanedSubs.length > 0) {
          const subDir = path.join(path.dirname(transcriptPath), staleSession.id, "subagents");
          try {
            const entries = fs.readdirSync(subDir, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.name.endsWith(".meta.json")) continue;
              const meta = JSON.parse(fs.readFileSync(path.join(subDir, entry.name), "utf8"));
              if (!meta.description) continue;
              const agent = orphanedSubs.find((a) => a.name === meta.description);
              if (!agent) continue;
              const jsonlFile = entry.name.replace(".meta.json", ".jsonl");
              const content = fs.readFileSync(path.join(subDir, jsonlFile), "utf8");
              if (/\[Request interrupted by user/i.test(content)) {
                stmts.updateAgent.run(
                  null, "completed", null, null, new Date().toISOString(), null, agent.id
                );
                broadcast("agent_updated", stmts.getAgent.get(agent.id));
              }
            }
          } catch {
            // 子 agent 目录不存在或不可读，跳过清理
          }
        }

        continue;
      }

      // 主 agent 处于 working、但没有任何 current_tool 也没有等待输入，
      // 且转录本/事件都长时间未更新，说明 Claude 可能已经停止但漏发 Stop hook，
      // 同样恢复为 waiting。
      if (
        mainAgent &&
        mainAgent.status === "working" &&
        !mainAgent.current_tool &&
        !mainAgent.awaiting_input_since
      ) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(transcriptPath).mtimeMs;
        } catch {
          // 读不到 mtime 就当作 0，下面会用 hookMs 兜底。
        }
        const hookMs = Date.parse(staleSession.last_event) || 0;
        const idleMs = Date.now() - Math.max(mtimeMs, hookMs);
        if (idleMs > WORKING_IDLE_MS) {
          recoverInterruptedSession(staleSession.id, fullSession, mainAgentId);
        }
      }
      continue;
    }

    // 最后再做一次进程活性收割：把真实 Claude 进程已退出的 active 会话标记为 error。
    livenessReap();
  } catch (err) {
    console.warn("[WATCHDOG] Error during check:", err?.message || err);
  }
}

/**
 * 活性收割：检查每个 active 会话的 cwd 是否仍对应一个存活的 Claude Code 进程。
 * 如果找不到对应进程，则把会话及其未结束的 agents 全部标记为 error，并插入 SessionEnd 事件。
 *
 * 注意：
 * - SIGTERM（kill）退出的 Claude 进程会正常走 hook，不会到这里；
 * - SIGKILL（kill -9）或异常崩溃会跳过 SessionEnd hook，需要活性检测兜底。
 */
function livenessReap() {
  const path = require("path");

  const activeSessions = db
    .prepare(
      `SELECT id, name, cwd, transcript_path, updated_at FROM sessions
       WHERE status = 'active' AND cwd IS NOT NULL AND cwd <> ''`
    )
    .all();
  if (activeSessions.length === 0) return;

  // 获取所有存活 Claude 进程的 cwd 集合。
  const probe = liveness.probeLiveCwds();
  if (!probe.available) return;
  for (const staleSession of activeSessions) {
    let resolvedCwd;
    try {
      resolvedCwd = path.resolve(staleSession.cwd);
    } catch {
      continue;
    }
    // cwd 仍在存活集合中，说明对应进程还在运行，跳过。
    if (probe.cwds.has(resolvedCwd)) continue;

    // cwd 不在存活集合中，认为进程已退出/崩溃，把会话标记为 error。
    const timestamp = new Date().toISOString();
    clearAwaitingInput(staleSession.id, null, false);
    const agents = stmts.listAgentsBySession.all(staleSession.id);
    for (const agent of agents) {
      if (agent.status !== "completed" && agent.status !== "error") {
        stmts.updateAgent.run(null, "error", null, null, timestamp, null, agent.id);
      }
    }
    stmts.updateSession.run(null, "error", timestamp, null, staleSession.id);

    // 插入一条 SessionEnd 事件，保持事件序列完整。
    const label = staleSession.name || `Session ${staleSession.id.slice(0, 8)}`;
    const mainAgentId = `${staleSession.id}-main`;
    stmts.insertEvent.run(
      staleSession.id,
      stmts.getAgent.get(mainAgentId) ? mainAgentId : null,
      "SessionEnd",
      null,
      null
    );

    broadcast("session_updated", stmts.getSession.get(staleSession.id));
    for (const agent of agents) {
      if (agent.status !== "completed" && agent.status !== "error") {
        broadcast("agent_updated", stmts.getAgent.get(agent.id));
      }
    }
    broadcast("new_event", {
      session_id: staleSession.id,
      agent_id: stmts.getAgent.get(mainAgentId) ? mainAgentId : null,
      event_type: "SessionEnd",
      tool_name: null,
      created_at: timestamp,
    });
    console.log(`[WATCHDOG] Liveness reap: completed dead session ${staleSession.id} (${label})`);
  }
}

const watchdogTimer = setInterval(watchdogCheck, WATCHDOG_INTERVAL_MS);

if (watchdogTimer.unref) watchdogTimer.unref();

router.livenessReap = livenessReap;
module.exports = router;
