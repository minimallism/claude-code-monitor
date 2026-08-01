/**
 * Claude Code 进程管理 API。
 *
 * 提供当前系统中 Claude Code 进程列表查询，以及通过 PID 发送 SIGTERM 终止进程。
 *
 * 限制：
 * - 仅在类 Unix 系统上可用（依赖 /proc/<pid>/...）。
 * - 终止进程属于危险操作，前端需要二次确认。
 */

const fs = require("node:fs");
const nodeProcess = require("node:process");
const { Router } = require("express");
const { listClaudeProcesses } = require("../lib/session-liveness");

const router = Router();

/**
 * 读取 Linux /proc/<pid>/cmdline 文件，把以 \0 分隔的参数拼接成完整命令行。
 */
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

/**
 * GET /api/processes
 *
 * 返回当前系统中识别到的 Claude Code 进程列表。
 * Linux 下额外读取 /proc/<pid>/cwd 作为工作目录供前端关联会话。
 */
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

/**
 * POST /api/processes/:pid/kill
 *
 * 向指定 PID 发送 SIGTERM。先通过 signal 0 探测进程是否存在，
 * 再执行 kill，避免对不存在或已退出的进程误操作。
 */
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
