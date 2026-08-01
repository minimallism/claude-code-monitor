const { Router } = require("express");
const fs = require("fs");
const path = require("path");
const { db, DB_PATH } = require("../db");

const router = Router();

const { getSettingsPath, getProjectsDir } = require("../lib/claude-home");
const CLAUDE_SETTINGS_PATH = getSettingsPath();

function getDbSize() {
  try {
    const stat = fs.statSync(DB_PATH);
    return stat.size;
  } catch {
    return 0;
  }
}

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
