const fs = require("fs");
const path = require("path");

const { getClaudeHome } = require("./claude-home");

function getServerInfoPath() {
  return path.join(getClaudeHome(), ".agent-dashboard.json");
}

function readInfoFile() {
  try {
    const fileContent = fs.readFileSync(getServerInfoPath(), "utf8");
    const parsed = JSON.parse(fileContent);
    if (Array.isArray(parsed.servers)) {
      return parsed.servers.filter((serverInfo) => serverInfo && Number.isInteger(serverInfo.port));
    }
    if (Number.isInteger(parsed.port)) {
      
      
      return [{ port: parsed.port, pid: parsed.pid, startedAt: parsed.startedAt }];
    }
    return [];
  } catch {
    return [];
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === "EPERM";
  }
}

function mostRecent(servers) {
  return servers.reduce((serverA, serverB) => {
    const startedAtA = Date.parse(serverA.startedAt) || 0;
    const startedAtB = Date.parse(serverB.startedAt) || 0;
    return startedAtB > startedAtA ? serverB : serverA;
  });
}

function persist(servers) {
  if (servers.length === 0) {
    try {
      fs.unlinkSync(getServerInfoPath());
    } catch {
      
    }
    return;
  }
  const recent = mostRecent(servers);
  const payload = JSON.stringify(
    {
      
      
      
      port: recent.port,
      pid: recent.pid,
      startedAt: recent.startedAt,
      
      servers,
    },
    null,
    2
  );
  const finalPath = getServerInfoPath();
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, finalPath);
}

function writeServerInfo(port) {
  if (!Number.isInteger(port) || port <= 0) return;
  try {
    const claudeHomeDir = getClaudeHome();
    fs.mkdirSync(claudeHomeDir, { recursive: true });
    const existing = readInfoFile().filter(
      (serverInfo) => Number.isInteger(serverInfo.port) && serverInfo.port > 0 && serverInfo.pid !== process.pid && isPidAlive(serverInfo.pid)
    );
    const ours = {
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    persist([...existing, ours]);
  } catch {
    
  }
}

function removeServerInfo() {
  try {
    const remaining = readInfoFile().filter((serverInfo) => serverInfo.pid !== process.pid);
    persist(remaining);
  } catch {
    
  }
}

function resolveAllDashboardPorts() {
  const envPort = parseInt(process.env.CLAUDE_DASHBOARD_PORT || "", 10);
  if (Number.isInteger(envPort) && envPort > 0) return [envPort];

  const live = readInfoFile().filter(
    (serverInfo) => Number.isInteger(serverInfo.port) && serverInfo.port > 0 && isPidAlive(serverInfo.pid)
  );
  if (live.length > 0) {
    
    return [...new Set(live.map((serverInfo) => serverInfo.port))];
  }
  return [4820];
}

module.exports = {
  writeServerInfo,
  removeServerInfo,
  resolveAllDashboardPorts,
};
