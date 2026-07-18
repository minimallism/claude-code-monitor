#!/usr/bin/env node

const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");

const START = parseInt(process.env.DASHBOARD_PORT || "4820", 10);
const RANGE = 40;

function healthyDashboardOn(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 600 }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf)?.status === "ok");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

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
  for (let p = START; p < START + RANGE; p++) {
    if (!(await busy(p))) return p;
  }
  throw new Error(`No free port found in ${START}-${START + RANGE - 1}`);
}

(async () => {
  let port;
  try {
    port = await pickPort();
  } catch (err) {
    console.error(`[dev] ${err.message}`);
    process.exit(1);
  }
  if (port !== START) {
    console.log(
      `[dev] port ${START} is busy (something is on the loopback already — likely an SSH LocalForward); using ${port} instead`
    );
    
    
    
    
    if (await healthyDashboardOn(START)) {
      console.log(
        `[dev] ⚠ another dashboard is already running on :${START} and shares this database. ` +
          `Live hook events will be counted by BOTH — stop the other dashboard for accurate dev data.`
      );
    }
  } else {
    console.log(`[dev] dashboard server will listen on :${port}`);
  }

  
  
  
  
  
  
  const isWin = process.platform === "win32";
  const cmd = (s) => (isWin ? `"${s}"` : s);
  const child = spawn(
    "npx",
    [
      "--no-install",
      "concurrently",
      "-n",
      "server,client",
      "-c",
      "blue,green",
      cmd("npm run dev:server"),
      cmd("npm run dev:client"),
    ],
    {
      stdio: "inherit",
      shell: isWin,
      env: { ...process.env, NODE_ENV: "development", DASHBOARD_PORT: String(port) },
    }
  );

  
  
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => child.kill(sig));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
  });
})();
