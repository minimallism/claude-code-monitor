export type TuiSegment =
  | { kind: "caveat"; text: string }
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "system-reminder"; text: string }
  | { kind: "persisted-output"; text: string }
  | { kind: "command"; display: string }
  | { kind: "text"; text: string };

const SIMPLE_TAGS: Record<string, TuiSegment["kind"]> = {
  "local-command-caveat": "caveat",
  "local-command-stdout": "stdout",
  "local-command-stderr": "stderr",
  "system-reminder": "system-reminder",
  "persisted-output": "persisted-output",
};

const COMMAND_TAGS = ["command-name", "command-message", "command-args"] as const;

const KNOWN_TAG_RE = new RegExp(
  `<(?:${[...Object.keys(SIMPLE_TAGS), ...COMMAND_TAGS].join("|")})\\b`
);

const ANSI_RE = /\[[\d;]*m|\[\d+(?:;\d+)*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

interface MatchSpan {
  start: number;
  end: number;
  segment: TuiSegment;
}

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
