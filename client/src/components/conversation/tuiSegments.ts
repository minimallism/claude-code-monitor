/**
 * TUI 片段类型：把 Claude Code 的文本输出拆分成可渲染的语义片段。
 *
 * Claude Code 在终端中会输出类似 XML 的标签来标记本地命令输出、警告、系统提示等。
 * 前端需要把这些标签解析成结构化数据，以便用不同样式渲染（例如 stderr 用红色）。
 */
export type TuiSegment =
  | { kind: "caveat"; text: string }
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "system-reminder"; text: string }
  | { kind: "persisted-output"; text: string }
  | { kind: "command"; display: string }
  | { kind: "text"; text: string };

// 简单标签：开闭标签之间的内容直接作为对应类型的文本。
const SIMPLE_TAGS: Record<string, TuiSegment["kind"]> = {
  "local-command-caveat": "caveat",
  "local-command-stdout": "stdout",
  "local-command-stderr": "stderr",
  "system-reminder": "system-reminder",
  "persisted-output": "persisted-output",
};

// 命令块由多个子标签组成，需要合并成一条命令显示。
const COMMAND_TAGS = ["command-name", "command-message", "command-args"] as const;

// 预编译正则：判断是否包含任何已知标签，避免对所有文本都走完整解析。
const KNOWN_TAG_RE = new RegExp(
  `<(?:${[...Object.keys(SIMPLE_TAGS), ...COMMAND_TAGS].join("|")})\\b`
);

// 简单的 ANSI 转义序列正则，用于清理颜色代码。
const ANSI_RE = /\[[\d;]*m|\[\d+(?:;\d+)*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

interface MatchSpan {
  start: number;
  end: number;
  segment: TuiSegment;
}

/**
 * 查找所有简单标签（如 <local-command-stdout>...</local-command-stdout>）的匹配位置。
 * 返回每个匹配在原文中的起止位置和对应的 segment。
 */
function findSimpleTagMatches(input: string): MatchSpan[] {
  const matches: MatchSpan[] = [];
  for (const [tag, kind] of Object.entries(SIMPLE_TAGS)) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        segment: { kind, text: match[1] ?? "" } as TuiSegment,
      });
    }
  }
  return matches;
}

/**
 * 查找命令块：由 1~3 个 command-name/message/args 标签连续组成。
 * 把它们合并成一条命令片段，便于 UI 折叠或高亮显示。
 */
function findCommandBlocks(input: string): MatchSpan[] {
  const re = /(?:<command-(?:name|message|args)>[^<]*<\/command-(?:name|message|args)>\s*){1,3}/g;
  const out: MatchSpan[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const block = match[0];
    const name = /<command-name>([^<]*)<\/command-name>/.exec(block)?.[1] ?? "";
    const args = /<command-args>([^<]*)<\/command-args>/.exec(block)?.[1] ?? "";
    if (!name) continue;
    const trimmedArgs = args.trim();
    out.push({
      start: match.index,
      end: match.index + block.length,
      segment: {
        kind: "command",
        display: trimmedArgs ? `${name} ${trimmedArgs}` : name,
      },
    });
  }
  return out;
}

/**
 * 把原始文本解析成 TuiSegment 数组。
 *
 * 算法：
 * 1. 先快速判断是否有已知标签，没有则整条作为 text 返回。
 * 2. 收集所有简单标签和命令块的匹配，按 start 排序。
 * 3. 用 cursor 遍历排序后的匹配，把匹配之间的普通文本也作为 text 片段插入。
 * 4. 重叠匹配自动跳过（取排序后先出现的），保证输出片段不重叠。
 */
export function parseTuiSegments(input: string): TuiSegment[] {
  if (!KNOWN_TAG_RE.test(input)) {
    return [{ kind: "text", text: input }];
  }

  const matches = [...findSimpleTagMatches(input), ...findCommandBlocks(input)].sort(
    (a, b) => a.start - b.start
  );

  const segments: TuiSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) {
      const between = input.slice(cursor, match.start);
      if (between.trim()) {
        segments.push({ kind: "text", text: between });
      }
    }
    segments.push(match.segment);
    cursor = match.end;
  }
  if (cursor < input.length) {
    const tail = input.slice(cursor);
    if (tail.trim()) segments.push({ kind: "text", text: tail });
  }

  return segments.length > 0 ? segments : [{ kind: "text", text: input }];
}

export function hasTuiTags(input: string): boolean {
  return KNOWN_TAG_RE.test(input);
}
