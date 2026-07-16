/**
 * @file api.ts
 * @description Defines a set of functions for interacting with the backend API of the agent dashboard application. It includes methods for fetching statistics, managing sessions and agents, retrieving analytics data, handling settings, and managing model pricing. The module abstracts away the details of making HTTP requests and provides a clean interface for the rest of the application to use when communicating with the server.

 */

import type {
  Agent,
  AlertEvent,
  AlertRule,
  Analytics,
  CostResult,
  DashboardEvent,
  Session,
  SessionDrillIn,
  SessionStats,
  Stats,
  TranscriptListResult,
  TranscriptResult,
  WebhookDelivery,
  WebhookProvider,
  WebhookTarget,
  WebhookTestResult,
  WebhookType,
  WorkflowData,
  WorkflowRun,
  WorkflowRunsResponse,
  WorkflowRunDetail,
} from "../lib/types";

const BASE = "/api";

/**
 * Optional dashboard auth token (GHSA-gr74-4xfh-6jw9). Only needed when the
 * operator binds the server to a LAN and sets DASHBOARD_TOKEN; for the default
 * loopback bind there is no token and this returns null (zero-config). Read from
 * an injected global first, then localStorage so a LAN user can set it once.
 */
export function dashboardToken(): string | null {
  try {
    const injected = (globalThis as { __DASHBOARD_TOKEN__?: unknown }).__DASHBOARD_TOKEN__;
    if (typeof injected === "string" && injected) return injected;
    const stored = localStorage.getItem("dashboard_token");
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Shared fetch wrapper used by every method on {@link api}. Prefixes `path`
 * with {@link BASE} ("/api"), attaches the dashboard auth token (if any) as
 * the `x-dashboard-token` header, and normalizes non-2xx responses into a
 * thrown `Error` whose message is the server's `error.message` (falling back
 * to `HTTP <status>` when the body isn't JSON or has no message).
 * @param path Path segment appended to `/api` (should start with "/").
 * @param options Standard `fetch` options; `headers` are merged, not replaced.
 * @returns The parsed JSON response body, typed as `T`.
 */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = dashboardToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { "x-dashboard-token": token } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Typed client for every REST endpoint the dashboard consumes, grouped by
 * resource (mirroring the `server/routes/*.js` file layout). Every method
 * returns a `Promise` resolving to the parsed JSON body via {@link request};
 * on a non-2xx response the promise rejects with an `Error`. Real-time updates
 * arrive separately over the WebSocket (see {@link eventBus}/`useWebSocket`) -
 * this object only covers request/response REST calls.
 */
export const api = {
  /** Lightweight overview counters for the dashboard header. */
  stats: {
    /** GET /api/stats. Sends the browser's UTC offset so `events_today` is
     *  bucketed by the viewer's local midnight, not the server's. */
    get: () => request<Stats>(`/stats?tz_offset=${new Date().getTimezoneOffset()}`),
  },

  /** Session CRUD/read, plus their nested agents/events/transcripts. */
  sessions: {
    /** GET /api/sessions/facets - distinct `cwd` values for the filter dropdown. */
    facets: () => request<{ cwds: string[] }>("/sessions/facets"),
    /** GET /api/sessions - paginated, filterable, sortable session list. */
    list: (params?: {
      status?: string;
      q?: string;
      cwd?: string;
      sort_by?: string;
      sort_desc?: boolean;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.q) qs.set("q", params.q);
      if (params?.cwd) qs.set("cwd", params.cwd);
      if (params?.sort_by) qs.set("sort_by", params.sort_by);
      if (params?.sort_desc !== undefined) qs.set("sort_desc", String(params.sort_desc));
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const queryString = qs.toString();
      return request<{ sessions: Session[]; total: number; limit: number; offset: number }>(
        `/sessions${queryString ? `?${queryString}` : ""}`
      );
    },
    /** GET /api/sessions/:id - one session with its agents, events, and any
     *  Workflow-tool runs launched from it. */
    get: (id: string) =>
      request<{
        session: Session;
        agents: Agent[];
        events: DashboardEvent[];
        workflows: WorkflowRun[];
      }>(`/sessions/${encodeURIComponent(id)}`),
    /** GET /api/sessions/:id/stats - per-session rollups for the detail page. */
    stats: (id: string) => request<SessionStats>(`/sessions/${encodeURIComponent(id)}/stats`),
    /** GET /api/sessions/:id/transcripts - the picker list of available
     *  transcripts (main agent, subagents, compaction markers) for this session. */
    transcripts: (id: string) =>
      request<TranscriptListResult>(`/sessions/${encodeURIComponent(id)}/transcripts`),
    /** GET /api/sessions/:id/transcript - a page of parsed transcript messages.
     *  Paginate with `after`/`before` (JSONL line numbers from the previous
     *  page's `first_line`/`last_line`) rather than `offset` for a live file.
     *  Pass `agent_id`/`run_id` to read a subagent's transcript instead of the
     *  main session's. */
    transcript: (
      id: string,
      params?: {
        agent_id?: string;
        run_id?: string;
        limit?: number;
        offset?: number;
        after?: number;
        before?: number;
      }
    ) => {
      const qs = new URLSearchParams();
      if (params?.agent_id) qs.set("agent_id", params.agent_id);
      if (params?.run_id) qs.set("run_id", params.run_id);
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      if (params?.after != null) qs.set("after", String(params.after));
      if (params?.before != null) qs.set("before", String(params.before));
      const q = qs.toString();
      return request<TranscriptResult>(
        `/sessions/${encodeURIComponent(id)}/transcript${q ? `?${q}` : ""}`
      );
    },
  },

  agents: {
    /** GET /api/agents - agent list, optionally filtered by status/session. */
    list: (params?: { status?: string; session_id?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.session_id) qs.set("session_id", params.session_id);
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{ agents: Agent[] }>(`/agents${q ? `?${q}` : ""}`);
    },
  },

  events: {
    /** GET /api/events - the global cross-session event feed. Array-valued
     *  filters (`event_type`/`tool_name`/`agent_id`) are OR'd server-side via
     *  comma-joined query params. */
    list: (params?: {
      event_type?: string[];
      tool_name?: string[];
      agent_id?: string[];
      session_id?: string | string[];
      q?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams();
      const csv = (v?: string[]) => (v && v.length > 0 ? v.join(",") : undefined);
      const et = csv(params?.event_type);
      const tn = csv(params?.tool_name);
      const ag = csv(params?.agent_id);
      const sid = Array.isArray(params?.session_id) ? csv(params?.session_id) : params?.session_id;
      if (et) qs.set("event_type", et);
      if (tn) qs.set("tool_name", tn);
      if (ag) qs.set("agent_id", ag);
      if (sid) qs.set("session_id", sid);
      if (params?.q) qs.set("q", params.q);
      if (params?.from) qs.set("from", params.from);
      if (params?.to) qs.set("to", params.to);
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.offset != null) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{
        events: DashboardEvent[];
        limit: number;
        offset: number;
        total: number;
      }>(`/events${q ? `?${q}` : ""}`);
    },
    /** GET /api/events/facets - distinct event/tool names for filter dropdowns. */
    facets: () => request<{ event_types: string[]; tool_names: string[] }>("/events/facets"),
  },

  /** Chart-oriented usage analytics for the Analytics page. */
  analytics: {
    /** GET /api/analytics. `tz_offset` shifts the daily buckets to local time,
     *  same convention as {@link api.stats.get}. */
    get: () => request<Analytics>(`/analytics?tz_offset=${new Date().getTimezoneOffset()}`),
  },

  /** Server/DB introspection and destructive maintenance operations for the
   *  Settings page (info, hooks reinstall, data reset, pricing reset, cleanup). */
  settings: {
    /** GET /api/settings/info - DB size/pragmas, hook install status, server
     *  process stats, and transcript-cache stats, all in one call. */
    info: () =>
      request<{
        db: {
          path: string;
          size: number;
          counts: Record<string, number>;
          pragmas: {
            journal_mode: string;
            synchronous: number;
            auto_vacuum: number;
            encoding: string;
            foreign_keys: number;
            busy_timeout: number;
          };
          load_stats: { m5: number; m15: number; h1: number };
        };
        hooks: { installed: boolean; path: string; hooks: Record<string, boolean> };
        server: {
          uptime: number;
          node_version: string;
          platform: string;
          ws_connections: number;
          memory: { rss: number; heapTotal: number; heapUsed: number; external: number };
          cpu_load: number[];
          arch: string;
          total_mem: number;
          free_mem: number;
          cpus: number;
        };
        transcript_cache: {
          size: number;
          maxSize: number;
          hits: number;
          misses: number;
          keys: string[];
        };
      }>("/settings/info"),
    /** Get/set the `~/.claude` root the server reads config from. */
    claudeHome: {
      get: () => request<{ claude_home: string }>("/settings/claude-home"),
      set: (path: string) =>
        request<{ ok: boolean; claude_home: string }>("/settings/claude-home", {
          method: "PUT",
          body: JSON.stringify({ path }),
        }),
    },
    /** POST /api/settings/clear-data - DESTRUCTIVE: wipes sessions/agents/
     *  events/etc. from the dashboard DB. Returns per-table row counts deleted. */
    clearData: () =>
      request<{ ok: boolean; cleared: Record<string, number> }>("/settings/clear-data", {
        method: "POST",
      }),
    /** POST /api/settings/reimport - re-scan `~/.claude/projects` and
     *  backfill anything not already in the DB. */
    reimport: () =>
      request<{ ok: boolean; imported: number; skipped: number; errors: number }>(
        "/settings/reimport",
        { method: "POST" }
      ),
    /** POST /api/settings/reinstall-hooks - re-write the dashboard's Claude
     *  Code hook entries into `~/.claude/settings.json`. */
    reinstallHooks: () =>
      request<{ ok: boolean; hooks: { installed: boolean; hooks: Record<string, boolean> } }>(
        "/settings/reinstall-hooks",
        { method: "POST" }
      ),

    /** Direct download URL for GET /api/settings/export (a full DB dump);
     *  not fetched via {@link request} since it's used as an `<a href>`. */
    exportData: () => `${BASE}/settings/export`,
    /** POST /api/settings/cleanup - DESTRUCTIVE: marks sessions idle longer
     *  than `abandon_hours` as "abandoned", and purges rows older than
     *  `purge_days`. Returns counts of what was abandoned/purged. */
    cleanup: (params: { abandon_hours?: number; purge_days?: number }) =>
      request<{
        ok: boolean;
        abandoned: number;
        purged_sessions: number;
        purged_events: number;
        purged_agents: number;
      }>("/settings/cleanup", { method: "POST", body: JSON.stringify(params) }),
  },

  /** Events-derived workflow intelligence (`get`/`session`) plus Workflow-tool
   *  fleet runs ingested from on-disk journals (`runs`/`run`). */
  workflows: {
    /** GET /api/workflows - the full {@link WorkflowData} panel bundle,
     *  optionally filtered to "active"/"completed" sessions. */
    get: (status?: string) =>
      request<WorkflowData>(`/workflows${status && status !== "all" ? `?status=${status}` : ""}`),
    /** GET /api/workflows/session/:id - single-session drill-in (agent tree,
     *  tool timeline, swim lanes). */
    session: (id: string) =>
      request<SessionDrillIn>(`/workflows/session/${encodeURIComponent(id)}`),
    // Workflow-tool runs (issue #167) - fleets ingested from on-disk journals.
    /** GET /api/workflows/runs - paginated Workflow-tool run list. */
    runs: (params?: { status?: string; session_id?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status && params.status !== "all") qs.set("status", params.status);
      if (params?.session_id) qs.set("session_id", params.session_id);
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.offset != null) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<WorkflowRunsResponse>(`/workflows/runs${q ? `?${q}` : ""}`);
    },
    /** GET /api/workflows/runs/:runId - one run with its inner agents/events. */
    run: (runId: string) =>
      request<WorkflowRunDetail>(`/workflows/runs/${encodeURIComponent(runId)}`),
  },

  /** GET /api/pricing/cost - total cost across every session, priced with
   *  each day's rate (respects time-limited intro pricing). */
  cost: {
    total: () =>
      request<CostResult>(`/pricing/cost?tz_offset=${new Date().getTimezoneOffset()}`),
    /** GET /api/pricing/cost/:sessionId - cost for one session, priced as of
     *  the session's start date. */
    session: (sessionId: string) =>
      request<CostResult>(
        `/pricing/cost/${encodeURIComponent(sessionId)}?tz_offset=${new Date().getTimezoneOffset()}`
      ),
  },

  /** Transcript import: on-disk scan/rescan, an explicit path scan, or a
   *  browser file upload - all three converge on the same {@link ImportResult}
   *  shape and stream progress via the `import.progress` WS message. */
  import: {
    /** GET /api/import/guide - platform-specific instructions and constraints
     *  (default projects dir, supported extensions, upload limits) shown on
     *  first run / in the Import wizard. */
    guide: () =>
      request<{
        platform: string;
        default_projects_dir: string;
        default_projects_dir_display: string;
        default_projects_dir_exists: boolean;
        default_projects_dir_stats: { projects: number; jsonl_files: number };
        archive_command: string;
        supported_extensions: string[];
        max_upload_bytes: number;
        max_upload_files: number;
        steps: { id: string; title: string; body: string }[];
      }>("/import/guide"),
    /** POST /api/import/rescan - re-scan the default projects directory. */
    rescan: () => request<ImportResult>("/import/rescan", { method: "POST" }),
    /** POST /api/import/scan-path - scan an arbitrary directory for
     *  Claude Code project transcripts. */
    scanPath: (path: string) =>
      request<ImportResult>("/import/scan-path", {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
    /** POST /api/import/upload (multipart) - import a set of user-selected
     *  transcript files. Bypasses {@link request} to use `FormData`. */
    upload: async (files: File[]): Promise<ImportResult> => {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      const res = await fetch(`${BASE}/import/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      return res.json();
    },
  },

  /** Alert rule CRUD plus the fired-alert feed and acknowledgement. */
  alerts: {
    /** GET /api/alerts - fired-alert feed, newest first. */
    list: (params?: { unacked?: boolean; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.unacked) qs.set("unacked", "true");
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{
        alerts: AlertEvent[];
        total: number;
        unacked: number;
        limit: number;
        offset: number;
      }>(`/alerts${q ? `?${q}` : ""}`);
    },
    /** POST /api/alerts/:id/ack - acknowledge a single fired alert. */
    ack: (id: number) => request<{ alert: AlertEvent }>(`/alerts/${id}/ack`, { method: "POST" }),
    /** POST /api/alerts/ack-all - acknowledge every unacked alert at once. */
    ackAll: () =>
      request<{ ok: true; acknowledged: number }>("/alerts/ack-all", { method: "POST" }),
    /** CRUD for the alert rule definitions themselves (not the fired events). */
    rules: {
      list: () => request<{ rules: AlertRule[] }>("/alerts/rules"),
      create: (rule: {
        name: string;
        rule_type: AlertRule["rule_type"];
        config: AlertRule["config"];
        enabled?: boolean;
        cooldown_seconds?: number;
      }) =>
        request<{ rule: AlertRule }>("/alerts/rules", {
          method: "POST",
          body: JSON.stringify(rule),
        }),
      update: (
        id: string,
        patch: Partial<Pick<AlertRule, "name" | "config" | "enabled" | "cooldown_seconds">>
      ) =>
        request<{ rule: AlertRule }>(`/alerts/rules/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      remove: (id: string) =>
        request<{ ok: true }>(`/alerts/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
  },

  /** Outbound webhook target CRUD, provider metadata, test sends, and the
   *  per-target delivery log. */
  webhooks: {
    /** GET /api/webhooks - configured targets (secrets/URLs redacted). */
    list: () => request<{ targets: WebhookTarget[] }>("/webhooks"),
    /** GET /api/webhooks/providers - supported provider types and their
     *  form-field schemas, for the "Add webhook" dialog. */
    providers: () => request<{ providers: WebhookProvider[] }>("/webhooks/providers"),
    /** POST /api/webhooks - create a new target. */
    create: (target: {
      name: string;
      type: WebhookType;
      url?: string;
      enabled?: boolean;
      secret?: string;
      headers?: Record<string, string>;
      config?: Record<string, string>;
      rule_ids?: string[];
    }) =>
      request<{ target: WebhookTarget }>("/webhooks", {
        method: "POST",
        body: JSON.stringify(target),
      }),
    update: (
      id: string,
      patch: {
        name?: string;
        url?: string;
        enabled?: boolean;
        secret?: string | null;
        headers?: Record<string, string>;
        config?: Record<string, string>;
        rule_ids?: string[];
      }
    ) =>
      request<{ target: WebhookTarget }>(`/webhooks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    /** DELETE /api/webhooks/:id - remove a target. */
    remove: (id: string) =>
      request<{ ok: true }>(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** POST /api/webhooks/:id/test - send a synchronous test payload; not
     *  recorded in the delivery log. */
    test: (id: string) =>
      request<WebhookTestResult>(`/webhooks/${encodeURIComponent(id)}/test`, { method: "POST" }),
    /** GET /api/webhooks/:id/deliveries - paginated delivery history for one target. */
    deliveries: (id: string, params?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const q = qs.toString();
      return request<{ deliveries: WebhookDelivery[]; limit: number; offset: number }>(
        `/webhooks/${encodeURIComponent(id)}/deliveries${q ? `?${q}` : ""}`
      );
    },
  },
};

/** Result of a transcript import run - returned by `api.import.rescan`,
 *  `scanPath`, and `upload`, and mirrored by the final `import.progress`
 *  WebSocket message (`phase: "complete"`). */
export interface ImportResult {
  ok: boolean;
  /** Which import flow produced this result. */
  source: "default" | "path" | "upload";
  /** Directory that was scanned; present for `source === "path"`. */
  path?: string;
  /** New session/event rows created. */
  imported: number;
  /** Entries already present in the DB, left untouched. */
  skipped: number;
  /** Existing rows updated with data that was missing (e.g. late token usage). */
  backfilled?: number;
  /** Count of files/entries that failed to parse or import. */
  errors: number;
  /** Distinct session ids encountered during the scan. */
  sessions_seen?: number;
  /** Project directories/JSONL files scanned (default/path import). */
  files_scanned?: number;
  /** Files actually received in the multipart request (upload import). */
  files_received?: number;
  /** Total transcript entries successfully parsed. */
  entries_extracted?: number;
  /** Entries skipped during parsing (e.g. malformed lines). */
  entries_skipped?: number;
}
