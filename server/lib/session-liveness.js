const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isInsideContainer } = require("../../scripts/install-hooks");

/**
 * 探针不可用时的统一返回值。
 * 使用 Set 是为了让调用方用 cwds.has(cwd) 做 O(1) 判断。
 */
const UNAVAILABLE = () => ({ available: false, cwds: new Set() });

/**
 * 判断 ps 的一行 args 是否属于 Claude Code 进程。
 * 支持直接调用 `claude` 或通过 node/bun 调用的 `claude` 脚本入口。
 */
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

/**
 * 允许通过环境变量彻底关闭活性探针，避免在容器等特殊环境中误报。
 */
function probeDisabledByEnv() {
  const raw = (process.env.DASHBOARD_LIVENESS_PROBE || "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

/**
 * 通过 ps 列出系统中所有 Claude Code 进程。
 * 返回数组：{ pid, user, state, pcpu, pmem, rss, vsz, nice, comm, args }。
 * Windows 不支持；执行失败时返回空数组，避免影响监控服务可用性。
 *
 * 注意：ps 输出格式固定为 "pid=,user=,state=,..."，等号表示列标题仍保留但宽度为 0，
 * 这样数据之间仅用空格分隔，便于正则一次性解析。
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
    // 严格匹配 ps 的 10 列输出：pid user state pcpu pmem rss vsz nice comm args。
    // 最后一列 args 可能包含空格，所以用 (.*)$ 贪婪捕获。
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
 * 探测当前系统中真实存活的 Claude Code 进程的当前工作目录（cwd）。
 * 返回 { available: boolean, cwds: Set<string> }。
 *
 * 设计要点：
 * - 活性检测只应在非容器、非 Windows 环境运行；Windows 和容器内直接返回不可用。
 * - 通过 /proc/<pid>/cwd（Linux）或 lsof（macOS）拿到每个 Claude 进程的实际 cwd，
 *   然后和 sessions 表中的 cwd 比对。若某 active 会话的 cwd 不在存活集合中，
 *   说明对应的 Claude 进程已退出/崩溃，需要把会话标记为 error（见 hooks.js livenessReap）。
 */
function probeLiveCwds() {
  if (probeDisabledByEnv()) return UNAVAILABLE();
  if (process.platform === "win32") return UNAVAILABLE();
  if (isInsideContainer()) return UNAVAILABLE();

  const processes = listClaudeProcesses();
  const pids = processes.map((p) => String(p.pid));
  const cwds = new Set();
  if (pids.length === 0) return { available: true, cwds };

  // Linux：/proc/<pid>/cwd 是符号链接，指向进程当前工作目录，readlinkSync 可解析真实路径。
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

  // macOS：没有 /proc，使用 lsof 获取每个进程的 cwd。
  // 参数说明：-a 表示条件与；-p 指定 pid 列表；-d cwd 只显示 cwd 文件描述符；-Fn 输出文件名前缀。
  let lsofOut;
  try {
    lsofOut = execFileSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // lsof 在被过滤无结果时也可能抛错，但会把部分输出放到 error.stdout，优先使用 stdout。
    lsofOut = error && typeof error.stdout === "string" && error.stdout ? error.stdout : null;
    if (lsofOut === null) return UNAVAILABLE();
  }
  // -Fn 输出格式：每行以 n 开头，后面跟着文件路径。
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("n") && line.length > 1) cwds.add(path.resolve(line.slice(1)));
  }
  return { available: true, cwds };
}

module.exports = { probeLiveCwds, listClaudeProcesses };
