const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const crypto = require("crypto");

const MAX_EXTRACT_BYTES = parseInt(
  process.env.CCAM_IMPORT_MAX_EXTRACT_BYTES || String(4 * 1024 * 1024 * 1024),
  10
);

class ExtractionLimitError extends Error {
  constructor(limit) {
    super(`Archive exceeded the ${limit}-byte extraction limit (possible zip bomb).`);
    this.code = "EXTRACTION_LIMIT_EXCEEDED";
  }
}

function isPathInside(parent, child) {
  const p = path.resolve(parent) + path.sep;
  const c = path.resolve(child);
  return c === path.resolve(parent) || c.startsWith(p);
}

function safeJoin(root, entryName) {
  const cleaned = String(entryName).replace(/^[/\\]+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  const joined = path.join(root, cleaned);
  if (!isPathInside(root, joined)) return null;
  return joined;
}

function mkTempDir(prefix = "ccam-import-") {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmTempDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    
  }
}

async function extractZip(zipPath, destDir) {
  let AdmZip;
  try {
    AdmZip = require("adm-zip");
  } catch (err) {
    throw new Error(
      "adm-zip is required to extract .zip archives. Run `npm install` to pick up new deps."
    );
  }
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  
  
  let declared = 0;
  for (const entry of entries) {
    if (!entry.isDirectory) declared += entry.header?.size || 0;
  }
  if (declared > MAX_EXTRACT_BYTES) throw new ExtractionLimitError(MAX_EXTRACT_BYTES);

  let extracted = 0;
  let skipped = 0;
  let writtenBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const target = safeJoin(destDir, entry.entryName);
    if (!target) {
      skipped++;
      continue;
    }
    const data = entry.getData();
    writtenBytes += data.length;
    if (writtenBytes > MAX_EXTRACT_BYTES) throw new ExtractionLimitError(MAX_EXTRACT_BYTES);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, data);
      extracted++;
    } catch {
      skipped++;
    }
  }
  return { extracted, skipped };
}

async function extractTar(tarPath, destDir) {
  let tar;
  try {
    tar = require("tar");
  } catch {
    throw new Error(
      "tar is required to extract .tar/.tar.gz archives. Run `npm install` to pick up new deps."
    );
  }
  let extracted = 0;
  let skipped = 0;
  let writtenBytes = 0;

  await tar.x({
    file: tarPath,
    cwd: destDir,
    strict: false,
    preservePaths: false,
    filter: (entryPath, entry) => {
      if (entry.type && entry.type !== "File" && entry.type !== "Directory") {
        skipped++;
        return false;
      }
      const target = safeJoin(destDir, entryPath);
      if (!target) {
        skipped++;
        return false;
      }
      if (entry.type === "File") {
        writtenBytes += entry.size || 0;
        if (writtenBytes > MAX_EXTRACT_BYTES) {
          
          
          throw new ExtractionLimitError(MAX_EXTRACT_BYTES);
        }
        extracted++;
      }
      return true;
    },
  });

  return { extracted, skipped };
}

async function extractGzSingle(gzPath, destDir) {
  const base = path.basename(gzPath).replace(/\.gz$/i, "") || "decompressed.jsonl";
  const target = safeJoin(destDir, base);
  if (!target) return { extracted: 0, skipped: 1 };
  fs.mkdirSync(path.dirname(target), { recursive: true });

  
  
  let written = 0;
  const { Transform } = require("stream");
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (written > MAX_EXTRACT_BYTES) {
        cb(new ExtractionLimitError(MAX_EXTRACT_BYTES));
        return;
      }
      cb(null, chunk);
    },
  });

  await pipeline(
    fs.createReadStream(gzPath),
    zlib.createGunzip(),
    limiter,
    fs.createWriteStream(target)
  );
  return { extracted: 1, skipped: 0 };
}

function detectKind(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tgz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".meta.json")) return "meta";
  if (lower.endsWith(".jsonl")) return "jsonl";
  if (lower.endsWith(".gz")) return "gz";
  return "unknown";
}

async function extractInto(srcPath, destDir, originalName) {
  const name = originalName || path.basename(srcPath);
  const kind = detectKind(name);
  switch (kind) {
    case "zip":
      return extractZip(srcPath, destDir);
    case "tar":
    case "tgz":
      return extractTar(srcPath, destDir);
    case "gz":
      return extractGzSingle(srcPath, destDir);
    case "jsonl":
    case "meta": {
      const target = safeJoin(destDir, name);
      if (!target) return { extracted: 0, skipped: 1 };
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(srcPath, target);
      return { extracted: 1, skipped: 0 };
    }
    default:
      return { extracted: 0, skipped: 1 };
  }
}

module.exports = {
  mkTempDir,
  rmTempDir,
  extractInto,
  extractZip,
  extractTar,
  extractGzSingle,
  detectKind,
  safeJoin,
  isPathInside,
  ExtractionLimitError,
  MAX_EXTRACT_BYTES,
};
