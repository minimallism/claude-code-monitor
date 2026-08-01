const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isInsideContainer } = require("../../scripts/install-hooks");

const UNAVAILABLE = () => ({ available: false, cwds: new Set() });

function isClaudeCommand(args) {
  if (typeof args !== "string") return false;
  const tokens = args.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return false;
  if (path.basename(tokens[0]) === "claude") return true;
  const interpreter = path.basename(tokens[0]);
  if ((interpreter === "node" || interpreter === "bun") && tokens[1]) {
    return path.basename(tokens[1]) === "claude";
  }
  return false;
}

function probeDisabledByEnv() {
  const raw = (process.env.DASHBOARD_LIVENESS_PROBE || "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

/**
 * List all claude processes via ps.
 * Returns [{ pid, user, state, pcpu, pmem, rss, vsz, nice, comm, args }].
 * Returns empty array on failure or unsupported platform.
 */
function listClaudeProcesses() {
  if (process.platform === "win32") return [];

  let psOut;
  try {
    psOut = execFileSync("ps", [
      "-Ao",
      "pid=,user=,state=,pcpu=,pmem=,rss=,vsz=,nice=,comm=,args=",
    ], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const processes = [];
  for (const line of psOut.split("\n")) {
    const processMatch = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/);
    if (!processMatch) continue;
    if (!isClaudeCommand(processMatch[10])) continue;
    processes.push({
      pid: parseInt(processMatch[1], 10),
      user: processMatch[2],
      state: processMatch[3],
      pcpu: parseFloat(processMatch[4]),
      pmem: parseFloat(processMatch[5]),
      rss: parseInt(processMatch[6], 10),
      vsz: parseInt(processMatch[7], 10),
      nice: parseInt(processMatch[8], 10),
      comm: processMatch[9],
      args: processMatch[10],
    });
  }
  return processes;
}

/**
 * Probe live claude process cwds for session error detection.
 * Returns { available: boolean, cwds: Set<string> }.
 */
function probeLiveCwds() {
  if (probeDisabledByEnv()) return UNAVAILABLE();
  if (process.platform === "win32") return UNAVAILABLE();
  if (isInsideContainer()) return UNAVAILABLE();

  const processes = listClaudeProcesses();
  const pids = processes.map((p) => String(p.pid));
  const cwds = new Set();
  if (pids.length === 0) return { available: true, cwds };

  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        cwds.add(path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`)));
      } catch {
        /* empty */
      }
    }
    return { available: true, cwds };
  }

  /* macOS: use lsof to get cwd */
  let lsofOut;
  try {
    lsofOut = execFileSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    lsofOut = error && typeof error.stdout === "string" && error.stdout ? error.stdout : null;
    if (lsofOut === null) return UNAVAILABLE();
  }
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("n") && line.length > 1) cwds.add(path.resolve(line.slice(1)));
  }
  return { available: true, cwds };
}

module.exports = { probeLiveCwds, listClaudeProcesses };
