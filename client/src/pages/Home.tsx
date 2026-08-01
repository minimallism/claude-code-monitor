import {
  useEffect,
  useState,
  useCallback,
  useSyncExternalStore,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Layers,
  Bot,
  Activity,
  Users,
  Boxes,
  Gauge,
  Coins,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleDot,
  GitBranch,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { StatCard } from "../components/StatCard";
import { AgentCard } from "../components/AgentCard";
import { EmptyState } from "../components/EmptyState";
import { fmt } from "../lib/format";
import type { Stats, Agent, WSMessage, Session } from "../lib/types";
import { isSessionAwaitingInput, isAgentAwaitingInput } from "../lib/types";

export function Home() {
  const { t } = useTranslation("dashboard");

  const [stats, setStats] = useState<Stats | null>(null);
  const [activeAgents, setActiveAgents] = useState<Agent[]>([]);
  const [allSubagents, setAllSubagents] = useState<Agent[]>([]);
  const [sessionsById, setSessionsById] = useState<Map<string, Session>>(new Map());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  
  const agentsRef = useRef<HTMLDivElement>(null);
  // 根据容器高度动态计算可见主 agent 数量，避免一次性渲染过多卡片。
  const [visibleAgentCount, setVisibleAgentCount] = useState(6);

  useEffect(() => {
    const HEADER_H = 32;
    const AGENT_H = 48;

    function recalc() {
      if (agentsRef.current) {
        setVisibleAgentCount(
          Math.max(3, Math.floor((agentsRef.current.clientHeight - HEADER_H) / AGENT_H))
        );
      }
    }

    const ro = new ResizeObserver(recalc);
    if (agentsRef.current) ro.observe(agentsRef.current);
    recalc();
    return () => ro.disconnect();
  }, []);

  /**
   * 加载仪表盘数据：
   * - stats：顶部统计卡片。
   * - working + waiting agents：活跃 agent 列表。
   * - active sessions：用于给 agent 卡片提供 session 上下文（名称、cwd、模型）。
   * - 对每个活跃 session 再拉取其全部 agents，用于构建子 agent 树。
   */
  const load = useCallback(async () => {
    try {
      const [statsRes, workingRes, waitingRes, sessionsRes] = await Promise.all(
        [
          api.stats.get(),
          api.agents.list({ status: "working", limit: 20 }),
          api.agents.list({ status: "waiting", limit: 20 }),
          api.sessions.list({ status: "active", limit: 100 }),
        ]
      );
      setStats(statsRes);
      const active = [...workingRes.agents, ...waitingRes.agents];
      setActiveAgents(active);
      setSessionsById(new Map(sessionsRes.sessions.map((s) => [s.id, s])));
      setError(null);

      // 只对有主 agent 活跃的 session 拉取子 agent，减少请求量。
      const activeSessionIds = [
        ...new Set(active.filter((a) => a.type === "main").map((a) => a.session_id)),
      ];
      if (activeSessionIds.length > 0) {
        const subagentResults = await Promise.all(
          activeSessionIds.map((sid) => api.agents.list({ session_id: sid, limit: 100 }))
        );
        const subs = subagentResults.flatMap((r) => r.agents).filter((a) => a.type === "subagent");
        setAllSubagents(subs);
      } else {
        setAllSubagents([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failedLoad"));
    }
  }, [t]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  
  /**
   * 自动展开含有 working 子 agent 的分支。
   *
   * 当有新的子 agent 开始工作时，从该子 agent 沿 parent_agent_id 链向上找到所有祖先，
   * 并把它们加入 expandedAgents，确保用户能看到正在工作的子 agent。
   */
  useEffect(() => {
    const parentsWithActive = new Set<string>();
    for (const a of allSubagents) {
      if (a.parent_agent_id && a.status === "working") {
        parentsWithActive.add(a.parent_agent_id);
      }
    }
    if (parentsWithActive.size === 0) return;

    const subMap = new Map(allSubagents.map((a) => [a.id, a]));
    const toExpand = new Set<string>();
    for (const pid of parentsWithActive) {
      let cur = pid;
      while (cur) {
        toExpand.add(cur);
        const parent = subMap.get(cur);
        cur = parent?.parent_agent_id ?? "";
      }
    }
    setExpandedAgents((prev) => {
      // 只有真正需要新增时才创建新的 Set，避免无意义重渲染。
      const newIds = [...toExpand].filter((id) => !prev.has(id));
      if (newIds.length === 0) return prev;
      return new Set([...prev, ...newIds]);
    });
  }, [allSubagents]);

  /**
   * 监听 SSE 事件，对 agent/session 相关推送做 300ms 防抖刷新。
   *
   * 300ms 与项目约束一致：SSE 重连时不应触发大量重复请求。
   */
  useEffect(() => {
    const debounceRef = { timer: null as ReturnType<typeof setTimeout> | null };
    return eventBus.subscribe((msg: WSMessage) => {
      if (
        msg.type === "agent_created" ||
        msg.type === "agent_updated" ||
        msg.type === "session_created" ||
        msg.type === "session_updated"
      ) {
        if (debounceRef.timer) clearTimeout(debounceRef.timer);
        debounceRef.timer = setTimeout(load, 300);
      }
    });
  }, [load]);

  const wsConnected = useSyncExternalStore(eventBus.onConnection, () => eventBus.connected);

  
  /**
   * 构建子 agent 树结构。
   *
   * - childrenByParent：按 parent_agent_id 分组，方便 O(1) 查找子节点。
   * - getDescendants：递归计算某 agent 下所有后代子 agent 总数和工作中数量，
   *   使用 descendantCache 做记忆化，避免重复计算。
   */
  const agentTree = useMemo(() => {
    const childrenByParent = new Map<string, Agent[]>();
    for (const a of allSubagents) {
      if (a.parent_agent_id) {
        const list = childrenByParent.get(a.parent_agent_id) || [];
        list.push(a);
        childrenByParent.set(a.parent_agent_id, list);
      }
    }

    const descendantCache = new Map<string, { total: number; active: number }>();
    function getDescendants(id: string): { total: number; active: number } {
      if (descendantCache.has(id)) return descendantCache.get(id)!;

      // 先设置占位值，防止循环 parent 关系导致死循环（虽然理论上不应出现）。
      descendantCache.set(id, { total: 0, active: 0 });
      const kids = childrenByParent.get(id) || [];
      const result = kids.reduce(
        (acc, k) => {
          const child = getDescendants(k.id);
          return {
            total: acc.total + 1 + child.total,
            active: acc.active + (k.status === "working" ? 1 : 0) + child.active,
          };
        },
        { total: 0, active: 0 }
      );
      descendantCache.set(id, result);
      return result;
    }

    // 预计算所有子 agent 的后代统计，避免渲染时递归。
    for (const a of allSubagents) getDescendants(a.id);

    return { childrenByParent, getDescendants };
  }, [allSubagents]);

  // 统计卡片用到的派生数据。
  const totalTokens = stats
    ? stats.total_tokens_input + stats.total_tokens_output + stats.total_tokens_cache_read + stats.total_tokens_cache_write
    : 0;

  // 缓存命中率：cache_read / (input + cache_read)。
  const cacheHitRate = stats
    ? ((stats.total_tokens_cache_read / (stats.total_tokens_input + stats.total_tokens_cache_read || 1)) * 100)
    : 0;

  // active_sessions 包含 running 和 waiting；这里把它们拆开展示在趋势文本里。
  const waitingSessionCount = [...sessionsById.values()].filter((s) => isSessionAwaitingInput(s)).length;
  const runningSessionCount = (stats?.active_sessions ?? 0) - waitingSessionCount;

  // 活跃 agent 数量 = 主 agent + 所有子 agent。
  const workingAgentCount = activeAgents.filter((a) => a.type === "main" && a.status === "working").length
    + allSubagents.filter((a) => a.status === "working").length;
  const waitingAgentCount = activeAgents.filter((a) => a.type === "main" && (a.status === "waiting" || isAgentAwaitingInput(a))).length
    + allSubagents.filter((a) => a.status === "waiting" || isAgentAwaitingInput(a)).length;

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-status-error mb-2">{t("failedConnect")}</p>
        <p className="text-sm text-slate-500">{error}</p>
        <button onClick={load} className="btn-primary mt-4">
          {t("common:retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 animate-fade-in h-[calc(100vh-4rem)]">
      <div className="flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
            <LayoutDashboard className="w-4.5 h-4.5 text-accent" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-slate-100">{t("title")}</h1>
              {wsConnected ? (
                <span className="flex items-center gap-1.5 text-[11px] text-status-working bg-status-working/10 border border-status-working/20 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-status-working animate-pulse-dot" />
                  {t("common:live")}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-[11px] text-slate-400 bg-slate-500/10 border border-slate-500/20 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                  {t("common:offline")}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">{t("subtitle")}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 shrink-0">
            <StatCard
              label={t("totalProjects")}
              value={stats ? fmt(stats.total_projects) : ""}
              raw={stats ? stats.total_projects.toLocaleString() : undefined}
              icon={Boxes}
              accentColor="text-accent"
              loading={!stats}
            />
            <StatCard
              label={t("totalSessions")}
              value={stats ? fmt(stats.total_sessions) : ""}
              raw={stats ? stats.total_sessions.toLocaleString() : undefined}
              icon={Layers}
              loading={!stats}
            />
            <StatCard
              label={t("todaySessions")}
              value={stats ? stats.sessions_today : ""}
              raw={stats ? stats.sessions_today.toLocaleString() : undefined}
              icon={CalendarClock}
              loading={!stats}
            />
            <StatCard
              label={t("activeSessions")}
              value={stats ? stats.active_sessions : ""}
              trend={
                stats
                  ? t("activeSessionsTrend", {
                      running: runningSessionCount,
                      waiting: waitingSessionCount,
                    })
                  : undefined
              }
              icon={Activity}
              accentColor="text-status-waiting"
              loading={!stats}
            />
            <StatCard
              label={t("totalAgents")}
              value={stats ? fmt(stats.total_agents) : ""}
              raw={stats ? stats.total_agents.toLocaleString() : undefined}
              icon={Bot}
              accentColor="text-status-working"
              loading={!stats}
            />
            <StatCard
              label={t("activeAgents")}
              value={stats ? workingAgentCount + waitingAgentCount : ""}
              trend={
                stats
                  ? t("activeAgentsTrend", {
                      working: workingAgentCount,
                      waiting: waitingAgentCount,
                    })
                  : undefined
              }
              icon={Users}
              accentColor="text-accent"
              loading={!stats}
            />
            <StatCard
              label={t("totalTokens")}
              value={stats ? fmt(totalTokens) : ""}
              raw={stats ? totalTokens.toLocaleString() : undefined}
              trend={
                stats
                  ? t("totalTokensTrend", { today: fmt(stats.tokens_today) })
                  : undefined
              }
              trendRaw={stats ? stats.tokens_today.toLocaleString() : undefined}
              icon={Coins}
              accentColor="text-accent"
              loading={!stats}
            />
            <StatCard
              label={t("cacheHitRate")}
              value={stats ? `${cacheHitRate.toFixed(1)} %` : ""}
              raw={stats ? `${cacheHitRate.toFixed(2)}%` : undefined}
              icon={Gauge}
              accentColor="text-accent"
              loading={!stats}
            />
          </div>

          <div ref={agentsRef} className="min-w-0 flex-1 min-h-0 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-slate-300">{t("activeAgentsSection")}</h3>
            </div>
            {activeAgents.length === 0 ? (
              <EmptyState icon={Bot} title={t("noAgents")} description={t("noAgentsDesc")} />
            ) : (
              <div className="space-y-2">
                {(() => {
                  const { childrenByParent, getDescendants } = agentTree;

                  /**
                   * 递归渲染单个 agent 节点及其子树。
                   *
                   * - ancestors 用于检测循环 parent 关系，避免无限递归。
                   * - depth 控制缩进和图标（子 agent 用 GitBranch 图标）。
                   * - 折叠状态下显示 "N 个子agent (M 工作中)" 摘要。
                   */
                  function renderAgentNode(
                    agent: Agent,
                    depth: number,
                    ancestors: Set<string> = new Set()
                  ): ReactNode {
                    // 防御循环 parent 链。
                    if (ancestors.has(agent.id)) return null;
                    const childAncestors = new Set(ancestors).add(agent.id);
                    const children = childrenByParent.get(agent.id) || [];
                    const isExpanded = expandedAgents.has(agent.id);
                    const hasChildren = children.length > 0;
                    const isSubagent = depth > 0;
                    const { total: totalDesc, active: activeDesc } = hasChildren
                      ? getDescendants(agent.id)
                      : { total: 0, active: 0 };
                    const toggleExpanded = () =>
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
                          {

}
                          {!hasChildren && !isSubagent && (
                            <span
                              className="w-6 h-6 flex-shrink-0 flex items-center justify-center text-accent/70"
                              aria-hidden="true"
                              title={t("common:noSubagents", "No subagents")}
                            >
                              <CircleDot className="w-4 h-4" strokeWidth={2} />
                            </span>
                          )}
                          {isSubagent && (
                            <GitBranch className="w-3 h-3 text-accent flex-shrink-0" />
                          )}

                          <div className="flex-1 min-w-0">
                            <AgentCard
                              agent={agent}
                              session={sessionsById.get(agent.session_id)}
                              
                              
                              
                              
                              
                              onClick={undefined}
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

                  
                  
                  
                  
                  
                  
                  
                  // 只渲染计算出的可见主 agent 数量；子 agent 作为树的一部分跟随展开。
                  const visibleMains = activeAgents
                    .filter((a) => a.type === "main")
                    .slice(0, visibleAgentCount);

                  // 收集所有已经在树中渲染过的 agent id，避免子 agent 既在树里又在末尾重复出现。
                  const renderedInTree = new Set<string>();
                  for (const mainAgent of visibleMains) {
                    const stack: string[] = [mainAgent.id];
                    while (stack.length) {
                      const id = stack.pop()!;
                      if (renderedInTree.has(id)) continue;
                      renderedInTree.add(id);
                      for (const child of childrenByParent.get(id) || []) {
                        stack.push(child.id);
                      }
                    }
                  }

                  return (
                    <>
                      {visibleMains.map((main) => renderAgentNode(main, 0))}
                      {/* 没有在主 agent 树中的孤立子 agent，单独平铺显示。 */}
                      {activeAgents
                        .filter((a) => a.type === "subagent" && !renderedInTree.has(a.id))
                        .map((agent) => (
                          <div key={agent.id}>
                            <AgentCard
                              agent={agent}
                              session={sessionsById.get(agent.session_id)}
                            />
                          </div>
                        ))}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </div>
  );
}
