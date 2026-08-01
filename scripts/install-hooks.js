#!/usr/bin/env node

/**
 * Claude Code user hooks 自动安装脚本。
 *
 * 该脚本把 dashboard 的 hook-handler.js 注册到 Claude Code 的 settings.json 中，
 * 使得 Claude Code 在特定生命周期点把事件发送到 dashboard 服务端。
 *
 * Claude Code hooks 文档：
 *   https://docs.anthropic.com/en/docs/claude-code/coding-with-claude/user-hooks
 *
 * 支持两类 hook：
 * - 带 matcher 的 hook：PreToolUse/PostToolUse/PostToolUseFailure/Stop/SubagentStop/Notification。
 *   这些 hook 需要 matcher="*" 才会对所有匹配事件触发。
 * - 不带 matcher 的 hook：SessionStart/SessionEnd/UserPromptSubmit。
 *   这些事件本身没有 matcher 字段，直接注册即可。
 */

const fs = require("fs");
const path = require("path");

const { getSettingsPath } = require("../server/lib/claude-home");
const SETTINGS_PATH = getSettingsPath();
// 把 hook-handler.js 的绝对路径中的反斜杠替换为正斜杠，避免 Windows 下 JSON 转义问题。
const HOOK_HANDLER = path.resolve(__dirname, "hook-handler.js").replace(/\\/g, "/");

// 需要配置 matcher: "*" 的 hook 类型。
const HOOKS_WITH_MATCHER = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "Notification"];

// 不需要 matcher 的全局事件 hook 类型。
const HOOKS_WITHOUT_MATCHER = ["SessionStart", "SessionEnd", "UserPromptSubmit"];
const HOOK_TYPES = [...HOOKS_WITH_MATCHER, ...HOOKS_WITHOUT_MATCHER];

/**
 * 为指定 hook 类型构造 Claude Code settings.json 中的条目。
 *
 * 结构示例：
 *   "PreToolUse": [{
 *     "matcher": "*",
 *     "hooks": [{ "type": "command", "command": "node /path/to/hook-handler.js PreToolUse" }]
 *   }]
 */
function makeHookEntry(hookType) {
  const entry = {
    hooks: [
      {
        type: "command",
        command: `node "${HOOK_HANDLER}" ${hookType}`,
      },
    ],
  };
  if (HOOKS_WITH_MATCHER.includes(hookType)) {
    entry.matcher = "*";
  }
  return entry;
}

/**
 * 判断 settings.json 中某个 hook 条目是否由本脚本创建。
 *
 * 兼容两种历史格式：
 * - 扁平格式：{ command: "node .../hook-handler.js PreToolUse" }
 * - 嵌套格式：{ hooks: [{ command: "node .../hook-handler.js PreToolUse" }] }
 */
function isOurEntry(entry) {
  if (entry.command && entry.command.includes("hook-handler.js")) return true;
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some((nestedHook) => nestedHook.command && nestedHook.command.includes("hook-handler.js"));
  }
  return false;
}

/**
 * 检测当前是否运行在容器环境中。
 *
 * 判断依据（按优先级）：
 * 1. 常见容器相关环境变量（CONTAINER、KUBERNETES_SERVICE_HOST 等）。
 * 2. 容器运行时标记文件（/.dockerenv、/run/.containerenv）。
 * 3. /proc/self/cgroup 内容包含 "docker" 或 "container"。
 *
 * 容器内通常不建议直接修改宿主机的 Claude Code 设置文件，
 * 因此 installHooks 调用方可以据此给出警告或跳过安装。
 */
function isInsideContainer() {
  if (process.env.CONTAINER || process.env.KUBERNETES_SERVICE_HOST || process.env.KUBERNETES_PORT || process.env.POD_NAME) {
    return true;
  }
  if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) {
    return true;
  }
  try {
    if (fs.existsSync("/proc/self/cgroup")) {
      const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
      if (cgroup.includes("docker") || cgroup.includes("container")) {
        return true;
      }
    }
  } catch {
    
  }
  return false;
}

/**
 * 把 dashboard 的 hooks 写入 Claude Code settings.json。
 *
 * 流程：
 * 1. 读取现有 settings.json（如果不存在则从空对象开始）。
 * 2. 对每个 HOOK_TYPE：
 *    - 如果已有本脚本创建的条目，则替换为新配置（幂等更新）。
 *    - 否则追加新配置。
 * 3. 写回 settings.json（自动创建缺失的目录）。
 *
 * @param {boolean} silent - 为 true 时不打印日志（供 server 启动时静默调用）。
 * @returns {boolean} 是否成功写入。
 */
function installHooks(silent = false) {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settingsJson = fs.readFileSync(SETTINGS_PATH, "utf8");
      settings = JSON.parse(settingsJson);
    } catch (error) {
      if (!silent) console.error(`Failed to parse ${SETTINGS_PATH}:`, error.message);
      return false;
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let installed = 0;
  let updated = 0;

  for (const hookType of HOOK_TYPES) {
    if (!settings.hooks[hookType]) settings.hooks[hookType] = [];

    // 查找本脚本之前写入的条目；存在则更新，不存在则追加。
    const existing = settings.hooks[hookType].findIndex(isOurEntry);
    const entry = makeHookEntry(hookType);

    if (existing >= 0) {
      settings.hooks[hookType][existing] = entry;
      updated++;
    } else {
      settings.hooks[hookType].push(entry);
      installed++;
    }
  }

  const settingsDir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");

  if (!silent) {
    console.log(`Hook handler: ${HOOK_HANDLER}`);
    console.log(`Settings file: ${SETTINGS_PATH}`);
    console.log(`Installed: ${installed} new, updated: ${updated} existing`);
    console.log("Claude Code hooks configured. Start a new Claude Code session to begin tracking.");
  }

  return true;
}

// 作为独立脚本运行时直接安装；失败时以非零退出码退出。
if (require.main === module) {
  if (!installHooks(false)) process.exitCode = 1;
}

module.exports = { installHooks, isInsideContainer };
