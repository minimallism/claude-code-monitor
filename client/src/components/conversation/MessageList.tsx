import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Bot,
  User,
  Brain,
  ScrollText,
  Terminal,
  Info,
  AlertTriangle,
  Pencil,
  Workflow,
  Settings,
} from "lucide-react";
import type { TranscriptMessage, TranscriptContent, TranscriptSender } from "../../lib/types";

const SENDER_STYLES: Record<
  TranscriptSender,
  { label: string; icon: typeof User; avatarRing: string; accentBar: string; headerText: string }
> = {
  user: {
    label: "User",
    icon: User,
    avatarRing:
      "bg-gradient-to-br from-accent/30 to-accent/20 text-accent-hover ring-1 ring-accent/30",
    accentBar: "before:bg-accent/40",
    headerText: "text-accent-hover",
  },
  assistant: {
    label: "Assistant",
    icon: Bot,
    avatarRing:
      "bg-gradient-to-br from-accent/30 to-accent/20 text-accent-hover ring-1 ring-accent/30",
    accentBar: "before:bg-accent/40",
    headerText: "text-accent-hover",
  },
  orchestrator: {
    label: "Main agent",
    icon: Workflow,
    avatarRing:
      "bg-gradient-to-br from-status-working/30 to-status-working/20 text-status-working ring-1 ring-status-working/30",
    accentBar: "before:bg-status-working/40",
    headerText: "text-status-working",
  },
  system: {
    label: "System",
    icon: Settings,
    avatarRing:
      "bg-gradient-to-br from-slate-500/30 to-slate-500/20 text-slate-300 ring-1 ring-slate-400/30",
    accentBar: "before:bg-slate-500/40",
    headerText: "text-slate-300",
  },
  tool: {
    label: "Tool",
    icon: Terminal,
    avatarRing:
      "bg-gradient-to-br from-status-waiting/30 to-status-waiting/20 text-status-waiting/80 ring-1 ring-status-waiting/30",
    accentBar: "before:bg-status-waiting/40",
    headerText: "text-status-waiting/80",
  },
};
import { ToolCallBlock } from "./ToolCallBlock";
import { MarkdownContent } from "./MarkdownContent";
import { fmt, formatModelName } from "../../lib/format";
import { parseTuiSegments, stripAnsi, hasTuiTags, type TuiSegment } from "./tuiSegments";

interface MessageListProps {
  messages: TranscriptMessage[];
  loading: boolean;
}

function buildToolResultMap(messages: TranscriptMessage[]): Map<string, TranscriptContent> {
  const map = new Map<string, TranscriptContent>();
  for (const msg of messages) {
    if (msg.type !== "user") continue;
    for (const c of msg.content) {
      if (c.type === "tool_result" && c.id) {
        map.set(c.id, c);
      }
    }
  }
  return map;
}

function isSkillContent(text: string): boolean {
  return text.startsWith("Base directory for this skill:");
}

function isTaskNotification(text: string): boolean {
  return text.includes("<task-notification>") || text.includes("<task-id>");
}

function formatLocalTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return "";
  }
}

function SessionEventRow({ title, timestamp }: { title?: string; timestamp: string | null }) {
  return (
    <div className="flex items-center justify-center py-1">
      <div className="inline-flex items-center gap-2 text-[11px] text-slate-400 bg-surface-2/70 border border-surface-3 rounded-full px-3 py-1 max-w-full">
        <Pencil className="w-3 h-3 text-accent-hover/70 flex-shrink-0" />
        <span className="text-slate-500">Renamed session →</span>
        <span className="text-slate-200 font-medium truncate">{title || "(untitled)"}</span>
        {timestamp && (
          <span className="text-[10px] text-slate-600 font-mono flex-shrink-0">
            {formatLocalTime(timestamp)}
          </span>
        )}
      </div>
    </div>
  );
}

function CommandPill({ display }: { display: string }) {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-status-working/90 font-mono bg-status-working/10 border border-status-working/20 rounded-md px-3 py-1.5 max-w-full">
      <span className="text-status-working/70">›</span>
      <span className="break-all">{display}</span>
    </div>
  );
}

function TerminalBlock({ text, stream }: { text: string; stream: "stdout" | "stderr" }) {
  const cleaned = stripAnsi(text).replace(/^\n+|\n+$/g, "");
  const isErr = stream === "stderr";
  const accent = isErr
    ? "border-status-error/30 bg-status-error/30 text-status-error/90"
    : "border-surface-3 bg-surface-4/60 text-slate-200";
  const labelColor = isErr ? "text-status-error/80" : "text-slate-400";
  return (
    <div className={`rounded-lg border ${accent} overflow-hidden`}>
      <div
        className={`flex items-center gap-1.5 px-3 py-1 text-[10px] uppercase tracking-wider border-b border-current/10 ${labelColor}`}
      >
        <Terminal className="w-3 h-3" />
        <span>{stream}</span>
      </div>
      <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed max-h-96 overflow-y-auto">
        {cleaned}
      </pre>
    </div>
  );
}

function CaveatBlock({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-status-waiting/15 bg-status-waiting/[0.05] px-3 py-1.5 text-[11px] text-status-waiting/70">
      <Info className="w-3.5 h-3.5 mt-px flex-shrink-0 opacity-60" />
      <span className="leading-relaxed italic">{stripAnsi(text).trim()}</span>
    </div>
  );
}

function renderSegment(seg: TuiSegment, key: number): React.ReactNode {
  switch (seg.kind) {
    case "command":
      return <CommandPill key={key} display={seg.display} />;
    case "stdout":
      return <TerminalBlock key={key} text={seg.text} stream="stdout" />;
    case "stderr":
      return <TerminalBlock key={key} text={seg.text} stream="stderr" />;
    case "caveat":
      return <CaveatBlock key={key} text={seg.text} />;
    case "system-reminder":
      return (
        <CollapsibleBlock
          key={key}
          text={seg.text}
          icon={<AlertTriangle className="w-3.5 h-3.5 text-status-waiting/70 flex-shrink-0" />}
          title="System reminder"
          borderClass="border-status-waiting/20"
          bgClass="bg-status-waiting/5"
          textClass="text-status-waiting/80"
        />
      );
    case "persisted-output":
      return (
        <CollapsibleBlock
          key={key}
          text={seg.text}
          icon={<ScrollText className="w-3.5 h-3.5 text-accent/60 flex-shrink-0" />}
          title="Persisted output"
          borderClass="border-accent/20"
          bgClass="bg-accent/5"
          textClass="text-accent-hover/80"
        />
      );
    case "text": {
      const cleaned = stripAnsi(seg.text);
      if (!cleaned.trim()) return null;
      return (
        <div key={key} className="min-w-0">
          <MarkdownContent text={cleaned} />
        </div>
      );
    }
  }
}

function CollapsibleBlock({
  text,
  icon,
  title,
  borderClass,
  bgClass,
  textClass,
}: {
  text: string;
  icon: React.ReactNode;
  title: string;
  borderClass: string;
  bgClass: string;
  textClass: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`rounded-lg border ${borderClass} ${bgClass} overflow-hidden`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:opacity-80 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 opacity-60 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 opacity-60 flex-shrink-0" />
        )}
        {icon}
        <span className={`text-xs ${textClass} truncate`}>{title}</span>
      </button>
      {expanded && (
        <div className="border-t border-current/10 px-3 py-2">
          <pre className="text-xs opacity-60 whitespace-pre-wrap break-words leading-relaxed max-h-96 overflow-y-auto">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}

export function MessageList({ messages, loading }: MessageListProps) {
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(() => new Set());

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-500 text-sm">
        Loading conversation...
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 text-sm">No conversation records found.</div>
    );
  }

  const toolResultMap = buildToolResultMap(messages);

  
  const userMsgHasText = useMemo(() => {
    const map = new Map<number, boolean>();
    messages.forEach((msg, idx) => {
      if (msg.type !== "user") return;
      const hasText = msg.content.some((c) => c.type === "text");
      map.set(idx, hasText);
    });
    return map;
  }, [messages]);

  return (
    <div className="space-y-3">
      {messages.map((msg, idx) => {
        
        
        if (msg.type === "session_event") {
          return <SessionEventRow key={idx} title={msg.title} timestamp={msg.timestamp} />;
        }

        
        if (msg.type === "user" && !userMsgHasText.get(idx)) {
          return null;
        }

        const isAssistant = msg.type === "assistant";
        
        
        const sender: TranscriptSender = msg.sender ?? (isAssistant ? "assistant" : "user");
        const style = SENDER_STYLES[sender] ?? SENDER_STYLES.user;
        const SenderIcon = style.icon;

        return (
          <div
            key={idx}
            className={`relative flex gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2/30 transition-colors before:absolute before:left-0 before:top-3 before:bottom-3 before:w-0.5 before:rounded-full before:opacity-60 ${style.accentBar}`}
          >
            <div
              className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-0.5 shadow-sm ${style.avatarRing}`}
            >
              <SenderIcon className="w-4 h-4" />
            </div>

            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-semibold tracking-wide ${style.headerText}`}>
                  {style.label}
                </span>
                {msg.model && (
                  <span className="text-[10px] text-slate-400 font-mono bg-surface-3/60 border border-surface-3 rounded px-1.5 py-0.5">
                    {formatModelName(msg.model)}
                  </span>
                )}
                {msg.usage && (
                  <span className="text-[10px] text-slate-500 font-mono inline-flex items-center gap-1">
                    <span className="text-status-working/70">↓ {fmt(msg.usage.input_tokens)}</span>
                    <span className="text-slate-700">·</span>
                    <span className="text-status-error/70">↑ {fmt(msg.usage.output_tokens)}</span>
                  </span>
                )}
                {msg.timestamp && (
                  <span className="text-[10px] text-slate-600 ml-auto font-mono">
                    {formatLocalTime(msg.timestamp)}
                  </span>
                )}
              </div>

              {msg.content.map((block, bIdx) => {
                if (block.type === "text" && block.text) {
                  
                  if (isTaskNotification(block.text)) {
                    return (
                      <CollapsibleBlock
                        key={bIdx}
                        text={block.text}
                        icon={<ScrollText className="w-3.5 h-3.5 text-accent/60 flex-shrink-0" />}
                        title="Task Notification"
                        borderClass="border-accent/20"
                        bgClass="bg-accent/5"
                        textClass="text-accent/80"
                      />
                    );
                  }

                  
                  if (isSkillContent(block.text)) {
                    const pathMatch = block.text.match(/^Base directory for this skill:\s*(\S+)/);
                    const skillPath = pathMatch ? pathMatch[1]! : "Skill";
                    return (
                      <CollapsibleBlock
                        key={bIdx}
                        text={block.text}
                        icon={<ScrollText className="w-3.5 h-3.5 text-accent/60 flex-shrink-0" />}
                        title={skillPath}
                        borderClass="border-accent/20"
                        bgClass="bg-accent/5"
                        textClass="text-accent/80"
                      />
                    );
                  }

                  
                  
                  
                  if (hasTuiTags(block.text)) {
                    const segments = parseTuiSegments(block.text);
                    return (
                      <div key={bIdx} className="space-y-2 min-w-0">
                        {segments.map((s, sIdx) => renderSegment(s, sIdx))}
                      </div>
                    );
                  }

                  return (
                    <div key={bIdx} className="min-w-0">
                      <MarkdownContent text={stripAnsi(block.text)} />
                    </div>
                  );
                }

                if (block.type === "thinking" && block.text) {
                  const thinkKey = idx * 100 + bIdx;
                  const isExpanded = expandedThinking.has(thinkKey);
                  return (
                    <div
                      key={bIdx}
                      className="rounded-lg border border-status-waiting/20 bg-status-waiting/5 overflow-hidden"
                    >
                      <button
                        onClick={() =>
                          setExpandedThinking((prev) => {
                            const next = new Set(prev);
                            if (next.has(thinkKey)) next.delete(thinkKey);
                            else next.add(thinkKey);
                            return next;
                          })
                        }
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-status-waiting/10 transition-colors"
                      >
                        <ChevronRight
                          className={`w-3.5 h-3.5 text-status-waiting/60 transition-transform duration-150 ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                        />
                        <Brain className="w-3.5 h-3.5 text-status-waiting/80" />
                        <span className="text-xs text-status-waiting/90 font-medium">Thinking</span>
                        {!isExpanded && (
                          <span className="text-[10px] text-status-waiting/40 font-mono ml-auto">
                            {block.text.length.toLocaleString()} chars
                          </span>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="border-t border-status-waiting/10 px-3 py-2 text-status-waiting/80">
                          <MarkdownContent text={block.text} dense />
                        </div>
                      )}
                    </div>
                  );
                }

                if (block.type === "tool_use") {
                  const matchedResult = block.id ? (toolResultMap.get(block.id) ?? null) : null;
                  return <ToolCallBlock key={bIdx} toolUse={block} toolResult={matchedResult} />;
                }

                
                return null;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
