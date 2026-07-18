const path = require("path");
const os = require("os");
const fs = require("fs");

function getClaudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function getProjectsDir() {
  return path.join(getClaudeHome(), "projects");
}

function getDataDir() {
  return process.env.DASHBOARD_DATA_DIR || path.join(getClaudeHome(), "agent-dashboard");
}

function getTranscriptSnapshotDir() {
  return path.join(getDataDir(), "transcripts");
}

function getSettingsPath() {
  return path.join(getClaudeHome(), "settings.json");
}

function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function getTranscriptPath(sessionId, cwd) {
  if (!cwd) return null;
  const encoded = encodeCwd(cwd);
  const candidate = path.join(getProjectsDir(), encoded, `${sessionId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;
  
  return findTranscriptPath(sessionId);
}

function resolveAgentTranscriptInDir(subagentsDir, agentId, runId = null) {
  if (!subagentsDir) return null;
  const flat = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  if (fs.existsSync(flat)) return flat;

  const workflowsDir = path.join(subagentsDir, "workflows");
  if (!fs.existsSync(workflowsDir)) return null;

  if (runId) {
    const nested = path.join(workflowsDir, runId, `agent-${agentId}.jsonl`);
    return fs.existsSync(nested) ? nested : null;
  }

  
  try {
    const matches = [];
    for (const d of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const cand = path.join(workflowsDir, d.name, `agent-${agentId}.jsonl`);
      if (fs.existsSync(cand)) matches.push(cand);
      if (matches.length > 1) break;
    }
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

function getSubagentTranscriptPath(sessionId, cwd, agentId, runId = null) {
  if (!cwd) return null;
  const encoded = encodeCwd(cwd);
  const subagentsDir = path.join(getProjectsDir(), encoded, sessionId, "subagents");
  const direct = resolveAgentTranscriptInDir(subagentsDir, agentId, runId);
  if (direct) return direct;
  
  return findSubagentTranscriptPath(sessionId, agentId, runId);
}

function findTranscriptPath(sessionId) {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    
  }
  return null;
}

function getSnapshotTranscriptPath(sessionId) {
  const candidate = path.join(getTranscriptSnapshotDir(), `${sessionId}.jsonl`);
  return fs.existsSync(candidate) ? candidate : null;
}

function getSnapshotSubagentTranscriptPath(sessionId, agentId, runId = null) {
  const subDir = path.join(getTranscriptSnapshotDir(), sessionId, "subagents");
  if (!fs.existsSync(subDir)) return null;
  const hit = resolveAgentTranscriptInDir(subDir, agentId, runId);
  if (hit) return hit;
  if (agentId.startsWith("acompact-")) {
    try {
      const match = fs
        .readdirSync(subDir)
        .find((f) => f.startsWith("agent-acompact-") && f.endsWith(".jsonl"));
      if (match) return path.join(subDir, match);
    } catch {
      
    }
  }
  return null;
}

function findSubagentTranscriptPath(sessionId, agentId, runId = null) {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const subagentsDir = path.join(projectsDir, d.name, sessionId, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;

      
      const hit = resolveAgentTranscriptInDir(subagentsDir, agentId, runId);
      if (hit) return hit;

      
      if (agentId.startsWith("acompact-")) {
        const files = fs.readdirSync(subagentsDir);
        const match = files.find((f) => f.startsWith("agent-acompact-") && f.endsWith(".jsonl"));
        if (match) return path.join(subagentsDir, match);
      }
    }
  } catch {
    
  }
  return null;
}

function setClaudeHome(newPath) {
  const resolved = newPath.replace(/^~(?=\/)/, os.homedir());
  if (!path.isAbsolute(resolved)) {
    throw new Error("CLAUDE_HOME must be an absolute path");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  process.env.CLAUDE_HOME = resolved;
  writeEnvFile("CLAUDE_HOME", resolved);
  return resolved;
}

function writeEnvFile(key, value) {
  const envPath = path.resolve(__dirname, "..", "..", ".env");
  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf8").split("\n");
  }
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    lines.push(`${key}=${value}`);
  }
  
  const tempPath = envPath + ".tmp";
  fs.writeFileSync(tempPath, lines.join("\n") + "\n", "utf8");
  fs.renameSync(tempPath, envPath);
}

module.exports = {
  getClaudeHome,
  getProjectsDir,
  getDataDir,
  getTranscriptSnapshotDir,
  getSettingsPath,
  getTranscriptPath,
  resolveAgentTranscriptInDir,
  getSubagentTranscriptPath,
  getSnapshotTranscriptPath,
  getSnapshotSubagentTranscriptPath,
  findTranscriptPath,
  findSubagentTranscriptPath,
  setClaudeHome,
  writeEnvFile,
};
