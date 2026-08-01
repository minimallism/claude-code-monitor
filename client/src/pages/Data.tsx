import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Database,
  FolderKanban,
  Trash2,
  XCircle,
  Copy,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { api } from "../lib/api";
import { fmt, fmtSize, truncate, formatDateTime } from "../lib/format";
import { Skeleton } from "../components/Skeleton";
import { ConfirmModal } from "../components/ConfirmModal";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import type { ProjectSummary } from "../lib/types";

export function Data() {
  const navigate = useNavigate();
  const { t } = useTranslation("settings");
  const { t: tnav } = useTranslation("nav");
  const { t: tc } = useTranslation("common");
  const wsConnected = useConnectionStatus();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; msg: string; isError: boolean } | null>(null);
  const [confirmState, setConfirmState] = useState<{
    mode: "single" | "all";
    name?: string;
    encodedCwd?: string;
  } | null>(null);
  const [sortBy, setSortBy] = useState<"disk_usage" | "session_count" | "token_usage" | "last_activity">("last_activity");
  const [sortDesc, setSortDesc] = useState(true);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const copyPath = async (cwd: string) => {
    try {
      await navigator.clipboard.writeText(cwd);
      setCopiedPath(cwd);
      setTimeout(() => setCopiedPath(null), 2000);
    } catch {}
  };

  const sortedProjects = useMemo(() => {
    const list = [...projects];
    list.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "disk_usage") cmp = a.disk_usage - b.disk_usage;
      else if (sortBy === "session_count") cmp = a.session_count - b.session_count;
      else if (sortBy === "token_usage") cmp = (a.total_tokens ?? 0) - (b.total_tokens ?? 0);
      else if (sortBy === "last_activity") cmp = a.last_activity.localeCompare(b.last_activity);
      return sortDesc ? -cmp : cmp;
    });
    return list;
  }, [projects, sortBy, sortDesc]);

  const totals = useMemo(() => ({
    sessions: sortedProjects.reduce((s, p) => s + p.session_count, 0),
    disk: sortedProjects.reduce((s, p) => s + p.disk_usage, 0),
    tokens: sortedProjects.reduce((s, p) => s + (p.total_tokens ?? 0), 0),
  }), [sortedProjects]);

  const toggleSort = (field: typeof sortBy) => {
    if (sortBy === field) {
      setSortDesc((d) => !d);
    } else {
      setSortBy(field);
      setSortDesc(true);
    }
  };

  const loadProjects = useCallback(async () => {
    try {
      const res = await api.projects.list();
      setProjects(res.projects);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleDelete = async (name: string, encodedCwd: string) => {
    setConfirmState({ mode: "single", name, encodedCwd });
  };

  const confirmDelete = async () => {
    if (!confirmState) return;
    setConfirmState(null);
    const isAll = confirmState.mode === "all";

    if (isAll) {
      for (const p of projects) {
        setDeleting(p.encoded_cwd);
        try {
          await api.settings.deleteProject(p.encoded_cwd);
        } catch {
          break;
        }
      }
      setDeleting(null);
      loadProjects();
      setResult({ key: "all", msg: t("deleteAllSuccess"), isError: false });
    } else {
      const { encodedCwd } = confirmState;
      if (!encodedCwd) return;
      setDeleting(encodedCwd);
      setResult(null);
      try {
        const res = await api.settings.deleteProject(encodedCwd);
        setResult({
          key: encodedCwd,
          msg: t("deleteSuccess", {
            sessions: res.deleted.sessions,
            files: res.deleted.files,
          }),
          isError: false,
        });
        loadProjects();
      } catch (err) {
        setResult({
          key: encodedCwd,
          msg: err instanceof Error ? err.message : t("deleteFailed"),
          isError: true,
        });
      } finally {
        setDeleting(null);
      }
    }
  };

  const handleDeleteAll = async () => {
    if (projects.length === 0) return;
    setConfirmState({ mode: "all" });
  };

  return (
    <div className="animate-fade-in space-y-8">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
          <Database className="w-4.5 h-4.5 text-accent" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-100">{tnav("data")}</h1>
            {wsConnected ? (
              <span className="flex items-center gap-1.5 text-[11px] text-status-working bg-status-working/10 border border-status-working/20 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-status-working animate-pulse-dot" />
                {tc("live")}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400 bg-slate-500/10 border border-slate-500/20 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                {tc("offline")}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">{t("cleanupDesc")}</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-status-error/10 flex items-center justify-center">
            <Trash2 className="w-4 h-4 text-status-error" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-slate-200">{t("cleanupTitle")}</h2>
            <p className="text-[11px] text-slate-600 mt-0.5">{t("cleanupPath", { path: "~/.claude/projects/" })}</p>
          </div>
        </div>

        {result && (
          <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs ${
            result.isError
              ? "bg-status-error/10 border border-status-error/20 text-status-error"
              : "bg-status-working/10 border border-status-working/20 text-status-working"
          }`}>
            {result.isError ? <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> : null}
            {result.msg}
          </div>
        )}

        {loading ? (
          <div className="card p-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="w-6 h-6" rounded="md" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-20 ml-auto" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="card p-8 text-center">
            <FolderKanban className="w-10 h-10 text-slate-600 mx-auto mb-2" />
            <p className="text-sm text-slate-500">{t("noProjects")}</p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                {t("projectsList")} ({projects.length})
                <span className="text-slate-600 mx-1.5">·</span>
                <span className="text-slate-500 normal-case font-mono">{totals.sessions} {t("common:sessions")}</span>
                <span className="text-slate-600 mx-1.5">·</span>
                <span className="text-slate-500 normal-case font-mono">{fmt(totals.tokens)} Token</span>
                <span className="text-slate-600 mx-1.5">·</span>
                <span className="text-slate-500 normal-case font-mono">{fmtSize(totals.disk)}</span>
              </span>
              {projects.length > 1 && (
                <button
                  onClick={handleDeleteAll}
                  disabled={deleting !== null}
                  className="btn-ghost text-xs text-status-error hover:text-status-error/90 disabled:opacity-40"
                >
                  <Trash2 className="w-3 h-3" />
                  {t("deleteAll")}
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b border-border text-[11px] text-slate-500 uppercase tracking-wider">
                    <th className="text-left px-5 py-2.5 font-medium">{t("project")}</th>
                    <th className="text-center px-3 py-2.5 font-medium cursor-pointer select-none hover:text-slate-300" onClick={() => toggleSort("session_count")}>
                      <span className="inline-flex items-center gap-1 justify-center">
                        {t("sessionCount")}
                        {sortBy === "session_count" ? (
                          sortDesc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </span>
                    </th>
                    <th className="text-center px-3 py-2.5 font-medium cursor-pointer select-none hover:text-slate-300" onClick={() => toggleSort("token_usage")}>
                      <span className="inline-flex items-center gap-1 justify-center">
                        {t("tokenUsage")}
                        {sortBy === "token_usage" ? (
                          sortDesc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </span>
                    </th>
                    <th className="text-center px-3 py-2.5 font-medium cursor-pointer select-none hover:text-slate-300" onClick={() => toggleSort("disk_usage")}>
                      <span className="inline-flex items-center gap-1 justify-center">
                        {t("diskUsage")}
                        {sortBy === "disk_usage" ? (
                          sortDesc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </span>
                    </th>
                    <th className="text-center px-3 py-2.5 font-medium cursor-pointer select-none hover:text-slate-300" onClick={() => toggleSort("last_activity")}>
                      <span className="inline-flex items-center gap-1">
                        {t("lastActivity")}
                        {sortBy === "last_activity" ? (
                          sortDesc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </span>
                    </th>
                    <th className="w-10 px-2 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sortedProjects.map((project) => (
                    <tr
                      key={project.encoded_cwd}
                      onClick={() => navigate(`/sessions?cwd=${encodeURIComponent(project.cwd)}`)}
                      className="hover:bg-surface-4 transition-colors cursor-pointer group"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-md bg-accent/10 flex items-center justify-center flex-shrink-0">
                            <FolderKanban className="w-3.5 h-3.5 text-accent" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {project.active_sessions > 0 ? (
                                <span className="w-1.5 h-1.5 rounded-full bg-status-working animate-pulse-dot flex-shrink-0" title={tc("active")} />
                              ) : (
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 flex-shrink-0" title={tc("idle")} />
                              )}
                              <p className="text-sm font-medium text-slate-200 truncate">{project.name}</p>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <p className="text-[11px] text-slate-600 font-mono truncate max-w-[240px]" title={project.cwd}>{truncate(project.cwd, 36)}</p>
                              <button
                                onClick={(e) => { e.stopPropagation(); copyPath(project.cwd); }}
                                className="text-slate-600 hover:text-slate-400 transition-colors flex-shrink-0"
                                title={t("copyPath")}
                              >
                                {copiedPath === project.cwd ? (
                                  <span className="text-[10px] text-status-working">{tc("copied")}</span>
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="text-center px-3 py-3 text-xs font-mono text-slate-400">
                        <div className="inline-flex items-baseline justify-center">
                          <span className="tabular-nums text-right min-w-[3ch]">{project.session_count}</span>
                          <span
                            className={`tabular-nums text-left min-w-[4ch] ml-1 ${
                              project.active_sessions > 0 ? "text-status-working" : "invisible"
                            }`}
                          >
                            {project.active_sessions > 0 ? `(${project.active_sessions})` : "(0)"}
                          </span>
                        </div>
                      </td>
                      <td className="text-center px-3 py-3 text-xs text-slate-400 font-mono">{fmt(project.total_tokens ?? 0)}</td>
                      <td className="text-center px-3 py-3 text-xs text-slate-400 font-mono">{fmtSize(project.disk_usage)}</td>
                      <td className="text-center px-3 py-3 text-[11px] text-slate-400 whitespace-nowrap">{formatDateTime(project.last_activity)}</td>
                      <td className="px-2 py-3 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(project.name, project.encoded_cwd); }}
                          disabled={deleting !== null}
                          className="btn-ghost text-xs text-status-error hover:text-status-error/90 disabled:opacity-40 px-2"
                        >
                          {deleting === project.encoded_cwd ? (
                            <span className="w-3.5 h-3.5 border-2 border-status-error border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={confirmState !== null}
        title={confirmState?.mode === "all" ? t("confirmDeleteAllTitle") : t("confirmDeleteProjectTitle")}
        message={confirmState?.mode === "all" ? t("confirmDeleteAll", { count: projects.length }) : t("confirmDeleteProject", { project: confirmState?.name ?? "" })}
        confirmLabel={tc("confirm")}
        cancelLabel={tc("cancel")}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
