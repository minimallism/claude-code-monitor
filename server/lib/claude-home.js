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
    for (const workflowDirEntry of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!workflowDirEntry.isDirectory()) continue;
      const candidate = path.join(workflowsDir, workflowDirEntry.name, `agent-${agentId}.jsonl`);
      if (fs.existsSync(candidate)) matches.push(candidate);
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
    for (const projectDirEntry of dirs) {
      if (!projectDirEntry.isDirectory()) continue;
      const candidate = path.join(projectsDir, projectDirEntry.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    
  }
  return null;
}

function findSubagentTranscriptPath(sessionId, agentId, runId = null) {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const projectDirEntry of dirs) {
      if (!projectDirEntry.isDirectory()) continue;
      const subagentsDir = path.join(projectsDir, projectDirEntry.name, sessionId, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;

      
      const matchedPath = resolveAgentTranscriptInDir(subagentsDir, agentId, runId);
      if (matchedPath) return matchedPath;

      
      if (agentId.startsWith("acompact-")) {
        const files = fs.readdirSync(subagentsDir);
        const match = files.find((fileName) => fileName.startsWith("agent-acompact-") && fileName.endsWith(".jsonl"));
        if (match) return path.join(subagentsDir, match);
      }
    }
  } catch {
    
  }
  return null;
}

module.exports = {
  getClaudeHome,
  getProjectsDir,
  getDataDir,
  getSettingsPath,
  getTranscriptPath,
  getSubagentTranscriptPath,
  findTranscriptPath,
  findSubagentTranscriptPath,
};
