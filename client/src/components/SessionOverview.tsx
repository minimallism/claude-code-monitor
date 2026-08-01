import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Wrench,
  Coins,
  Bot,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { fmt } from "../lib/format";
import { styleForTool } from "./conversation/toolStyle";
import type { Agent, Session, SessionStats } from "../lib/types";

interface SessionOverviewProps {
  session: Session;
  agents: Agent[];
}

const REFRESH_DEBOUNCE_MS = 600;


function ToolUsageRow({ toolName, count, max }: { toolName: string; count: number; max: number }) {
  const style = styleForTool(toolName);
  const Icon = style.Icon;
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;

  return (
    <div className="flex items-center gap-3 group/tool">
      <div className={`flex items-center gap-2 w-32 flex-shrink-0 ${style.text}`}>
        <span
          className={`inline-flex items-center justify-center w-5 h-5 rounded ${style.chip} flex-shrink-0`}
        >
          <Icon className="w-3 h-3" />
        </span>
        <span className="font-mono text-xs truncate" title={toolName}>
          {toolName}
        </span>
      </div>
      <div className="flex-1 h-1.5 rounded-full bg-surface-3/60 overflow-hidden">
        <div
          className={`h-full rounded-full ${style.bar} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-xs text-slate-400 w-14 text-right flex-shrink-0">
        {count.toLocaleString()}
      </span>
    </div>
  );
}

export function SessionOverview({ session, agents }: SessionOverviewProps) {
  const { t } = useTranslation("sessions");
  const [stats, setStats] = useState<SessionStats | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchingRef = useRef(false);

  const fetchStats = async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const result = await api.sessions.stats(session.id);
      setStats(result);
    } catch {
      
    } finally {
      fetchingRef.current = false;
    }
  };

  
  useEffect(() => {
    fetchStats();
    
  }, [session.id]);

  
  useEffect(() => {
    const unsubscribe = eventBus.subscribe((msg) => {
      const isRelevant =
        msg.type === "new_event" ||
        msg.type === "agent_created" ||
        msg.type === "agent_updated" ||
        msg.type === "session_updated";
      if (!isRelevant) return;
      const data = msg.data as { session_id?: string; id?: string };
      
      const matchesSession = data.session_id === session.id || data.id === session.id;
      if (!matchesSession) return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        fetchStats();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
    
  }, [session.id]);

  
  const maxToolCount = useMemo(() => {
    if (!stats) return 0;
    return stats.tools_used.reduce((maxCount, tool) => Math.max(maxCount, tool.count), 0);
  }, [stats]);

  

  const activeAgent = useMemo(() => agents.find((a) => a.status === "working") ?? null, [agents]);

  if (!stats) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 mb-4 animate-pulse">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[68px] rounded-lg border border-surface-3 bg-surface-2/40" />
        ))}
      </div>
    );
  }

  const tokens = stats.tokens;
  const totalTokens =
    tokens.input_tokens +
    tokens.output_tokens +
    tokens.cache_read_tokens +
    tokens.cache_write_tokens;

  return (
    <div className="space-y-3 mb-4">
      {activeAgent && (
        <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-status-working/20 bg-status-working/5">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-working opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-status-working" />
          </span>
          <Bot className="w-3.5 h-3.5 text-status-working/90 flex-shrink-0" />
          <span className="text-xs text-status-working/80 font-medium flex-shrink-0">
            {activeAgent.name || t("detail.agents")}
          </span>
          {activeAgent.current_tool && (
            <span className="text-[11px] text-slate-400 font-mono inline-flex items-center gap-1">
              <span className="text-slate-600">{t("overview.running")}</span>
              <span className="text-status-working/90">{activeAgent.current_tool}</span>
            </span>
          )}
          {activeAgent.task && (
            <span className="text-[11px] text-slate-400 truncate min-w-0" title={activeAgent.task}>
              · {activeAgent.task}
            </span>
          )}
        </div>
      )}

      {totalTokens > 0 && (
        <div className="rounded-lg border border-surface-3 bg-surface-2/60 p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Coins className="w-3.5 h-3.5 text-status-waiting" />
              {t("overview.tokenFlow")}
            </h3>
            <span className="text-[10px] text-slate-500 font-mono">{fmt(totalTokens)} {t("overview.total")}</span>
          </div>
          <TokenFlowBar tokens={tokens} total={totalTokens} />
        </div>
      )}

      <div className="rounded-lg border border-surface-3 bg-surface-2/60 p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-accent" />
              {t("overview.toolCalls")}
            </h3>
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className="text-slate-400 font-mono font-semibold">{stats.tool_call_attempts.toLocaleString()} {t("overview.total")}</span>
            <span className="text-slate-600">·</span>
            <span className="text-status-working">{stats.tool_call_success} {t("overview.success")}</span>
            <span className="text-slate-600">·</span>
            <span className="text-status-error">{stats.tool_call_failed} {t("overview.failed")}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400">{(stats.tool_call_attempts - stats.tool_call_success - stats.tool_call_failed).toLocaleString()} {t("overview.blocked")}</span>
          </div>
        </div>
        {stats.tools_used.length === 0 ? (
          <div className="text-center py-4 text-xs text-slate-500">{t("overview.noToolCalls")}</div>
        ) : (
          <div className="space-y-1">
            {stats.tools_used.map((tool) => (
              <ToolUsageRow
                key={tool.tool_name}
                toolName={tool.tool_name}
                count={tool.count}
                max={maxToolCount}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

function TokenFlowBar({ tokens, total }: { tokens: SessionStats["tokens"]; total: number }) {
  const { t } = useTranslation("sessions");
  const segments = [
    {
      key: "cache_read",
      label: t("overview.cacheRead"),
      value: tokens.cache_read_tokens,
      cls: "bg-accent",
      text: "text-accent",
    },
    {
      key: "cache_write",
      label: t("overview.cacheWrite"),
      value: tokens.cache_write_tokens,
      cls: "bg-status-waiting",
      text: "text-status-waiting",
    },
    {
      key: "input",
      label: t("overview.input"),
      value: tokens.input_tokens,
      cls: "bg-status-working",
      text: "text-status-working/90",
    },
    {
      key: "output",
      label: t("overview.output"),
      value: tokens.output_tokens,
      cls: "bg-status-error",
      text: "text-status-error",
    },
  ];

  return (
    <>
      <div className="flex w-full h-2 rounded-full overflow-hidden bg-surface-3/60 mb-2">
        {segments.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div
              key={s.key}
              className={`${s.cls} opacity-80 hover:opacity-100 transition-opacity`}
              style={{ width: `${pct}%` }}
              title={`${s.label}: ${s.value.toLocaleString()} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {segments.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className={`block w-2 h-2 rounded-full ${s.cls}`} />
              <span className="text-slate-500 text-[11px]">{s.label}</span>
              <span className={`font-mono ${s.text}`}>
                {fmt(s.value)}
                {pct > 0 && (
                  <span className="text-slate-600 text-[10px] ml-1">
                    {pct >= 1 ? Math.round(pct) : pct.toFixed(1)}%
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
