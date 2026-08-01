#!/usr/bin/env node

const net = require("node:net");
const { spawn } = require("node:child_process");

const START = parseInt(process.env.DASHBOARD_PORT || "4820", 10);
const RANGE = 40;

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

async function busy(port) {
  
  
  if (await probeHost("127.0.0.1", port, 600)) return true;
  if (await probeHost("::1", port, 300)) return true;
  return false;
}

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

  
  
  
  
  
  
  const isWin = process.platform === "win32";
  const cmd = (script) => (isWin ? `"${script}"` : script);
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

  
  
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
  });
})();
