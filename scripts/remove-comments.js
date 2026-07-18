const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "client", "src");

function findFiles(dir, extPattern) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      results.push(...findFiles(full, extPattern));
    } else if (entry.isFile() && extPattern.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function couldStartRegex(code, i) {
  let j = i - 1;
  while (j >= 0 && (code[j] === " " || code[j] === "\t" || code[j] === "\n" || code[j] === "\r")) j--;
  if (j < 0) return true;
  const c = code[j];
  if (c === "<") return false; 
  if ("=([{,!&|^~%?:;".includes(c)) return true;
  if (")]}".includes(c)) return false;
  if (/[a-zA-Z0-9_$]/.test(c)) return false;
  if (c === "'" || c === '"' || c === "`") return false;
  if (c === "-" || c === "+") {
    let k = j - 1;
    while (k >= 0 && (code[k] === " " || code[k] === "\t" || code[k] === "\n" || code[k] === "\r")) k--;
    if (k < 0) return true;
    if ("=([{,!&|^~%?:;<".includes(code[k])) return true;
    return false;
  }
  return true;
}

function parseRegex(code, i) {
  let j = i + 1;
  let inClass = false;
  while (j < code.length) {
    if (code[j] === "\\") { j += 2; continue; }
    if (code[j] === "[" && !inClass) { inClass = true; j++; continue; }
    if (code[j] === "]" && inClass) { inClass = false; j++; continue; }
    if (!inClass && code[j] === "/") break;
    j++;
  }
  if (j < code.length) { j++; while (j < code.length && /[gimsuyd]/.test(code[j])) j++; }
  return j;
}

function isApostrophe(code, i) {
  
  
  if (i <= 0 || i + 1 >= code.length) return false;
  return /[a-zA-Z]/.test(code[i - 1]) && /[a-zA-Z]/.test(code[i + 1]);
}

function removeComments(code) {
  const out = [];
  const len = code.length;
  let i = 0;

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : "";

    
    if (ch === "'" && !isApostrophe(code, i)) {
      out.push(ch); i++;
      while (i < len) {
        if (code[i] === "\\") { out.push(code[i], code[i + 1]); i += 2; }
        else if (code[i] === "'") { out.push(code[i]); i++; break; }
        else { out.push(code[i]); i++; }
      }
      continue;
    }

    
    if (ch === '"') {
      out.push(ch); i++;
      while (i < len) {
        if (code[i] === "\\") { out.push(code[i], code[i + 1]); i += 2; }
        else if (code[i] === '"') { out.push(code[i]); i++; break; }
        else { out.push(code[i]); i++; }
      }
      continue;
    }

    
    if (ch === "/" && next === "/") {
      while (i < len && code[i] !== "\n") i++;
      if (i < len && code[i] === "\n") { out.push("\n"); i++; }
      continue;
    }

    
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len) {
        if (code[i] === "*" && i + 1 < len && code[i + 1] === "/") {
          i += 2; break;
        }
        if (code[i] === "\n") out.push("\n");
        i++;
      }
      continue;
    }

    
    if (ch === "/" && couldStartRegex(code, i)) {
      const end = parseRegex(code, i);
      out.push(code.slice(i, end));
      i = end;
      continue;
    }

    
    if (ch === "`") {
      out.push(ch); i++;
      let braceDepth = 0;
      while (i < len) {
        if (code[i] === "\\") { out.push(code[i], code[i + 1]); i += 2; }
        else if (code[i] === "$" && i + 1 < len && code[i + 1] === "{") {
          out.push("${"); i += 2; braceDepth++;
        }
        else if (code[i] === "}" && braceDepth > 0) {
          out.push("}"); i++; braceDepth--;
        }
        else if (code[i] === "`" && braceDepth === 0) { out.push("`"); i++; break; }
        
        else if (code[i] === "/" && i + 1 < len && code[i + 1] === "*" && braceDepth === 0) {
          i += 2;
          while (i < len) {
            if (code[i] === "*" && i + 1 < len && code[i + 1] === "/") {
              i += 2; break;
            }
            if (code[i] === "\n") out.push("\n");
            else if (code[i] === "\r") out.push("\r");
            i++;
          }
        }
        else { out.push(code[i]); i++; }
      }
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

function cleanFile(filePath) {
  const original = fs.readFileSync(filePath, "utf8");
  let cleaned = removeComments(original);
  if (original !== cleaned) {
    
    cleaned = cleaned.replace(/^[ \t]*\{\}[ \t]*\n/gm, "");
    
    cleaned = cleaned.replace(/^[ \t]*\{\}[ \t]*\r?\n/gm, "");
    if (original !== cleaned) {
      fs.writeFileSync(filePath, cleaned, "utf8");
      return true;
    }
    fs.writeFileSync(filePath, cleaned, "utf8");
    return true;
  }
  return false;
}

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
const extPattern = process.argv[3] ? new RegExp(process.argv[3], "i") : /\.(ts|tsx|css)$/i;

if (!fs.existsSync(targetDir)) {
  console.error(`Directory not found: ${targetDir}`);
  process.exit(1);
}

const files = findFiles(targetDir, extPattern);
console.log(`Scanning ${targetDir}`);
console.log(`Found ${files.length} source files`);

let changed = 0;
for (const f of files) {
  if (cleanFile(f)) {
    changed++;
  }
}
console.log(`\nDone. ${changed} files modified.`);
