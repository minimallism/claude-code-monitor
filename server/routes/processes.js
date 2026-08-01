const fs = require("node:fs");
const nodeProcess = require("node:process");
const { Router } = require("express");
const { listClaudeProcesses } = require("../lib/session-liveness");

const router = Router();

function readCmdline(pid) {
  try {
    const cmdlineBuffer = fs.readFileSync(`/proc/${pid}/cmdline`);
    const parts = cmdlineBuffer
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return parts.join(" ");
  } catch {
    return null;
  }
}

router.get("/", (_req, res) => {
  const processList = listClaudeProcesses();
  const processes = processList.map((processInfo) => {
    let cwd = null;
    if (process.platform === "linux") {
      try {
        cwd = fs.readlinkSync(`/proc/${processInfo.pid}/cwd`);
      } catch {
        /* process may have exited */
      }
    }
    return {
      pid: processInfo.pid,
      ppid: 0,
      user: processInfo.user,
      state: processInfo.state,
      cpu_percent: processInfo.pcpu,
      mem_percent: processInfo.pmem,
      rss_kb: processInfo.rss,
      vsz_kb: processInfo.vsz,
      nice: processInfo.nice,
      time: "-",
      comm: processInfo.comm,
      args: readCmdline(processInfo.pid) || processInfo.args,
      cwd,
    };
  });

  res.json({ processes });
});

router.post("/:pid/kill", (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (Number.isNaN(pid) || pid <= 0) {
    return res.status(400).json({ error: { code: "INVALID_PID", message: "Invalid PID" } });
  }

  try {
    const alive = nodeProcess.kill(pid, 0);
    if (!alive) {
      return res.status(404).json({ error: { code: "PROCESS_NOT_FOUND", message: "Process not found" } });
    }
    nodeProcess.kill(pid, "SIGTERM");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: { code: "KILL_FAILED", message: error.message } });
  }
});

module.exports = router;
