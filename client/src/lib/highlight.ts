/**
 * 语法高亮 Token 类型。
 *
 * 这些类型没有绑定具体颜色；颜色由 tokenClass() 映射到 Tailwind 类名。
 * 这样可以保持语法分析层与样式层解耦。
 */
export type TokenType =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "builtin"
  | "function"
  | "operator"
  | "punctuation"
  | "property"
  | "tag"
  | "attr"
  | "variable"
  | "boolean"
  | "diff-add"
  | "diff-del"
  | "diff-meta";

export interface Token {
  type: TokenType;
  text: string;
}

// 高亮规则：正则必须带 sticky 标志 y，这样可以从指定位置开始匹配。
interface Rule {
  type: TokenType;
  pattern: RegExp;
}

const JS_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "class",
  "extends",
  "super",
  "this",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "void",
  "yield",
  "async",
  "await",
  "import",
  "export",
  "from",
  "as",
  "try",
  "catch",
  "finally",
  "throw",
  "static",
  "public",
  "private",
  "protected",
  "readonly",
  "interface",
  "type",
  "enum",
  "implements",
  "namespace",
  "declare",
  "abstract",
  "override",
]);

const JS_BUILTINS = new Set([
  "console",
  "window",
  "document",
  "globalThis",
  "process",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "Promise",
  "Symbol",
  "Error",
  "Buffer",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
]);

const JS_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const PY_KEYWORDS = new Set([
  "def",
  "class",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "break",
  "continue",
  "return",
  "yield",
  "import",
  "from",
  "as",
  "pass",
  "raise",
  "try",
  "except",
  "finally",
  "with",
  "lambda",
  "global",
  "nonlocal",
  "in",
  "is",
  "not",
  "and",
  "or",
  "async",
  "await",
  "self",
  "cls",
]);

const PY_BUILTINS = new Set([
  "print",
  "len",
  "range",
  "str",
  "int",
  "float",
  "list",
  "dict",
  "set",
  "tuple",
  "bool",
  "isinstance",
  "type",
  "open",
  "input",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sorted",
  "reversed",
  "abs",
  "min",
  "max",
  "sum",
  "any",
  "all",
  "Exception",
]);

const PY_LITERALS = new Set(["True", "False", "None"]);

const SH_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "function",
  "return",
  "exit",
  "export",
  "local",
  "readonly",
  "declare",
  "set",
  "unset",
  "source",
]);

const SH_BUILTINS = new Set([
  "echo",
  "cd",
  "ls",
  "cat",
  "grep",
  "sed",
  "awk",
  "find",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "kill",
  "ps",
  "git",
  "npm",
  "node",
  "python",
  "python3",
  "pip",
  "curl",
  "wget",
  "ssh",
  "scp",
  "tar",
  "zip",
  "unzip",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "xargs",
  "tee",
]);

/**
 * 通用 tokenizer：按规则顺序匹配，未匹配字符合并为 plain token。
 *
 * 使用 sticky 正则保证只从当前 position 开始匹配，避免回溯；
 * 规则顺序很重要，例如字符串应该在关键字之前匹配。
 */
function tokenizeWith(source: string, rules: Rule[]): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    let matched = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = position;
      const match = rule.pattern.exec(source);
      if (match && match.index === position) {
        tokens.push({ type: rule.type, text: match[0] });
        position += match[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // 未匹配字符合并到上一个 plain token，减少 token 数量。
      const char = source[position]!;
      const last = tokens[tokens.length - 1];
      if (last && last.type === "plain") last.text += char;
      else tokens.push({ type: "plain", text: char });
      position += 1;
    }
  }
  return tokens;
}

function tokenizeJS(source: string): Token[] {
  const rules: Rule[] = [
    { type: "comment", pattern: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
    { type: "string", pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y },
    {
      type: "number",
      pattern: /\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y,
    },
    { type: "function", pattern: /\b[a-zA-Z_$][\w$]*(?=\s*\()/y },
    { type: "keyword", pattern: /\b[a-zA-Z_$][\w$]*\b/y },
    { type: "operator", pattern: /=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\.\.\.|[+\-*/%=<>!&|^~?:]/y },
    { type: "punctuation", pattern: /[{}[\]();,.]/y },
  ];

  // 先用规则粗分，再把标识符细分为 keyword/builtin/literal/plain。
  return refineIdentifiers(tokenizeWith(source, rules), JS_KEYWORDS, JS_BUILTINS, JS_LITERALS);
}

function tokenizePython(source: string): Token[] {
  const rules: Rule[] = [
    { type: "comment", pattern: /#[^\n]*/y },
    {
      type: "string",
      pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y,
    },
    { type: "number", pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: "function", pattern: /\b[a-zA-Z_][\w]*(?=\s*\()/y },
    { type: "keyword", pattern: /\b[a-zA-Z_][\w]*\b/y },
    { type: "operator", pattern: /\*\*|\/\/|<<|>>|<=|>=|==|!=|->|[+\-*/%=<>!&|^~]/y },
    { type: "punctuation", pattern: /[{}[\]():,.]/y },
  ];
  return refineIdentifiers(tokenizeWith(source, rules), PY_KEYWORDS, PY_BUILTINS, PY_LITERALS);
}

function tokenizeJSON(source: string): Token[] {
  const rules: Rule[] = [
    { type: "string", pattern: /"(?:\\.|[^"\\])*"(?=\s*:)/y }, // 优先匹配对象 key
    { type: "string", pattern: /"(?:\\.|[^"\\])*"/y }, // 普通字符串
    { type: "number", pattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: "boolean", pattern: /\b(?:true|false|null)\b/y },
    { type: "punctuation", pattern: /[{}[\],:]/y },
  ];

  const tokens = tokenizeWith(source, rules);
  // 第二轮：如果 string token 后面紧跟冒号，则把它标记为 property（对象 key）。
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type === "string") {
      for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j]!;
        if (token.type === "plain" && /^\s*$/.test(token.text)) continue;
        if (token.type === "punctuation" && token.text === ":") {
          tokens[i]!.type = "property";
        }
        break;
      }
    }
  }
  return tokens;
}

function tokenizeShell(source: string): Token[] {
  const rules: Rule[] = [
    { type: "comment", pattern: /#[^\n]*/y },
    { type: "string", pattern: /"(?:\\.|[^"\\])*"|'[^']*'/y },
    { type: "variable", pattern: /\$\{[^}]+\}|\$\w+|\$[#?@*$]/y },
    { type: "number", pattern: /\b\d+\b/y },
    { type: "function", pattern: /\b[a-zA-Z_][\w-]*(?=\s)/y },
    { type: "keyword", pattern: /\b[a-zA-Z_][\w-]*\b/y },
    { type: "operator", pattern: /&&|\|\||>>|<<|[|&;<>=!]/y },
    { type: "punctuation", pattern: /[(){}[\];]/y },
  ];
  const tokens = tokenizeWith(source, rules);
  
  for (const token of tokens) {
    if (token.type === "keyword" || token.type === "function") {
      if (SH_KEYWORDS.has(token.text)) token.type = "keyword";
      else if (SH_BUILTINS.has(token.text)) token.type = "builtin";
      else if (token.type === "keyword") token.type = "plain";
    }
  }
  return tokens;
}

function tokenizeHTML(source: string): Token[] {
  const tokens: Token[] = [];
  const re =
    /(<!--[\s\S]*?-->)|(<\/?)([a-zA-Z][\w-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?>)|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) != null) {
    if (match[1]) tokens.push({ type: "comment", text: match[1] });
    else if (match[2]) {
      tokens.push({ type: "punctuation", text: match[2] });
      tokens.push({ type: "tag", text: match[3]! });
      if (match[4]) tokens.push(...tokenizeHTMLAttrs(match[4]));
      tokens.push({ type: "punctuation", text: match[5]! });
    } else if (match[6]) tokens.push({ type: "plain", text: match[6] });
  }
  return tokens;
}

function tokenizeHTMLAttrs(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\s+)([a-zA-Z_:][\w:.-]*)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s>]+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) != null) {
    tokens.push({ type: "plain", text: match[1]! });
    tokens.push({ type: "attr", text: match[2]! });
    if (match[3]) tokens.push({ type: "operator", text: match[3] });
    if (match[4]) tokens.push({ type: "string", text: match[4] });
  }
  return tokens;
}

function tokenizeCSS(source: string): Token[] {
  const rules: Rule[] = [
    { type: "comment", pattern: /\/\*[\s\S]*?\*\//y },
    { type: "string", pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
    { type: "number", pattern: /-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/y },
    { type: "property", pattern: /[a-zA-Z-]+(?=\s*:)/y },
    { type: "tag", pattern: /[.#]?[a-zA-Z_][\w-]*/y },
    { type: "punctuation", pattern: /[{}();:,]/y },
  ];
  return tokenizeWith(source, rules);
}

function tokenizeSQL(source: string): Token[] {
  const sqlKeywords = new Set([
    "select",
    "from",
    "where",
    "and",
    "or",
    "not",
    "in",
    "is",
    "null",
    "as",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "on",
    "group",
    "by",
    "order",
    "having",
    "limit",
    "offset",
    "insert",
    "into",
    "values",
    "update",
    "set",
    "delete",
    "create",
    "table",
    "drop",
    "alter",
    "add",
    "primary",
    "key",
    "foreign",
    "references",
    "index",
    "unique",
    "with",
    "case",
    "when",
    "then",
    "else",
    "end",
    "distinct",
    "union",
    "all",
    "exists",
    "between",
    "like",
  ]);
  const rules: Rule[] = [
    { type: "comment", pattern: /--[^\n]*|\/\*[\s\S]*?\*\//y },
    { type: "string", pattern: /'(?:''|[^'])*'/y },
    { type: "number", pattern: /\b\d+(?:\.\d+)?\b/y },
    { type: "keyword", pattern: /\b[a-zA-Z_][\w]*\b/y },
    { type: "operator", pattern: /<>|<=|>=|!=|[=<>+\-*/]/y },
    { type: "punctuation", pattern: /[(),;.]/y },
  ];
  const tokens = tokenizeWith(source, rules);
  for (const token of tokens) {
    if (token.type === "keyword") {
      if (!sqlKeywords.has(token.text.toLowerCase())) token.type = "plain";
    }
  }
  return tokens;
}

function tokenizeYAML(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) tokens.push({ type: "plain", text: "\n" });
    if (line.trim().startsWith("#")) {
      tokens.push({ type: "comment", text: line });
      continue;
    }
    const match = line.match(/^(\s*-?\s*)([a-zA-Z_][\w-]*)(\s*:)(.*)$/);
    if (match) {
      tokens.push({ type: "plain", text: match[1]! });
      tokens.push({ type: "property", text: match[2]! });
      tokens.push({ type: "punctuation", text: match[3]! });
      const rest = match[4]!;
      if (/^\s*("[^"]*"|'[^']*')\s*$/.test(rest)) {
        tokens.push({ type: "string", text: rest });
      } else if (/^\s*-?\d+(\.\d+)?\s*$/.test(rest)) {
        tokens.push({ type: "number", text: rest });
      } else if (/^\s*(true|false|null|~)\s*$/.test(rest)) {
        tokens.push({ type: "boolean", text: rest });
      } else {
        tokens.push({ type: "plain", text: rest });
      }
    } else {
      tokens.push({ type: "plain", text: line });
    }
  }
  return tokens;
}

function tokenizeDiff(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) tokens.push({ type: "plain", text: "\n" });
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("diff ")
    ) {
      tokens.push({ type: "diff-meta", text: line });
    } else if (line.startsWith("+")) {
      tokens.push({ type: "diff-add", text: line });
    } else if (line.startsWith("-")) {
      tokens.push({ type: "diff-del", text: line });
    } else {
      tokens.push({ type: "plain", text: line });
    }
  }
  return tokens;
}

/**
 * 把粗分阶段标记为 keyword 的标识符进一步细分。
 *
 * 实际关键词 -> keyword；内置对象/函数 -> builtin；字面量 -> boolean；
 * 其他普通标识符 -> plain。
 */
function refineIdentifiers(
  tokens: Token[],
  keywords: Set<string>,
  builtins: Set<string>,
  literals: Set<string>
): Token[] {
  for (const token of tokens) {
    if (token.type === "keyword") {
      if (keywords.has(token.text)) token.type = "keyword";
      else if (builtins.has(token.text)) token.type = "builtin";
      else if (literals.has(token.text)) token.type = "boolean";
      else token.type = "plain";
    }
  }
  return tokens;
}

/**
 * 把各种语言别名统一成内部语言标识。
 *
 * 例如 js/javascript/mjs/cjs 都映射为 "js"，
 * 这样 canonicalLang 之后用 switch 分发即可。
 */
export function canonicalLang(lang: string): string {
  const normalizedLang = lang.toLowerCase().trim();
  if (normalizedLang === "js" || normalizedLang === "jsx" || normalizedLang === "javascript" || normalizedLang === "mjs" || normalizedLang === "cjs") return "js";
  if (normalizedLang === "ts" || normalizedLang === "tsx" || normalizedLang === "typescript") return "ts";
  if (normalizedLang === "py" || normalizedLang === "python") return "python";
  if (normalizedLang === "json" || normalizedLang === "jsonc") return "json";
  if (normalizedLang === "sh" || normalizedLang === "bash" || normalizedLang === "zsh" || normalizedLang === "shell" || normalizedLang === "console") return "bash";
  if (normalizedLang === "html" || normalizedLang === "xml" || normalizedLang === "svg") return "html";
  if (normalizedLang === "css" || normalizedLang === "scss" || normalizedLang === "less") return "css";
  if (normalizedLang === "sql") return "sql";
  if (normalizedLang === "yaml" || normalizedLang === "yml") return "yaml";
  if (normalizedLang === "diff" || normalizedLang === "patch") return "diff";
  return normalizedLang || "plain";
}

/**
 * 对源代码进行语法高亮，返回 Token 数组。
 *
 * 不支持的语言直接返回一个 plain token，保证调用方不需要特殊处理。
 */
export function highlight(source: string, lang: string): Token[] {
  const canon = canonicalLang(lang);
  switch (canon) {
    case "js":
    case "ts":
      return tokenizeJS(source);
    case "python":
      return tokenizePython(source);
    case "json":
      return tokenizeJSON(source);
    case "bash":
      return tokenizeShell(source);
    case "html":
      return tokenizeHTML(source);
    case "css":
      return tokenizeCSS(source);
    case "sql":
      return tokenizeSQL(source);
    case "yaml":
      return tokenizeYAML(source);
    case "diff":
      return tokenizeDiff(source);
    default:
      return [{ type: "plain", text: source }];
  }
}

/**
 * 把 TokenType 映射为 Tailwind 颜色类名。
 * 调用方负责把文本拆分成 <span className={tokenClass(type)}>{text}</span>。
 */
export function tokenClass(type: TokenType): string {
  switch (type) {
    case "comment":
      return "text-slate-500 italic";
    case "string":
      return "text-status-working/90";
    case "number":
      return "text-orange-300";
    case "keyword":
      return "text-accent-hover";
    case "builtin":
      return "text-sky-300";
    case "function":
      return "text-yellow-200";
    case "operator":
      return "text-pink-300";
    case "punctuation":
      return "text-slate-400";
    case "property":
      return "text-cyan-300";
    case "tag":
      return "text-rose-300";
    case "attr":
      return "text-yellow-200";
    case "variable":
      return "text-status-waiting/90";
    case "boolean":
      return "text-orange-300";
    case "diff-add":
      return "text-status-working/90 bg-status-working/10";
    case "diff-del":
      return "text-status-error/90 bg-status-error/10";
    case "diff-meta":
      return "text-accent-hover";
    case "plain":
    default:
      return "text-slate-200";
  }
}


