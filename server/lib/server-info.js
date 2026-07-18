const fs = require("fs");
const path = require("path");

const { getClaudeHome } = require("./claude-home");

const DEFAULT_PORT = 4820;

function getServerInfoPath() {
  return path.join(getClaudeHome(), ".agent-dashboard.json");
}

function readInfoFile() {
  try {
    const raw = fs.readFileSync(getServerInfoPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.servers)) {
      return parsed.servers.filter((s) => s && Number.isInteger(s.port));
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
  } catch (err) {
    return Boolean(err) && err.code === "EPERM";
  }
}

function mostRecent(servers) {
  return servers.reduce((a, b) => {
    const at = Date.parse(a.startedAt) || 0;
    const bt = Date.parse(b.startedAt) || 0;
    return bt > at ? b : a;
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
    const dir = getClaudeHome();
    fs.mkdirSync(dir, { recursive: true });
    const existing = readInfoFile().filter(
      (s) => Number.isInteger(s.port) && s.port > 0 && s.pid !== process.pid && isPidAlive(s.pid)
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
    const remaining = readInfoFile().filter((s) => s.pid !== process.pid);
    persist(remaining);
  } catch {
    
  }
}

function resolveAllDashboardPorts() {
  const envPort = parseInt(process.env.CLAUDE_DASHBOARD_PORT || "", 10);
  if (Number.isInteger(envPort) && envPort > 0) return [envPort];

  const live = readInfoFile().filter(
    (s) => Number.isInteger(s.port) && s.port > 0 && isPidAlive(s.pid)
  );
  if (live.length > 0) {
    
    return [...new Set(live.map((s) => s.port))];
  }
  return [DEFAULT_PORT];
}

function resolveDashboardPort() {
  return resolveAllDashboardPorts()[0] ?? DEFAULT_PORT;
}

module.exports = {
  DEFAULT_PORT,
  getServerInfoPath,
  writeServerInfo,
  removeServerInfo,
  resolveDashboardPort,
  resolveAllDashboardPorts,
};
