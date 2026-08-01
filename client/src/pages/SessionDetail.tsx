import { useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Bot,
  Clock,
  Files,
  Cpu,
  ChevronDown,
  ChevronRight,
  GitBranch,
  MessageSquare,
  X,
  AlertCircle,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { AgentCard } from "../components/AgentCard";
import { SessionOverview } from "../components/SessionOverview";
import { ConversationView } from "../components/conversation/ConversationView";
import { SessionStatusBadge } from "../components/StatusBadge";
import { effectiveSessionStatus } from "../lib/types";
import { Skeleton } from "../components/Skeleton";
import {
  formatDateTime,
  formatDuration,
  formatModelName,
} from "../lib/format";
import type {
  Session,
  Agent,
  TranscriptInfo,
} from "../lib/types";

type DetailTab = "agents" | "conversation";

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation("sessions");
  const [session, setSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => {
    return new Set<string>();
  });
  const [activeTab, setActiveTab] = useState<DetailTab>("agents");
  const [conversationTotal, setConversationTotal] = useState(0);

  const [visitedTabs, setVisitedTabs] = useState<Set<DetailTab>>(() => new Set(["agents"]));
  useEffect(() => {
    setVisitedTabs((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);
  const [transcripts, setTranscripts] = useState<TranscriptInfo[]>([]);
  const [pendingTranscriptId, setPendingTranscriptId] = useState<string | null>(null);
  const [transcriptNotFound, setTranscriptNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.sessions
      .transcript(id, { limit: 1 })
      .then((result) => {
        if (!cancelled) setConversationTotal(result.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);
  const notFoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goBack = useCallback(() => {
    const historyState =
      typeof window !== "undefined" ? (window.history.state as { idx?: number } | null) : null;
    if ((historyState?.idx ?? 0) > 0) {
      navigate(-1);
      return;
    }
    navigate("/sessions");
  }, [navigate]);

  
  useEffect(() => {
    if (transcriptNotFound) {
      notFoundTimerRef.current = setTimeout(() => setTranscriptNotFound(false), 8000);
      return () => {
        if (notFoundTimerRef.current) clearTimeout(notFoundTimerRef.current);
      };
    }
  }, [transcriptNotFound]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.sessions.get(id);
      setSession(data.session);
      setAgents(data.agents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("detail.failedLoad"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    load();
  }, [load]);

  
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.sessions
      .transcripts(id)
      .then((result) => {
        if (!cancelled) setTranscripts(result.transcripts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  
  /**
   * 点击 agent 卡片时，跳转到 Conversation 标签并选中对应 transcript。
   *
   * transcript 匹配优先级：
   * 1. db_agent_id 完全匹配（最可靠）。
   * 2. 主 agent 固定使用 "main"。
   * 3. 子 agent 按 subagent_type -> name 逐步过滤候选；只剩一个候选时选中。
   * 4. 当前 transcripts 为空时，先异步拉取列表再尝试匹配；仍然失败则显示未找到提示。
   */
  const navigateToAgentConversation = useCallback(
    (agent: Agent) => {
      setTranscriptNotFound(false);

      const findTranscriptId = (ts: TranscriptInfo[]): string | null => {
        // 优先按数据库 agent id 精确匹配。
        const exactMatch = ts.find((t) => t.db_agent_id === agent.id);
        if (exactMatch) return exactMatch.id;

        // 主 agent 的 transcript id 固定为 "main"。
        if (agent.type === "main") return "main";

        // 子 agent 按类型和名称逐步缩小候选范围。
        let candidates = ts.filter((t) => t.type !== "main");
        if (agent.subagent_type) {
          const byType = candidates.filter(
            (t) => t.subagent_type === agent.subagent_type || t.type === agent.subagent_type
          );
          if (byType.length > 0) candidates = byType;
        }
        if (agent.name && candidates.length > 1) {
          const byName = candidates.filter((t) => t.name === agent.name);
          if (byName.length > 0) candidates = byName;
        }
        if (candidates.length === 1) return candidates[0]!.id;

        return null;
      };

      setActiveTab("conversation");

      const transcriptId = findTranscriptId(transcripts);

      if (transcriptId) {
        setPendingTranscriptId(transcriptId);
      } else if (transcripts.length === 0 && id) {
        // transcripts 还没加载过时，先拉取再匹配。
        api.sessions
          .transcripts(id)
          .then((result) => {
            setTranscripts(result.transcripts);
            const freshId = findTranscriptId(result.transcripts);
            if (freshId) {
              setPendingTranscriptId(freshId);
            } else {
              setTranscriptNotFound(true);
            }
          })
          .catch(() => {
            setTranscriptNotFound(true);
          });
      } else {
        // 候选不唯一或没有候选，提示用户。
        setTranscriptNotFound(true);
      }
    },
    [transcripts, id]
  );

  
  const compactionLabels = useMemo(() => {
    const map = new Map<string, string>();
    const compactions = agents
      .filter((a) => a.subagent_type === "compaction")
      .sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
    compactions.forEach((a, i) => {
      const time = a.started_at
        ? new Date(a.started_at).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      map.set(a.id, `#${i + 1}${time ? ` · ${time}` : ""}`);
    });
    return map;
  }, [agents]);

  useEffect(() => {
    const parentsWithActiveChildren = new Set<string>();
    for (const a of agents) {
      if (a.parent_agent_id && a.status === "working") {
        parentsWithActiveChildren.add(a.parent_agent_id);
      }
    }
    if (parentsWithActiveChildren.size > 0) {
      const agentMap = new Map(agents.map((a) => [a.id, a]));
      const toExpand = new Set<string>();
      for (const pid of parentsWithActiveChildren) {
        let cur = pid;
        while (cur) {
          toExpand.add(cur);
          const parent = agentMap.get(cur);
          cur = parent?.parent_agent_id ?? "";
        }
      }
      setExpandedAgents((prev) => new Set([...prev, ...toExpand]));
    }
  }, [agents]);

  useEffect(() => {
    const unsubscribe = eventBus.subscribe((msg) => {
      if (
        msg.type === "agent_created" ||
        msg.type === "agent_updated" ||
        msg.type === "session_updated"
      ) {
        load();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [load]);

  if (loading) {
    return (
      <div className="animate-fade-in space-y-8" aria-busy="true">
        <div className="flex items-start gap-4">
          <Skeleton className="w-8 h-8" rounded="md" />
          <div className="flex-1 space-y-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-6 w-64" />
              <Skeleton className="h-5 w-16" rounded="full" />
            </div>
            <div className="flex flex-wrap gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-24" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-5 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-24" />
            </div>
          ))}
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card p-5 space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ))}
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="text-center py-20">
        <p className="text-status-error mb-2">{error || t("detail.notFound")}</p>
        <button onClick={goBack} className="btn-ghost mt-4">
          <ArrowLeft className="w-4 h-4" /> {t("detail.backToSessions")}
        </button>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-8">
      <div className="flex items-start gap-4">
        <button onClick={goBack} className="btn-ghost mt-1">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-xl font-semibold text-slate-100">
              {session.name || `${t("defaultName")}${session.id.slice(0, 8)}`}
            </h2>
            <SessionStatusBadge status={effectiveSessionStatus(session, agents)} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 font-mono bg-surface-2 px-2 py-1 rounded">
              {session.id}
            </span>
            {session.model && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 bg-surface-2 px-2 py-1 rounded">
                <Cpu className="w-3 h-3 text-slate-500" />
                {formatModelName(session.model)}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 bg-surface-2 px-2 py-1 rounded">
              <Clock className="w-3 h-3 text-slate-500" />
              {formatDateTime(session.started_at)}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 bg-surface-2 px-2 py-1 rounded">
              <Clock className="w-3 h-3 text-slate-500" />
              {formatDuration(session.started_at, session.ended_at ?? new Date().toISOString())}
            </span>
            {session.turn_count != null && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 bg-surface-2 px-2 py-1 rounded">
                <MessageSquare className="w-3 h-3 text-slate-500" />
                {t("common:turnSummary", { count: session.turn_count })}
              </span>
            )}
          </div>
          {session.cwd && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-2">
              <Files className="w-3 h-3 flex-shrink-0" />
              <span className="font-mono truncate">{session.cwd}</span>
            </div>
          )}
        </div>

      </div>

      <div className="flex items-center gap-1 border-b border-border">
        <button
          onClick={() => {
            setActiveTab("agents");
            setTranscriptNotFound(false);
          }}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "agents"
              ? "border-accent text-accent"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          <Bot className="w-4 h-4" />
          {t("detail.agents")} ({agents.length})
        </button>
        <button
          onClick={() => {
            setActiveTab("conversation");
            setTranscriptNotFound(false);
          }}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "conversation"
              ? "border-accent text-accent"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          Conversation {conversationTotal > 0 && `(${conversationTotal})`}
        </button>
      </div>

      {transcriptNotFound && (
        <div className="flex items-center gap-2 px-4 py-2.5 mb-3 text-sm text-status-waiting bg-status-waiting/10 border border-status-waiting/20 rounded-lg">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>
            Conversation transcript not found for this agent. The transcript file may be missing or
            not yet linked.
          </span>
          <button
            onClick={() => setTranscriptNotFound(false)}
            className="ml-auto text-status-waiting/60 hover:text-status-waiting transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {visitedTabs.has("agents") && (
        <div hidden={activeTab !== "agents"}>
          <SessionOverview session={session} agents={agents} />

          {agents.length === 0 ? (
            <p className="text-sm text-slate-500">{t("detail.noAgents")}</p>
          ) : (
            <>
              <div className="space-y-2" data-testid="agent-tree">
                {(() => {
                  
                  const agentMap = new Map(agents.map((a) => [a.id, a]));
                  const childrenByParent = new Map<string, Agent[]>();
                  const rootAgents: Agent[] = [];
                  for (const a of agents) {
                    if (a.parent_agent_id && agentMap.has(a.parent_agent_id)) {
                      const list = childrenByParent.get(a.parent_agent_id) || [];
                      list.push(a);
                      childrenByParent.set(a.parent_agent_id, list);
                    } else if (!a.parent_agent_id || !agentMap.has(a.parent_agent_id)) {
                      rootAgents.push(a);
                    }
                  }
                  
                  rootAgents.sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
                  for (const key of childrenByParent.keys()) {
                    childrenByParent
                      .get(key)!
                      .sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
                  }

                  
                  
                  
                  function countDescendants(id: string, seen = new Set<string>()): { total: number; active: number } {
                    if (seen.has(id)) return { total: 0, active: 0 };
                    seen.add(id);
                    const kids = childrenByParent.get(id) || [];
                    return kids.reduce(
                      (acc, k) => {
                        const child = countDescendants(k.id, seen);
                        return {
                          total: acc.total + 1 + child.total,
                          active: acc.active + (k.status === "working" ? 1 : 0) + child.active,
                        };
                      },
                      { total: 0, active: 0 }
                    );
                  }

                  
                  
                  function renderAgentNode(
                    agent: Agent,
                    depth: number,
                    ancestors: Set<string> = new Set()
                  ): ReactNode {
                    if (ancestors.has(agent.id)) return null;
                    const childAncestors = new Set(ancestors).add(agent.id);
                    const children = childrenByParent.get(agent.id) || [];
                    const isExpanded = expandedAgents.has(agent.id);
                    const hasChildren = children.length > 0;
                    const isSubagent = depth > 0;
                    const { total: totalDesc, active: activeDesc } = hasChildren
                      ? countDescendants(agent.id)
                      : { total: 0, active: 0 };
                    const toggleExpanded =() =>
                      setExpandedAgents((prev) => {
                        const next = new Set(prev);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        return next;
                      });

                    return (
                      <div key={agent.id}>
                        <div className="flex items-center gap-1 min-w-0">
                          {hasChildren && (
                            <button
                              onClick={toggleExpanded}
                              className="p-1 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
                              aria-label={isExpanded ? "Collapse subagents" : "Expand subagents"}
                              aria-expanded={isExpanded}
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </button>
                          )}
                          {isSubagent && !hasChildren && <span className="w-6 flex-shrink-0" />}
                          {isSubagent && (
                            <GitBranch className="w-3 h-3 text-accent flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <AgentCard
                              agent={agent}
                              session={session ?? undefined}
                              label={compactionLabels.get(agent.id)}
                              onClick={() => navigateToAgentConversation(agent)}
                            />
                          </div>
                        </div>

                        {hasChildren && isExpanded && (
                          <div className="ml-6 mt-1 space-y-1 border-l-2 border-accent/20 pl-3">
                            {children.map((child) =>
                              renderAgentNode(child, depth + 1, childAncestors)
                            )}
                          </div>
                        )}

                        {hasChildren && !isExpanded && (
                          <button
                            onClick={() =>
                              setExpandedAgents((prev) => new Set([...prev, agent.id]))
                            }
                            className="ml-7 mt-1 text-[11px] text-accent hover:text-accent-hover transition-colors"
                          >
                            {t("common:subagent_label", { count: totalDesc })}
                            {activeDesc > 0 && (
                              <span className="text-status-working ml-1">
                                ({activeDesc} {t("common:status.working")})
                              </span>
                            )}
                          </button>
                        )}
                      </div>
                    );
                  }

                  
                  const orphans = rootAgents.filter(
                    (a) =>
                      a.type === "subagent" && a.parent_agent_id && !agentMap.has(a.parent_agent_id)
                  );
                  const roots = rootAgents.filter(
                    (a) =>
                      !(
                        a.type === "subagent" &&
                        a.parent_agent_id &&
                        !agentMap.has(a.parent_agent_id)
                      )
                  );

                  return (
                    <>
                      {roots.map((agent) => renderAgentNode(agent, 0))}

                      {orphans.length > 0 && (
                        <div className="mt-4">
                          <p className="text-[11px] text-slate-500 mb-2 uppercase tracking-wider">
                            {t("detail.unparented")}
                          </p>
                          <div className="space-y-1">
                            {orphans.map((agent) => renderAgentNode(agent, 1))}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      )}

      {visitedTabs.has("conversation") && (
        <div hidden={activeTab !== "conversation"}>
          <ConversationView
            sessionId={session.id}
            initialTranscriptId={pendingTranscriptId}
            onTotalChange={setConversationTotal}
          />
        </div>
      )}
    </div>
  );
}
