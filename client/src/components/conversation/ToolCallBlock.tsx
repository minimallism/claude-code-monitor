import { useState } from "react";
import { ChevronRight, AlertCircle, FileText, CheckCircle2 } from "lucide-react";
import type { TranscriptContent } from "../../lib/types";
import { CodeBlock } from "./CodeBlock";
import { styleForTool } from "./toolStyle";

interface ToolCallBlockProps {
  toolUse: TranscriptContent;
  toolResult?: TranscriptContent | null;
}

function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "ts",
    js: "js",
    jsx: "js",
    mjs: "js",
    cjs: "js",
    py: "python",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    html: "html",
    htm: "html",
    css: "css",
    scss: "css",
    sql: "sql",
    md: "plain",
    txt: "plain",
    diff: "diff",
    patch: "diff",
  };
  return map[ext] ?? "plain";
}

function buildSummary(toolUse: TranscriptContent): string | null {
  const input = toolUse.input;
  if (!input || typeof input !== "object" || "_truncated" in input) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  if (typeof obj.command === "string") return obj.command.slice(0, 200);
  if (typeof obj.pattern === "string") return obj.pattern;
  if (typeof obj.query === "string") return obj.query;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.description === "string") return obj.description;
  return null;
}

function renderInput(toolUse: TranscriptContent) {
  const input = toolUse.input;
  if (!input) return null;

  
  if (typeof input === "object" && "_truncated" in input) {
    return (
      <CodeBlock
        code={String((input as { _truncated: string })._truncated)}
        lang="plain"
        label="Input (truncated)"
      />
    );
  }

  const obj = input as Record<string, unknown>;
  const tool = (toolUse.name ?? "").toLowerCase();

  
  if (tool === "bash" && typeof obj.command === "string") {
    return (
      <div className="space-y-2">
        <CodeBlock code={obj.command} lang="bash" label="Command" />
        {typeof obj.description === "string" && (
          <p className="text-xs text-slate-500 italic px-1">{obj.description}</p>
        )}
      </div>
    );
  }

  
  if (tool === "write" && typeof obj.file_path === "string" && typeof obj.content === "string") {
    return (
      <CodeBlock
        code={obj.content}
        lang={langFromPath(obj.file_path)}
        filename={obj.file_path}
        label="New file"
      />
    );
  }

  
  if (tool === "edit" && typeof obj.file_path === "string") {
    const lang = langFromPath(obj.file_path);
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <FileText className="w-3.5 h-3.5 text-accent" />
          <span className="font-mono">{obj.file_path}</span>
          {obj.replace_all === true && (
            <span className="text-[10px] uppercase tracking-wider text-status-waiting/80 bg-status-waiting/10 border border-status-waiting/20 rounded px-1.5 py-0.5">
              replace all
            </span>
          )}
        </div>
        {typeof obj.old_string === "string" && (
          <CodeBlock code={obj.old_string} lang={lang} label="Removed" tone="danger" />
        )}
        {typeof obj.new_string === "string" && (
          <CodeBlock code={obj.new_string} lang={lang} label="Added" tone="success" />
        )}
      </div>
    );
  }

  
  if (tool === "read" && typeof obj.file_path === "string") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-slate-300 bg-surface-4/40 border border-surface-3 rounded-md px-3 py-2">
        <FileText className="w-3.5 h-3.5 text-accent flex-shrink-0" />
        <span className="font-mono break-all">{obj.file_path}</span>
        {(typeof obj.offset === "number" || typeof obj.limit === "number") && (
          <span className="text-slate-500 font-mono ml-auto flex-shrink-0">
            {typeof obj.offset === "number" ? `:${obj.offset}` : ""}
            {typeof obj.limit === "number" ? `+${obj.limit}` : ""}
          </span>
        )}
      </div>
    );
  }

  
  if (tool === "grep" && typeof obj.pattern === "string") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-500 font-mono uppercase tracking-wider text-[10px]">
            Pattern
          </span>
          <code className="font-mono text-accent bg-surface-4 border border-surface-3 rounded px-1.5 py-0.5">
            {obj.pattern}
          </code>
        </div>
        {typeof obj.path === "string" && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500 font-mono uppercase tracking-wider text-[10px]">
              Path
            </span>
            <code className="font-mono text-slate-300">{obj.path}</code>
          </div>
        )}
        {typeof obj.glob === "string" && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500 font-mono uppercase tracking-wider text-[10px]">
              Glob
            </span>
            <code className="font-mono text-slate-300">{obj.glob}</code>
          </div>
        )}
      </div>
    );
  }

  
  return <CodeBlock code={JSON.stringify(obj, null, 2)} lang="json" label="Input" />;
}

function renderResult(toolResult: TranscriptContent, toolName: string) {
  const text = toolResult.output ?? "";
  if (text.length === 0) return <div className="text-xs text-slate-500 italic px-1">(empty)</div>;

  const isError = !!toolResult.is_error;
  const tool = toolName.toLowerCase();
  const label = isError ? "Error" : "Output";

  
  let lang = "plain";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      lang = "json";
    } catch {
      
    }
  } else if (/^(\+\+\+|---|@@) /m.test(text) || /^diff --git /m.test(text)) {
    lang = "diff";
  } else if (tool === "bash") {
    lang = "bash";
  }

  return <CodeBlock code={text} lang={lang} label={label} tone={isError ? "danger" : "default"} />;
}

export function ToolCallBlock({ toolUse, toolResult }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const isError = toolResult?.is_error;
  const hasResult = toolResult != null;
  const summary = buildSummary(toolUse);
  const style = styleForTool(toolUse.name);
  const Icon = style.Icon;

  const wrapperBorder = isError ? "border-status-error/30" : style.border;
  const wrapperBg = isError ? "bg-status-error/5" : "bg-surface-2/60";

  return (
    <div
      className={`rounded-lg border ${wrapperBorder} ${wrapperBg} overflow-hidden transition-colors`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-3/40 transition-colors"
      >
        <ChevronRight
          className={`w-3.5 h-3.5 text-slate-500 flex-shrink-0 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span
          className={`flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded ${style.chip}`}
        >
          <Icon className="w-3 h-3" />
        </span>
        <span className={`font-mono font-medium text-[13px] flex-shrink-0 ${style.text}`}>
          {toolUse.name}
        </span>
        {summary && (
          <span className="text-slate-500 text-xs font-mono truncate min-w-0" title={summary}>
            {summary}
          </span>
        )}
        <span className="ml-auto flex-shrink-0">
          {isError ? (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-status-error/90 bg-status-error/15 border border-status-error/20 rounded px-1.5 py-0.5">
              <AlertCircle className="w-3 h-3" />
              error
            </span>
          ) : hasResult ? (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-status-working/80 bg-status-working/10 border border-status-working/20 rounded px-1.5 py-0.5">
              <CheckCircle2 className="w-3 h-3" />
              ok
            </span>
          ) : (
            <span className="text-slate-600 text-[10px] uppercase tracking-wider font-mono">
              pending
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-surface-3 bg-surface-1/40 px-3 py-3 space-y-2.5 animate-fade-in">
          {renderInput(toolUse)}
          {hasResult && renderResult(toolResult, toolUse.name ?? "")}
        </div>
      )}
    </div>
  );
}
