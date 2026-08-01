#!/usr/bin/env node

/**
 * 开发环境启动脚本。
 *
 * 该脚本用于 `npm run dev`，职责：
 * 1. 在 DASHBOARD_PORT 开始的 40 个端口范围内找到一个可用端口。
 * 2. 使用 npx concurrently 同时启动后端（node --watch）和前端（vite）。
 * 3. 把 Ctrl+C / kill 信号正确转发给子进程，保证开发服务器能干净退出。
 *
 * 端口探测同时检查 127.0.0.1 和 ::1，避免某协议栈占用导致误报。
 */

const net = require("node:net");
const { spawn } = require("node:child_process");

// 默认从 4820 开始探测；可通过 DASHBOARD_PORT 环境变量覆盖。
const START = parseInt(process.env.DASHBOARD_PORT || "4820", 10);
const RANGE = 40;

/**
 * 探测指定主机和端口是否已被占用。
 *
 * 如果能在 timeoutMs 内建立 TCP 连接，说明端口 busy，返回 true。
 * 出现 error 或 timeout 则认为端口空闲，返回 false。
 */
function probeHost(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

/**
 * 判断端口是否被占用。
 *
 * 先探测 IPv4（127.0.0.1），再探测 IPv6（::1）。
 * 只要任一地址能连上，就认为端口不可用。
 */
async function busy(port) {
  if (await probeHost("127.0.0.1", port, 600)) return true;
  if (await probeHost("::1", port, 300)) return true;
  return false;
}

/**
 * 从 START 开始的连续 RANGE 个端口中挑选第一个空闲端口。
 * 如果全部占用则抛出错误。
 */
async function pickPort() {
  for (let candidatePort = START; candidatePort < START + RANGE; candidatePort++) {
    if (!(await busy(candidatePort))) return candidatePort;
  }
  throw new Error(`No free port found in ${START}-${START + RANGE - 1}`);
}

(async () => {
  let port;
  try {
    port = await pickPort();
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    process.exit(1);
  }
  if (port !== START) {
    console.log(`[dev] port ${START} is busy; using ${port} instead`);
  }
  console.log(`[dev] Claude Code Monitor dev server`);
  console.log(`[dev]   → server: http://localhost:${port}`);
  console.log(`[dev]   → client: http://localhost:5173`);

  // Windows 下 spawn 带空格命令需要额外加引号；macOS/Linux 不需要。
  const isWin = process.platform === "win32";
  const cmd = (script) => (isWin ? `"${script}"` : script);

  // 使用 concurrently 同时启动后端和前端；通过 DASHBOARD_PORT 把选中的端口传给服务端。
  const child = spawn(
    "npx",
    [
      "--no-install",
      "concurrently",
      "-n",
      "server,client",
      cmd("node --watch server/index.js"),
      cmd("cd client && npx vite"),
    ],
    {
      stdio: "inherit",
      shell: isWin,
      env: { ...process.env, NODE_ENV: "development", DASHBOARD_PORT: String(port) },
    }
  );

  // 信号转发：收到 SIGINT/SIGTERM 时先杀掉子进程，再由子进程 exit 事件让本进程退出。
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
  });
})();
