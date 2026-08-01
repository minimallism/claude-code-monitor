#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function parseArgs(argv) {
  const args = {
    help: false,
    port: null,
    dataDir: null,
    dbPath: null,
    token: null,
    host: null,
    open: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-p":
      case "--port":
        args.port = argv[++i];
        break;
      case "-d":
      case "--data-dir":
        args.dataDir = argv[++i];
        break;
      case "--db-path":
        args.dbPath = argv[++i];
        break;
      case "-t":
      case "--token":
        args.token = argv[++i];
        break;
      case "--host":
        args.host = argv[++i];
        break;
      case "-o":
      case "--open":
        args.open = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        break;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage: npx claude-code-monitor [options]

Options:
  -p, --port <number>     Server port (default: 4820, env: DASHBOARD_PORT)
  -d, --data-dir <path>   Data directory (env: DASHBOARD_DATA_DIR)
      --db-path <path>    SQLite database path (env: DASHBOARD_DB_PATH)
  -t, --token <string>    Dashboard API token (env: DASHBOARD_TOKEN)
      --host <host>       Bind host (env: DASHBOARD_HOST)
  -o, --open              Open browser after startup
  -h, --help              Show this help

Examples:
  npx claude-code-monitor
  npx claude-code-monitor --port 8080 --open
  npx claude-code-monitor --data-dir ~/.my-dashboard-data
`);
}

function checkNodeVersion() {
  const major = process.versions.node.split(".")[0];
  if (Number(major) < 18) {
    console.error(`Node.js >= 18 is required. Current: ${process.versions.node}`);
    process.exit(1);
  }
  if (Number(major) < 22) {
    console.warn(
      `\n⚠️  Node.js ${process.versions.node} detected. ` +
        `For best compatibility without native modules, Node.js >= 22 is recommended.\n`
    );
  }
}

function ensureDistExists() {
  const distPath = path.join(__dirname, "..", "client", "dist", "index.html");
  if (!fs.existsSync(distPath)) {
    console.error(
      "\n" +
        "╔══════════════════════════════════════════════════════════════╗\n" +
        "║  Frontend build not found                                    ║\n" +
        "║                                                              ║\n" +
        "║  client/dist/index.html is missing.                          ║\n" +
        "║  Run `npm run build` from the project root, or install a     ║\n" +
        "║  published package that includes the prebuilt dist.          ║\n" +
        "╚══════════════════════════════════════════════════════════════╝\n"
    );
    process.exit(1);
  }
}

function buildEnv(args) {
  const env = { ...process.env, NODE_ENV: "production" };
  if (args.port) env.DASHBOARD_PORT = args.port;
  if (args.dataDir) env.DASHBOARD_DATA_DIR = args.dataDir;
  if (args.dbPath) env.DASHBOARD_DB_PATH = args.dbPath;
  if (args.token) env.DASHBOARD_TOKEN = args.token;
  if (args.host) env.DASHBOARD_HOST = args.host;
  return env;
}

function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // ignore
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  checkNodeVersion();
  ensureDistExists();

  const serverPath = path.join(__dirname, "..", "server", "index.js");
  const env = buildEnv(args);
  const port = env.DASHBOARD_PORT || "4820";

  const child = spawn(process.execPath, [serverPath], {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code || 0);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  if (args.open) {
    setTimeout(() => openBrowser(`http://localhost:${port}`), 1200);
  }
}

main();
