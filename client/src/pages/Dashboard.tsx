/**
 * @file Dashboard.tsx
 * @description Main dashboard page showing real-time stats and active agents for Claude Code sessions.

 */

import {
  useEffect,
  useState,
  useCallback,
  useSyncExternalStore,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  FolderOpen,
  Bot,
  Zap,
  DollarSign,
  Activity,
  RefreshCw,
  GitBranch,
  ChevronDown,
  ChevronRight,
  CircleDot,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { StatCard } from "../components/StatCard";
import { AgentCard } from "../components/AgentCard";
import { EmptyState } from "../components/EmptyState";
import { Tip } from "../components/Tip";
import { fmt, fmtCost } from "../lib/format";
import type { Stats, Agent, WSMessage, Session, Analytics } from "../lib/types";

export function Dashboard() {
  const navigate = useNavigate();
  const { t } = useTranslation("dashboard");

  const [stats, setStats] = useState<Stats | null>(null);
  const [activeAgents, setActiveAgents] = useState<Agent[]>([]);
  const [totalCost, setTotalCost] = useState<number | null>(null);
  const [allSubagents, setAllSubagents] = useState<Agent[]>([]);
  const [sessionsById, setSessionsById] = useState<Map<string, Session>>(new Map());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  // ResizeObserver — fill available container height per screen size
  const agentsRef = useRef<HTMLDivElement>(null);
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

  const load = useCallback(async () => {
    try {
      const [statsRes, workingRes, waitingRes, costRes, sessionsRes, analyticsRes] = await Promise.all(
        [
          api.stats.get(),
          api.agents.list({ status: "working", limit: 20 }),
          api.agents.list({ status: "waiting", limit: 20 }),
          api.cost.total(),
          api.sessions.list({ status: "active", limit: 100 }),
          api.analytics.get(),
        ]
      );
      setStats(statsRes);
      const active = [...workingRes.agents, ...waitingRes.agents];
      setActiveAgents(active);
      setTotalCost(costRes.total_cost);
      setSessionsById(new Map(sessionsRes.sessions.map((s) => [s.id, s])));
      setAnalytics(analyticsRes);
      setError(null);

      // Fetch all subagents for each active main agent's session
      const activeSessionIds = [
        ...new Set(active.filter((a) => a.type === "main").map((a) => a.session_id)),
      ];
      const subagentResults = await Promise.all(
        activeSessionIds.map((sid) => api.agents.list({ session_id: sid, limit: 100 }))
      );
      const subs = subagentResults.flatMap((r) => r.agents).filter((a) => a.type === "subagent");
      setAllSubagents(subs);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failedLoad"));
    }
  }, [t]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  // Auto-expand agents with active subagents (walk up the full parent chain)
  useEffect(() => {
    const parentsWithActive = new Set<string>();
    for (const a of allSubagents) {
      if (a.parent_agent_id && a.status === "working") {
        parentsWithActive.add(a.parent_agent_id);
      }
    }
    if (parentsWithActive.size === 0) return; // No-op: skip state update entirely

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
      // Only update if there are genuinely new IDs to add
      const newIds = [...toExpand].filter((id) => !prev.has(id));
      if (newIds.length === 0) return prev; // Stable reference - no re-render
      return new Set([...prev, ...newIds]);
    });
  }, [allSubagents]);

  useEffect(() => {
    const debounceRef = { timer: null as ReturnType<typeof setTimeout> | null };
    return eventBus.subscribe((msg: WSMessage) => {
      if (
        msg.type === "agent_created" ||
        msg.type === "agent_updated" ||
        msg.type === "session_created" ||
        msg.type === "session_updated"
      ) {
        // Debounce rapid-fire updates (e.g., 5 agents created in 100ms)
        if (debounceRef.timer) clearTimeout(debounceRef.timer);
        debounceRef.timer = setTimeout(load, 300);
      }
    });
  }, [load]);

  const wsConnected = useSyncExternalStore(eventBus.onConnection, () => eventBus.connected);

  // Memoize agent tree structure to avoid recalculating on every render
  const agentTree = useMemo(() => {
    const childrenByParent = new Map<string, Agent[]>();
    for (const a of allSubagents) {
      if (a.parent_agent_id) {
        const list = childrenByParent.get(a.parent_agent_id) || [];
        list.push(a);
        childrenByParent.set(a.parent_agent_id, list);
      }
    }

    // Pre-compute descendant counts with memoization (avoids exponential recursion)
    const descendantCache = new Map<string, { total: number; active: number }>();
    function getDescendants(id: string): { total: number; active: number } {
      if (descendantCache.has(id)) return descendantCache.get(id)!;
      // Seed a zero sentinel before recursing so a cyclic parent_agent_id
      // (corrupt data) resolves to the cached value instead of looping forever.
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
    // Pre-warm cache for all nodes
    for (const a of allSubagents) getDescendants(a.id);

    return { childrenByParent, getDescendants };
  }, [allSubagents]);

  const totalTokens = analytics
    ? analytics.tokens.total_input + analytics.tokens.total_output + analytics.tokens.total_cache_read + analytics.tokens.total_cache_write
    : 0;

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 mb-2">{t("failedConnect")}</p>
        <p className="text-sm text-gray-500">{error}</p>
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
              <h1 className="text-lg font-semibold text-gray-100">{t("title")}</h1>
              {wsConnected ? (
                <span className="flex items-center gap-1.5 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
                  {t("common:live")}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-[11px] text-gray-400 bg-gray-500/10 border border-gray-500/20 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                  {t("common:offline")}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500">{t("subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={load} className="btn-ghost flex-shrink-0">
            <RefreshCw className="w-4 h-4" /> {t("common:refresh")}
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 shrink-0">
            <StatCard
              label={t("totalSessions")}
              value={stats ? fmt(stats.total_sessions) : ""}
              raw={stats ? stats.total_sessions.toLocaleString() : undefined}
              icon={FolderOpen}
              trend={stats ? `${stats.active_sessions}${t("activeTrend")}` : undefined}
              loading={!stats}
            />
            <StatCard
              label={t("totalAgents")}
              value={stats ? fmt(stats.total_agents) : ""}
              raw={stats ? stats.total_agents.toLocaleString() : undefined}
              icon={Bot}
              accentColor="text-emerald-400"
              loading={!stats}
            />
            <StatCard
              label={t("activeAgents")}
              value={stats ? activeAgents.filter(a => a.type === "main").length : ""}
              icon={Bot}
              accentColor="text-violet-400"
              loading={!stats}
            />
            <StatCard
              label={t("activeSubagents")}
              value={stats ? allSubagents.filter((a) => a.status === "working").length : ""}
              icon={GitBranch}
              accentColor="text-indigo-400"
              loading={!stats}
            />
            <StatCard
              label={t("eventsToday")}
              value={stats ? fmt(stats.events_today) : ""}
              raw={stats ? stats.events_today.toLocaleString() : undefined}
              icon={Zap}
              accentColor="text-yellow-400"
              loading={!stats}
            />
            <StatCard
              label={t("totalEvents")}
              value={stats ? fmt(stats.total_events) : ""}
              raw={stats ? stats.total_events.toLocaleString() : undefined}
              icon={Activity}
              accentColor="text-violet-400"
              loading={!stats}
            />
            <StatCard
              label={t("totalTokens")}
              value={analytics ? fmt(totalTokens) : ""}
              raw={analytics ? totalTokens.toLocaleString() : undefined}
              icon={Zap}
              accentColor="text-blue-400"
              loading={!analytics}
            />
            <StatCard
              label={t("totalCost")}
              value={totalCost !== null ? fmtCost(totalCost) : ""}
              raw={
                totalCost !== null
                  ? `$${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : undefined
              }
              icon={DollarSign}
              accentColor="text-emerald-400"
              loading={totalCost === null}
            />
          </div>

          <div ref={agentsRef} className="min-w-0 flex-1 min-h-0 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-300">{t("activeAgentsSection")}</h3>
            </div>
            {activeAgents.length === 0 ? (
              <EmptyState icon={Bot} title={t("noAgents")} description={t("noAgentsDesc")} />
            ) : (
              <div className="space-y-2">
                {(() => {
                  const { childrenByParent, getDescendants } = agentTree;

                  function renderAgentNode(
                    agent: Agent,
                    depth: number,
                    ancestors: Set<string> = new Set()
                  ): ReactNode {
                    // Guard against a cyclic parent_agent_id (corrupt data) so
                    // the recursive render can't stack-overflow the page.
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
                              className="p-1 text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
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
                          {/* Reserve the chevron column even when this row
                              has no chevron - without this, peer top-level
                              mains would line up at different x positions
                              depending on whether they have subagents,
                              making chevron-having mains look indented
                              like a subagent of the chevron-less main
                              above them. A muted leaf-marker icon fills
                              the slot so the column reads as deliberately
                              empty rather than as a misalignment. */}
                          {!hasChildren && !isSubagent && (
                            <span
                              className="w-6 h-6 flex-shrink-0 flex items-center justify-center text-violet-400/70"
                              aria-hidden="true"
                              title={t("common:noSubagents", "No subagents")}
                            >
                              <CircleDot className="w-4 h-4" strokeWidth={2} />
                            </span>
                          )}
                          {isSubagent && (
                            <GitBranch className="w-3 h-3 text-violet-400 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <AgentCard
                              agent={agent}
                              session={sessionsById.get(agent.session_id)}
                              // Card click always navigates (AgentCard's
                              // default → session details), whether or not it
                              // has children. Expand/collapse is handled solely
                              // by the chevron button, so clicking a parent
                              // (incl. the main agent) no longer toggles.
                              onClick={undefined}
                            />
                          </div>
                        </div>

                        {hasChildren && isExpanded && (
                          <div className="ml-6 mt-1 space-y-1 border-l-2 border-violet-500/20 pl-3">
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
                            className="ml-7 mt-1 text-[11px] text-violet-400 hover:text-violet-300 transition-colors"
                          >
                            {t("common:subagent_label", { count: totalDesc })}
                            {activeDesc > 0 && (
                              <span className="text-emerald-400 ml-1">
                                ({activeDesc} {t("common:active")})
                              </span>
                            )}
                          </button>
                        )}
                      </div>
                    );
                  }

                  // Build the set of agent ids that will be rendered as
                  // descendants under the visible main-agent trees, so the
                  // orphan-subagent block below doesn't render them a
                  // second time at the root. Previously the orphan filter
                  // was `a.type === "subagent"` with no parentage check,
                  // which surfaced every nested subagent twice: once
                  // indented under its main, and once flush at root level.
                  const visibleMains = activeAgents
                    .filter((a) => a.type === "main")
                    .slice(0, visibleAgentCount);
                  const renderedInTree = new Set<string>();
                  for (const m of visibleMains) {
                    const stack: string[] = [m.id];
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
                      {/* Only true orphans: subagents whose ancestor chain
                          isn't already shown in a tree above. */}
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
