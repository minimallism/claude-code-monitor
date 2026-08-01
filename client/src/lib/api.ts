import type {
  Agent,
  Analytics,
  ClaudeProcess,
  DashboardEvent,
  ProjectSummary,
  Session,
  SessionStats,
  Stats,
  TranscriptListResult,
  TranscriptResult,
} from "../lib/types";

const BASE = "/api";

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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = dashboardToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { "x-dashboard-token": token } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `HTTP ${response.status}`);
  }
  return response.json();
}

export const api = {
  
  stats: {
    

    get: () => request<Stats>(`/stats?tz_offset=${new Date().getTimezoneOffset()}`),
  },

  
  sessions: {
    
    facets: () => request<{ cwds: string[] }>("/sessions/facets"),
    
    list: (params?: {
      status?: string;
      q?: string;
      cwd?: string;
      sort_by?: string;
      sort_desc?: boolean;
      limit?: number;
      offset?: number;
    }) => {
      const queryParams = new URLSearchParams();
      if (params?.status) queryParams.set("status", params.status);
      if (params?.q) queryParams.set("q", params.q);
      if (params?.cwd) queryParams.set("cwd", params.cwd);
      if (params?.sort_by) queryParams.set("sort_by", params.sort_by);
      if (params?.sort_desc !== undefined) queryParams.set("sort_desc", String(params.sort_desc));
      if (params?.limit) queryParams.set("limit", String(params.limit));
      if (params?.offset) queryParams.set("offset", String(params.offset));
      const queryString = queryParams.toString();
      return request<{ sessions: Session[]; total: number; limit: number; offset: number }>(
        `/sessions${queryString ? `?${queryString}` : ""}`
      );
    },
    

    get: (id: string) =>
      request<{
        session: Session;
        agents: Agent[];
        events: DashboardEvent[];
      }>(`/sessions/${encodeURIComponent(id)}`),
    
    stats: (id: string) => request<SessionStats>(`/sessions/${encodeURIComponent(id)}/stats`),
    

    transcripts: (id: string) =>
      request<TranscriptListResult>(`/sessions/${encodeURIComponent(id)}/transcripts`),
    

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
      const queryParams = new URLSearchParams();
      if (params?.agent_id) queryParams.set("agent_id", params.agent_id);
      if (params?.run_id) queryParams.set("run_id", params.run_id);
      if (params?.limit) queryParams.set("limit", String(params.limit));
      if (params?.offset) queryParams.set("offset", String(params.offset));
      if (params?.after != null) queryParams.set("after", String(params.after));
      if (params?.before != null) queryParams.set("before", String(params.before));
      const queryString = queryParams.toString();
      return request<TranscriptResult>(
        `/sessions/${encodeURIComponent(id)}/transcript${queryString ? `?${queryString}` : ""}`
      );
    },
  },

  agents: {
    
    list: (params?: { status?: string; session_id?: string; limit?: number; offset?: number }) => {
      const queryParams = new URLSearchParams();
      if (params?.status) queryParams.set("status", params.status);
      if (params?.session_id) queryParams.set("session_id", params.session_id);
      if (params?.limit) queryParams.set("limit", String(params.limit));
      if (params?.offset) queryParams.set("offset", String(params.offset));
      const queryString = queryParams.toString();
      return request<{ agents: Agent[] }>(`/agents${queryString ? `?${queryString}` : ""}`);
    },
  },

  analytics: {
    

    get: () => request<Analytics>(`/analytics?tz_offset=${new Date().getTimezoneOffset()}`),
  },

  

  settings: {
    

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
    

    reinstallHooks: () =>
      request<{ ok: boolean; hooks: { installed: boolean; hooks: Record<string, boolean> } }>(
        "/settings/reinstall-hooks",
        { method: "POST" }
      ),

    deleteProject: (encodedCwd: string) =>
      request<{ ok: boolean; deleted: { sessions: number; files: number } }>(
        `/settings/projects/${encodeURIComponent(encodedCwd)}`,
        { method: "DELETE" }
      ),
  },

  

  projects: {
    
    list: () => request<{ projects: ProjectSummary[] }>("/projects"),
  },

  
  processes: {
    
    list: () => request<{ processes: ClaudeProcess[] }>("/processes"),
    kill: (pid: number) => request<{ ok: boolean }>(`/processes/${pid}/kill`, { method: "POST" }),
  },
};
