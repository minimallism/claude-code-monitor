/**
 * 设置与系统信息 API。
 *
 * 提供：
 * - 数据库路径/大小、服务运行时长/内存占用。
 * - Claude Code hooks 安装状态检测。
 * - 一键重新安装 hooks。
 * - 删除某个 project 下的所有会话文件及数据库记录（危险操作）。
 */

const { Router } = require("express");
const fs = require("fs");
const path = require("path");
const { db, DB_PATH } = require("../db");

const router = Router();

const { getSettingsPath, getProjectsDir } = require("../lib/claude-home");
const CLAUDE_SETTINGS_PATH = getSettingsPath();

/**
 * 获取数据库文件大小（字节）。
 */
function getDbSize() {
  try {
    const stat = fs.statSync(DB_PATH);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * 检测 Claude Code settings.json 中是否已配置 dashboard 的 hooks。
 *
 * 逻辑：对每个关注的 hookType，检查其 hooks 数组中是否存在命令包含
 * "hook-handler.js" 的条目。只有所有类型都配置好才视为 installed=true。
 */
function getHookStatus() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return { installed: false, path: CLAUDE_SETTINGS_PATH, hooks: {} };
    }
    const settingsJson = fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(settingsJson);
    const hookTypes = [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "SubagentStop",
      "Notification",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
    ];
    const hooks = {};
    for (const hookType of hookTypes) {
      const entries = settings.hooks?.[hookType] || [];
      hooks[hookType] = entries.some(
        (hookEntry) =>
          (hookEntry.command && hookEntry.command.includes("hook-handler.js")) ||
          (Array.isArray(hookEntry.hooks) &&
            hookEntry.hooks.some((nestedHook) => nestedHook.command && nestedHook.command.includes("hook-handler.js")))
      );
    }
    const installed = Object.values(hooks).every(Boolean);
    return { installed, path: CLAUDE_SETTINGS_PATH, hooks };
  } catch {
    return { installed: false, path: CLAUDE_SETTINGS_PATH, hooks: {} };
  }
}

/**
 * GET /api/settings/info
 *
 * 返回数据库信息、hooks 安装状态和服务运行时信息。
 */
router.get("/info", (req, res) => {
  const dbSize = getDbSize();
  const hookStatus = getHookStatus();

  res.json({
    db: {
      path: DB_PATH,
      size: dbSize,
    },
    hooks: hookStatus,
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    },
  });
});

/**
 * POST /api/settings/reinstall-hooks
 *
 * 重新调用 install-hooks.js 把 hook 配置写入 Claude Code settings.json。
 */
router.post("/reinstall-hooks", (_req, res) => {
  try {
    const { installHooks } = require("../../scripts/install-hooks");
    const success = installHooks(true);
    const hookStatus = getHookStatus();
    res.json({ ok: success, hooks: hookStatus });
  } catch (error) {
    res.status(500).json({
      error: { code: "HOOK_INSTALL_FAILED", message: error.message },
    });
  }
});

/**
 * DELETE /api/settings/projects/:encodedCwd
 *
 * 删除指定编码 cwd 对应的项目：
 * 1. 校验该编码确实对应数据库中的某个 cwd。
 * 2. 删除该项目目录下所有会话 JSONL 及子 agent 目录。
 * 3. 从数据库删除这些会话（级联删除关联的 agents/events/token_usage）。
 * 4. 若项目目录已空，则删除该目录。
 */
router.delete("/projects/:encodedCwd", (req, res) => {
  const { encodedCwd } = req.params;
  const projectsDir = getProjectsDir();
  const allowed = db
    .prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != ''")
    .all()
    .map((r) => r.cwd)
    .find((d) => d.replace(/[^a-zA-Z0-9]/g, "-") === encodedCwd);

  if (!allowed) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "Project not found in database" },
    });
  }

  const sessions = db.prepare("SELECT id FROM sessions WHERE cwd = ?").all(allowed);
  const deleted = { sessions: sessions.length, files: 0 };

  const projectDir = path.join(projectsDir, encodedCwd);
  for (const row of sessions) {
    const jsonlPath = path.join(projectDir, `${row.id}.jsonl`);
    try {
      if (fs.existsSync(jsonlPath)) {
        fs.unlinkSync(jsonlPath);
        deleted.files++;
      }
    } catch { }

    const subDir = path.join(projectDir, row.id);
    if (fs.existsSync(subDir)) {
      try {
        fs.rmSync(subDir, { recursive: true, force: true });
      } catch { }
    }
  }

  db.prepare("DELETE FROM sessions WHERE cwd = ?").run(allowed);

  try {
    if (fs.existsSync(projectDir) && fs.readdirSync(projectDir).length === 0) {
      fs.rmdirSync(projectDir);
    }
  } catch { }

  res.json({ ok: true, deleted });
});

module.exports = router;
