#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { getSettingsPath } = require("../server/lib/claude-home");
const SETTINGS_PATH = getSettingsPath();
const HOOK_HANDLER = path.resolve(__dirname, "hook-handler.js").replace(/\\/g, "/");

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

const HOOKS_WITH_MATCHER = ["PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification"];

const HOOKS_WITHOUT_MATCHER = ["SessionStart", "SessionEnd", "UserPromptSubmit"];
const HOOK_TYPES = [...HOOKS_WITH_MATCHER, ...HOOKS_WITHOUT_MATCHER];

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

function isOurEntry(entry) {
  
  if (entry.command && entry.command.includes("hook-handler.js")) return true;
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some((h) => h.command && h.command.includes("hook-handler.js"));
  }
  return false;
}

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

function installHooks(silent = false) {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
      settings = JSON.parse(raw);
    } catch (err) {
      if (!silent) console.error(`Failed to parse ${SETTINGS_PATH}:`, err.message);
      return false;
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let installed = 0;
  let updated = 0;

  for (const hookType of HOOK_TYPES) {
    if (!settings.hooks[hookType]) settings.hooks[hookType] = [];

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

  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");

  if (!silent) {
    console.log(`Hook handler: ${HOOK_HANDLER}`);
    console.log(`Settings file: ${SETTINGS_PATH}`);
    console.log(`Installed: ${installed} new, updated: ${updated} existing`);
    console.log("Claude Code hooks configured. Start a new Claude Code session to begin tracking.");
  }

  return true;
}

if (require.main === module) {
  
  if (!installHooks(false)) process.exitCode = 1;
}

module.exports = { installHooks, isInsideContainer };
