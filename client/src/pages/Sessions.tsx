import { useEffect, useState, useCallback, useSyncExternalStore, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Files,
  Search,
  ChevronRight,
  ChevronDown,
  ArrowUpDown,
  Inbox,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { SessionStatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { TableRowSkeleton } from "../components/Skeleton";
import { formatDateTime, formatDuration, truncate, fmt } from "../lib/format";
import { effectiveSessionStatus, isSessionAwaitingInput } from "../lib/types";
import type { Session, DashboardEvent } from "../lib/types";

const PAGE_SIZE = 10;

export function Sessions() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation("sessions");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const filter = searchParams.get("status") || "";
  const setFilter = useCallback((value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("status", value);
      else next.delete("status");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  const [cwd, setCwd] = useState(searchParams.get("cwd") || "");
  const [sortBy, setSortBy] = useState("time");
  const [sortDesc, setSortDesc] = useState(true);
  const sortByRef = useRef(sortBy);
  const sortDescRef = useRef(sortDesc);
  useEffect(() => { sortByRef.current = sortBy; }, [sortBy]);
  useEffect(() => { sortDescRef.current = sortDesc; }, [sortDesc]);
  const [directories, setDirectories] = useState<string[]>([]);

  const handleSort = useCallback((field: string) => {
    if (sortByRef.current === field) {
      setSortDesc((d) => !d);
    } else {
      setSortBy(field);
      setSortDesc(true);
    }
  }, []);

  function SortHeader({
    field,
    align = "left",
    children,
  }: {
    field: string;
    align?: "left" | "center";
    children: React.ReactNode;
  }) {
    const active = sortBy === field;
    return (
      <th
        onClick={() => handleSort(field)}
        className={`px-5 py-3 text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap cursor-pointer hover:text-slate-300 ${
          active ? "text-slate-200" : "text-slate-500"
        } ${align === "center" ? "text-center" : "text-left"}`}
      >
        <div className={`flex items-center gap-1 ${align === "center" ? "justify-center" : ""}`}>
          {children}
          {active ? (
            <ChevronDown className={`w-3 h-3 transition-transform ${sortDesc ? "" : "rotate-180"}`} />
          ) : (
            <ArrowUpDown className="w-3 h-3 text-slate-600" />
          )}
        </div>
      </th>
    );
  }

  const FILTER_OPTIONS: Array<{ label: string; value: string }> = [
    { label: t("filterAll"), value: "" },
    { label: t("filterActive"), value: "active" },
    { label: t("filterWaiting"), value: "waiting" },
    { label: t("filterCompleted"), value: "completed" },
    { label: t("filterError"), value: "error" },
  ];

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (cwd) next.set("cwd", cwd);
      else next.delete("cwd");
      return next;
    }, { replace: true });
  }, [cwd, setSearchParams]);

  useEffect(() => {
    api.sessions
      .facets()
      .then((res) => {
        setDirectories(res.cwds);
      })
      .catch(console.error);
  }, []);

  const load = useCallback(async () => {
    try {
      if (filter === "waiting" || filter === "active") {
        const res = await api.sessions.list({
          status: "active",
          q: search || undefined,
          cwd: cwd || undefined,
          sort_by: sortBy,
          sort_desc: sortDesc,
          limit: 10000,
          offset: 0,
        });
        const filtered = res.sessions.filter((s) =>
          filter === "waiting" ? isSessionAwaitingInput(s) : !isSessionAwaitingInput(s)
        );
        setTotal(filtered.length);
        setSessions(filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
        return;
      }
      const params: {
        status?: string;
        q?: string;
        cwd?: string;
        sort_by?: string;
        sort_desc?: boolean;
        limit: number;
        offset: number;
      } = {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort_by: sortBy,
        sort_desc: sortDesc,
      };
      if (filter) params.status = filter;
      if (search) params.q = search;
      if (cwd) params.cwd = cwd;
      const res = await api.sessions.list(params);
      setSessions(res.sessions);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [filter, search, cwd, sortBy, sortDesc, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [filter, search, cwd, sortBy, sortDesc]);

  useEffect(() => {
    const debounceRef = { timer: null as ReturnType<typeof setTimeout> | null };
    return eventBus.subscribe((msg) => {
      if (msg.type === "session_created" || msg.type === "session_updated") {
        if (debounceRef.timer) clearTimeout(debounceRef.timer);
        debounceRef.timer = setTimeout(load, 300);
        return;
      }
      if (msg.type === "new_event") {
        const ev = msg.data as DashboardEvent;
        if (ev.event_type === "Stop" || ev.event_type === "SessionEnd") {
          if (debounceRef.timer) clearTimeout(debounceRef.timer);
          debounceRef.timer = setTimeout(load, 300);
        }
      }
    });
  }, [load]);

  useEffect(() => {
    return eventBus.onConnection((connected) => {
      if (connected) load();
    });
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const paged = sessions;
  const filtered = sessions;

  const wsConnected = useSyncExternalStore(eventBus.onConnection, () => eventBus.connected);

  return (
    <div className="animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
            <Files className="w-4.5 h-4.5 text-accent" />
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
            <p className="text-xs text-slate-500 flex items-center gap-2">
              {t("subtitle")}
              <span className="text-slate-600">·</span>
              {t("sessionCount", { count: total })}
              {filter ? ` ${filter}` : ""}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap lg:flex-nowrap items-center gap-3 mb-6 bg-surface-2/40 p-2 rounded-xl border border-border w-full">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="input w-full pl-10"
          />
        </div>

        <div className="relative flex-[0.65] min-w-[160px]">
          <select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="input w-full text-ellipsis bg-surface-1 pr-9 appearance-none cursor-pointer"
          >
            <option value="">All Directories</option>
            {directories.map((d) => (
              <option key={d} value={d} title={d}>
                {truncate(d, 30)}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
        </div>

        <div className="flex gap-1 bg-surface-1 rounded-lg p-1 border border-border ml-auto shrink-0">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                filter === opt.value
                  ? "bg-surface-4 text-slate-200"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {!loading && filtered.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t("noSessions")}
          description={search || filter || cwd ? t("noSessionsDesc") : t("noSessionsHint")}
        />
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                    {t("tableSession")}
                  </th>
                  <th className="px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider text-center whitespace-nowrap">
                    {t("tableStatus")}
                  </th>
                  <SortHeader field="time">{t("tableLastActive")}</SortHeader>
                  <SortHeader field="duration">{t("tableDuration")}</SortHeader>
                  <SortHeader field="turns" align="center">{t("tableTurns")}</SortHeader>
                  <SortHeader field="tokens" align="center">{t("tableCost")}</SortHeader>
                  <th className="px-5 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                    {t("tableDirectory")}
                  </th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && paged.length === 0
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <TableRowSkeleton
                        key={`sk-${i}`}
                        columns={8}
                        widths={["w-48", "w-20", "w-32", "w-24", "w-20", "w-24", "w-44", "w-4"]}
                      />
                    ))
                  : null}
                {paged.map((session) => (
                  <tr
                    key={session.id}
                    onClick={() => navigate(`/sessions/${session.id}`)}
                    className="hover:bg-surface-4 transition-colors cursor-pointer group"
                  >
                    <td className="px-5 py-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-slate-200">
                            {session.name || `${t("defaultName")}${session.id.slice(0, 8)}`}
                          </p>
                          
                        </div>
                        <p className="text-[11px] text-slate-600 font-mono">
                          {session.id}
                        </p>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center whitespace-nowrap">
                      <SessionStatusBadge status={effectiveSessionStatus(session)} />
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-400 whitespace-nowrap">
                      {formatDateTime(session.last_activity || session.started_at)}
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-400 font-mono whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {formatDuration(session.started_at, session.ended_at || new Date().toISOString())}
                        {session.status === "active" && (
                          <span className="w-1.5 h-1.5 rounded-full bg-status-working animate-pulse" aria-hidden="true" />
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-400 text-center whitespace-nowrap">
                      {session.turn_count ?? "-"}
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-400 font-mono text-center whitespace-nowrap">
                      {session.total_tokens != null && session.total_tokens > 0 ? fmt(session.total_tokens) : "-"}
                    </td>
                    <td
                      className="px-5 py-4 text-[11px] text-slate-500 font-mono"
                      title={session.cwd || undefined}
                    >
                      {session.cwd ? truncate(session.cwd, 30) : "-"}
                    </td>
                    <td className="px-3 py-4 whitespace-nowrap">
                      <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-colors" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 px-1">
              <span className="text-xs text-slate-500">
                {t("common:pagination.showing", {
                  from: page * PAGE_SIZE + 1,
                  to: Math.min((page + 1) * PAGE_SIZE, total),
                  total,
                })}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t("common:pagination.previous")}
                </button>
                <span className="px-3 py-1.5 text-xs text-slate-500">
                  {page + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-2 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t("common:pagination.next")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
