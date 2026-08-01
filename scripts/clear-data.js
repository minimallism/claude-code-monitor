#!/usr/bin/env node

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  try {
    Database = require("../server/compat-sqlite");
  } catch {
    console.error(
      "Error: No SQLite backend available. Upgrade to Node.js 22+ or install build tools."
    );
    process.exit(1);
  }
}
const fs = require("fs");
const path = require("path");
const { getDataDir } = require("../server/lib/claude-home");

const args = new Set(process.argv.slice(2));
const CONFIRMED = args.has("--yes") || args.has("-y");
const BACKUP = args.has("--backup");
const DRY_RUN = args.has("--dry-run") || !CONFIRMED;

const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(getDataDir(), "dashboard.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH} — nothing to clear.`);
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma("foreign_keys = OFF");

const counts = {
  token_usage: db.prepare("SELECT COUNT(*) as n FROM token_usage").get()?.n ?? 0,
  events: db.prepare("SELECT COUNT(*) as n FROM events").get()?.n ?? 0,
  agents: db.prepare("SELECT COUNT(*) as n FROM agents").get()?.n ?? 0,
  sessions: db.prepare("SELECT COUNT(*) as n FROM sessions").get()?.n ?? 0,
};

const totalRows = counts.sessions + counts.agents + counts.events + counts.token_usage;

console.log("");
console.log(`Target DB: ${DB_PATH}`);
console.log("Current row counts:");
console.log(`  Sessions: ${counts.sessions.toLocaleString()}`);
console.log(`  Agents:   ${counts.agents.toLocaleString()}`);
console.log(`  Events:   ${counts.events.toLocaleString()}`);
console.log(`  Tokens:   ${counts.token_usage.toLocaleString()}`);
console.log("");

if (DRY_RUN) {
  db.close();
  console.log("⚠️  DRY RUN — no data was deleted.");
  console.log("");
  console.log("This is a DESTRUCTIVE operation. To actually wipe the database,");
  console.log("re-run with --yes:");
  console.log("");
  console.log("  node scripts/clear-data.js --yes");
  console.log("");
  console.log("Strongly recommended: also pass --backup to snapshot the DB first:");
  console.log("");
  console.log("  node scripts/clear-data.js --yes --backup");
  console.log("");
  process.exit(0);
}

if (BACKUP) {
  const backupDir = path.join(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `dashboard.${stamp}.db`);
  
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`📦 Backup written: ${backupPath}`);
}

console.log(`⚠️  Wiping ${totalRows.toLocaleString()} rows…`);
db.exec("DELETE FROM token_usage; DELETE FROM events; DELETE FROM agents; DELETE FROM sessions;");
console.log("Database cleared.");

db.pragma("foreign_keys = ON");
db.close();

console.log("");
console.log(
  "Tip: run `npm run import-history` to restore sessions from ~/.claude/ JSONL transcripts."
);
