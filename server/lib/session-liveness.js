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

function probeLiveCwds() {
  if (probeDisabledByEnv()) return UNAVAILABLE();
  if (process.platform === "win32") return UNAVAILABLE();
  if (isInsideContainer()) return UNAVAILABLE();

  let psOut;
  try {
    psOut = execFileSync("ps", ["-Ao", "pid=,args="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return UNAVAILABLE();
  }

  const pids = [];
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && isClaudeCommand(m[2])) pids.push(m[1]);
  }
  const cwds = new Set();
  if (pids.length === 0) return { available: true, cwds };

  if (process.platform === "linux") {
    
    for (const pid of pids) {
      try {
        cwds.add(path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`)));
      } catch {
        
      }
    }
    return { available: true, cwds };
  }

  
  
  let lsofOut;
  try {
    lsofOut = execFileSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    
    
    
    lsofOut = err && typeof err.stdout === "string" && err.stdout ? err.stdout : null;
    if (lsofOut === null) return UNAVAILABLE();
  }
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("n") && line.length > 1) cwds.add(path.resolve(line.slice(1)));
  }
  return { available: true, cwds };
}

module.exports = { probeLiveCwds, isClaudeCommand };
