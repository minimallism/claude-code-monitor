#!/usr/bin/env node

/**
 * 清空 dashboard 数据库的脚本。
 *
 * 用法：
 *   node scripts/clear-data.js           # 干跑，显示将要删除的数据量
 *   node scripts/clear-data.js --yes     # 真正清空
 *   node scripts/clear-data.js --yes --backup  # 清空前先备份
 *
 * 安全设计：
 * - 默认是 DRY RUN，必须显式传入 --yes 才会删除数据。
 * - 支持 --backup 在删除前用 VACUUM INTO 创建时间戳备份。
 * - 优先使用 better-sqlite3；未安装时回退到 compat-sqlite（Node 22+ 内置 node:sqlite）。
 */

let Database;
try {
  // 优先使用原生 better-sqlite3，性能和事务支持更好。
  Database = require("better-sqlite3");
} catch {
  try {
    // Node.js 22+ 内置 node:sqlite，通过 compat-sqlite 提供统一 API。
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
// 未确认时强制进入干跑模式，防止误删。
const DRY_RUN = args.has("--dry-run") || !CONFIRMED;

const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(getDataDir(), "dashboard.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH} — nothing to clear.`);
  process.exit(0);
}

const db = new Database(DB_PATH);
// 清空前先关闭外键检查，避免 DELETE 顺序导致外键约束错误。
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
  // 用 ISO 时间戳生成唯一文件名，并把 : 和 . 替换为 - 避免文件名非法字符。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `dashboard.${stamp}.db`);

  // VACUUM INTO 会生成一个完整、紧凑的数据库副本。
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`📦 Backup written: ${backupPath}`);
}

console.log(`⚠️  Wiping ${totalRows.toLocaleString()} rows…`);
// 按依赖关系逆序清空表；外键已关闭，顺序不影响正确性。
db.exec("DELETE FROM token_usage; DELETE FROM events; DELETE FROM agents; DELETE FROM sessions;");
console.log("Database cleared.");

// 清理完成后恢复外键约束检查。
db.pragma("foreign_keys = ON");
db.close();

console.log("");
console.log(
  "Tip: run `npm run import-history` to restore sessions from ~/.claude/ JSONL transcripts."
);
