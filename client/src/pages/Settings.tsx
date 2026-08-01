import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Settings as SettingsIcon,
  Plug,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RotateCcw,
  RefreshCw,
  Terminal,
  Power,
} from "lucide-react";
import { api } from "../lib/api";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { ConfirmModal } from "../components/ConfirmModal";
import type { ClaudeProcess } from "../lib/types";

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d > 0 ? `${d}d` : "", h > 0 ? `${h}h` : "", m > 0 ? `${m}m` : ""].filter(Boolean).join(" ") || "<1m";
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function Settings() {
  const { t } = useTranslation("hooksManager");
  const { t: tnav } = useTranslation("nav");
  const { t: tc } = useTranslation("settings");
  const { t: tcommon } = useTranslation("common");
  const wsConnected = useConnectionStatus();

  const [processes, setProcesses] = useState<ClaudeProcess[]>([]);
  const [procLoading, setProcLoading] = useState(true);
  const [sysInfo, setSysInfo] = useState<{
    server: { uptime: number; memory: { rss: number } };
    db: { size: number; path: string };
    hooks: { installed: boolean; path: string; hooks: Record<string, boolean> };
  } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{
    key: string; message: string; isError: boolean;
  } | null>(null);
  const [killTarget, setKillTarget] = useState<ClaudeProcess | null>(null);
  const procTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!actionResult) return;
    const timeout = setTimeout(() => setActionResult(null), 5000);
    return () => clearTimeout(timeout);
  }, [actionResult]);

  const loadSysInfo = useCallback(async () => {
    try {
      const res = await api.settings.info();
      setSysInfo({ server: res.server, db: res.db, hooks: res.hooks });
    } catch { /* ignore */ }
  }, []);

  const loadProcesses = useCallback(async () => {
    try {
      const res = await api.processes.list();
      setProcesses(res.processes);
    } catch { /* ignore */ } finally {
      setProcLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSysInfo();
    loadProcesses();
    const si = setInterval(loadSysInfo, 30000);
    const pp = setInterval(loadProcesses, 10000);
    procTimerRef.current = pp;
    return () => {
      clearInterval(si);
      if (procTimerRef.current) clearInterval(procTimerRef.current);
    };
  }, [loadSysInfo, loadProcesses]);

  const runAction = async (key: string, fn: () => Promise<string>) => {
    setActionLoading(key);
    setActionResult(null);
    try {
      const message = await fn();
      setActionResult({ key, message, isError: false });
      await loadSysInfo();
    } catch (err) {
      setActionResult({
        key,
        message: err instanceof Error ? err.message : "Unknown error",
        isError: true,
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleReinstallHooks = () =>
    runAction("hooks", async () => {
      const res = await api.settings.reinstallHooks();
      return res.ok ? tc("hooks.success") : tc("hooks.failed");
    });

  const handleKill = async () => {
    if (!killTarget) return;
    const pid = killTarget.pid;
    setKillTarget(null);
    await runAction(`kill-${pid}`, async () => {
      await api.processes.kill(pid);
      await loadProcesses();
      return t("kill.success", { pid });
    });
  };

  const actionBanner = (keys: string[]) => {
    const match = actionResult && keys.includes(actionResult.key) ? actionResult : null;
    if (!match) return null;
    return (
      <div
        className={`px-3 py-2 rounded-lg text-xs ${
          match.isError
            ? "bg-status-error/10 border border-status-error/20 text-status-error"
            : "bg-status-working/10 border border-status-working/20 text-status-working"
        }`}
      >
        {match.message}
      </div>
    );
  };

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
          <SettingsIcon className="w-4.5 h-4.5 text-accent" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-100">{tnav("settings")}</h1>
            {wsConnected ? (
              <span className="flex items-center gap-1.5 text-[11px] text-status-working bg-status-working/10 border border-status-working/20 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-status-working animate-pulse-dot" />
                {tcommon("live")}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400 bg-slate-500/10 border border-slate-500/20 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                {tcommon("offline")}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">{t("subtitle")}</p>
        </div>
      </div>

      {/* 系统信息条 */}
      {sysInfo && (
        <div className="card p-3">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-status-working/70" />
              <span className="text-xs text-slate-500">{t("uptime")}</span>
              <span className="text-xs font-mono text-slate-200">{formatDuration(Math.floor(sysInfo.server.uptime))}</span>
            </div>
            <div className="w-px h-4 bg-white/5" />
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/70" />
              <span className="text-xs text-slate-500">{t("memory")}</span>
              <span className="text-xs font-mono text-slate-200">{fmtSize(sysInfo.server.memory.rss)}</span>
            </div>
            <div className="w-px h-4 bg-white/5" />
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/70" />
              <span className="text-xs text-slate-500">{t("dbSize")}</span>
              <span className="text-xs font-mono text-slate-200">{fmtSize(sysInfo.db.size)}</span>
              <span className="text-slate-600 mx-1">·</span>
              <span className="text-xs font-mono text-slate-500">{sysInfo.db.path}</span>
            </div>
          </div>
        </div>
      )}

      {/* Hooks 状态卡片 */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Plug className="w-4 h-4 text-slate-500" />
              {tc("hooks.title")}
            </h3>
            <p className="text-xs text-slate-500 mt-1">{tc("hooks.description")}</p>
          </div>
          <button
            onClick={handleReinstallHooks}
            disabled={actionLoading !== null}
            className="btn-ghost text-xs disabled:opacity-50"
          >
            {actionLoading === "hooks" ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            {tc("hooks.reinstall")}
          </button>
        </div>

        {actionBanner(["hooks"])}

        {sysInfo && (
          <>
            <div className="flex items-center gap-3">
              {sysInfo.hooks.installed ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-working bg-status-working/10 border border-status-working/20 px-2.5 py-1 rounded-full">
                  <CheckCircle className="w-3.5 h-3.5" /> {tc("hooks.allInstalled")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-waiting bg-status-waiting/10 border border-status-waiting/20 px-2.5 py-1 rounded-full">
                  <AlertTriangle className="w-3.5 h-3.5" /> {tc("hooks.incomplete")}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
              {Object.entries(sysInfo.hooks.hooks).map(([hook, active]) => (
                <div
                  key={hook}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-surface-2"
                >
                  {active ? (
                    <CheckCircle className="w-3 h-3 text-status-working flex-shrink-0" />
                  ) : (
                    <XCircle className="w-3 h-3 text-status-error flex-shrink-0" />
                  )}
                  <span className="text-slate-400 truncate">{hook}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-600 font-mono truncate">{sysInfo.hooks.path}</p>
          </>
        )}
      </div>

      {/* Claude 进程列表 */}
      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-slate-500" />
            {t("processList")}
          </h3>
          {!procLoading && (
            <span className="text-xs text-slate-500">
              {processes.length} {t("processCount")}
            </span>
          )}
        </div>
        {procLoading ? (
          <div className="text-sm text-slate-500 py-4 text-center">{t("loading")}</div>
        ) : processes.length === 0 ? (
          <div className="text-sm text-slate-600 py-4 text-center">{t("noProcesses")}</div>
        ) : (
          <div className="space-y-1 overflow-x-auto">
            {/* 表头 */}
            <div className="flex items-center gap-5 px-3 py-1.5 text-[10px] text-slate-600 uppercase tracking-wider">
              <span className="w-14 shrink-0 text-center">{t("pid")}</span>
              <span className="w-10 shrink-0 text-center">{t("user")}</span>
              <span className="w-10 shrink-0 text-center">{t("state")}</span>
              <span className="w-12 shrink-0 text-center">{t("cpu")}</span>
              <span className="w-16 shrink-0 text-center">{t("processMemory")}</span>
              <span className="w-36 shrink-0">{t("cwd")}</span>
              <span className="w-40 shrink-0">{t("command")}</span>
              <span className="w-8 shrink-0 text-center">{t("action")}</span>
            </div>
            {processes.map((p) => (
              <div
                key={p.pid}
                className="flex items-center gap-5 bg-surface-2 rounded-lg px-3 py-2 text-xs hover:bg-surface-1/50 transition-colors whitespace-nowrap"
              >
                <span className="font-mono text-slate-400 w-14 shrink-0 text-center select-all">{p.pid}</span>
                <span className="text-slate-500 w-10 shrink-0 text-center">{p.user}</span>
                <span className={`w-10 shrink-0 font-mono text-[11px] text-center capitalize ${
                  p.state === "running" ? "text-status-working" : p.state === "sleeping" ? "text-status-waiting" : "text-slate-500"
                }`}>
                  {p.state}
                </span>
                <span className="text-slate-400 w-12 shrink-0 font-mono text-center">{p.cpu_percent.toFixed(1)}</span>
                <span className="text-slate-300 w-16 shrink-0 font-mono text-center">{p.rss_kb ? fmtSize(p.rss_kb * 1024) : "-"}</span>
                <span className="text-slate-500 w-36 shrink-0 font-mono text-[11px] truncate" title={p.cwd ?? undefined}>{p.cwd || "-"}</span>
                <span className="text-slate-300 w-40 shrink-0 font-mono text-[11px] truncate" title={p.args}>{p.args}</span>
                <span className="w-8 shrink-0 text-center">
                  <button
                    onClick={() => setKillTarget(p)}
                    disabled={actionLoading?.startsWith("kill-")}
                    className="p-1 rounded-md hover:bg-status-error/10 text-slate-500 hover:text-status-error transition-colors disabled:opacity-50"
                    title={t("kill.title")}
                  >
                    <Power className="w-3.5 h-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {actionResult?.key.startsWith("kill-") && (
        <div
          className={`px-3 py-2 rounded-lg text-xs ${
            actionResult.isError
              ? "bg-status-error/10 border border-status-error/20 text-status-error"
              : "bg-status-working/10 border border-status-working/20 text-status-working"
          }`}
        >
          {actionResult.message}
        </div>
      )}

      <ConfirmModal
        open={killTarget !== null}
        title={t("kill.confirmTitle")}
        message={killTarget ? t("kill.confirmMessage", { pid: killTarget.pid, cwd: killTarget.cwd || "-" }) : ""}
        confirmLabel={t("kill.confirm")}
        cancelLabel={t("kill.cancel")}
        onConfirm={handleKill}
        onCancel={() => setKillTarget(null)}
        destructive
        busy={actionLoading?.startsWith("kill-")}
      />
    </div>
  );
}
