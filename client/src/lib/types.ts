export type SessionStatus = "active" | "completed" | "error";

export type AgentStatus = "working" | "waiting" | "completed" | "error";

export type AgentType = "main" | "subagent";

const AWAITING_STATUS = "waiting" as const;
export type EffectiveAgentStatus = AgentStatus | typeof AWAITING_STATUS;
export type EffectiveSessionStatus = SessionStatus | typeof AWAITING_STATUS;

export interface Session {
  
  id: string;
  

  name: string | null;
  status: SessionStatus;
  
  cwd: string | null;
  
  model: string | null;
  
  started_at: string;
  
  ended_at: string | null;
  
  metadata: string | null;
  

  agent_count?: number;
  
  has_working_subagent?: number;
  
  last_activity?: string;
  
  total_tokens?: number;
  turn_count?: number;

  awaiting_input_since?: string | null;
}

export interface Agent {
  
  id: string;
  
  session_id: string;
  

  name: string;
  type: AgentType;
  

  subagent_type: string | null;
  status: AgentStatus;
  

  task: string | null;
  

  current_tool: string | null;
  
  started_at: string;
  
  ended_at: string | null;
  
  updated_at: string;
  

  parent_agent_id: string | null;
  

  metadata: string | null;
  
  awaiting_input_since?: string | null;
}

/**
 * 判断会话是否处于"等待用户输入"状态。
 *
 * 规则：
 * - 必须有 awaiting_input_since 时间戳。
 * - 会话状态必须是 active（completed/error 不应显示 waiting）。
 * - 如果有任何子 agent 仍在工作，则优先显示 active，不显示 waiting。
 */
export function isSessionAwaitingInput(session: Session | undefined | null): boolean {
  return !!session?.awaiting_input_since && session.status === "active" && !(session.has_working_subagent === 1);
}

/**
 * 判断单个 agent 是否处于"等待用户输入"状态。
 * 只有非终态（非 completed/error）的 agent 才会显示 waiting。
 */
export function isAgentAwaitingInput(agent: Agent | undefined | null): boolean {
  if (!agent?.awaiting_input_since) return false;

  return agent.status !== "completed" && agent.status !== "error";
}

/**
 * 返回 agent 在 UI 上应显示的有效状态。
 * 内部状态只有 working/waiting/completed/error，但 UI 会把 awaiting_input 单独映射为一种视觉状态。
 */
export function effectiveAgentStatus(agent: Agent): EffectiveAgentStatus {
  return isAgentAwaitingInput(agent) ? AWAITING_STATUS : agent.status;
}

/**
 * 返回会话在 UI 上应显示的有效状态。
 *
 * 优先级：
 * 1. 只要有任何 agent 在工作（或后端标记 has_working_subagent），显示 active。
 * 2. 否则如果会话在等待用户输入，显示 waiting。
 * 3. 否则回退到 sessions 表中的原始状态。
 */
export function effectiveSessionStatus(session: Session, agents: Agent[] = []): EffectiveSessionStatus {
  const hasWorkingAgent = agents.some((agent) => agent.status === "working") || session.has_working_subagent === 1;

  if (hasWorkingAgent) {
    return "active";
  }

  if (isSessionAwaitingInput(session)) {
    return AWAITING_STATUS;
  }

  return session.status;
}

export interface DashboardEvent {
  
  id: number;
  
  session_id: string;
  

  agent_id: string | null;
  

  event_type: string;
  

  tool_name: string | null;
  
  created_at: string;
}

export interface ClaudeProcess {
  pid: number;
  ppid: number;
  user: string;
  state: string;
  cpu_percent: number;
  mem_percent: number;
  rss_kb: number;
  vsz_kb: number;
  nice: number;
  time: string;
  comm: string;
  args: string;
  cwd: string | null;
}

export interface Stats {
  total_sessions: number;
  
  active_sessions: number;
  
  active_agents: number;
  total_agents: number;
  total_events: number;
  
  events_today: number;
  sessions_today: number;
  tokens_today: number;
  total_tokens_input: number;
  total_tokens_output: number;
  total_tokens_cache_read: number;
  total_tokens_cache_write: number;
  total_projects: number;
  
  ws_connections: number;
  
  agents_by_status: Record<string, number>;
  
  sessions_by_status: Record<string, number>;
}

export interface Analytics {
  
  tokens: {
    total_input: number;
    total_output: number;
    
    total_cache_read: number;
    
    total_cache_write: number;
  };
  
  tokens_by_model: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  }>;
  
  tool_usage: Array<{ tool_name: string; count: number; failures: number; avg_duration_ms: number | null }>;
  
  daily_sessions: Array<{ date: string; count: number }>;
  daily_session_statuses: Array<{ date: string; completed: number; error: number; active: number }>;
  daily_tokens: Array<{
    date: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  }>;
  sessions_today: number;
  
  overview: {
    total_sessions: number;
    active_sessions: number;
    active_agents: number;
    total_agents: number;
    total_events: number;
    avg_session_duration_seconds: number;
    avg_agents_per_session: number;
  };
  agents_by_status: Record<string, number>;
  agent_types: Record<string, number>;
  subagent_types: Array<{ subagent_type: string; count: number }>;
  sessions_by_status: Record<string, number>;
}

export interface WSMessage {
  

  type:
    | "session_created"
    | "session_updated"
    | "agent_created"
    | "agent_updated"
    | "new_event"
    | "ws_connections"
  data:
    | Session
    | Agent
    | DashboardEvent
    | { count: number };
  

  timestamp: string;
}

export interface SessionStats {
  session_id: string;
  total_events: number;
  
  tool_call_attempts: number;
  
  tool_call_success: number;
  
  tool_call_failed: number;
  
  tools_used: Array<{ tool_name: string; count: number }>;
  
  first_event_at: string | null;
  
  last_event_at: string | null;
  
  agents: {
    total: number;
    
    main: number;
    
    subagent: number;
    
    by_status: Record<string, number>;
  };
  
  user_prompt_count: number;
  
  tokens: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
}

export interface ProjectSummary {
  name: string;
  cwd: string;
  encoded_cwd: string;
  session_count: number;
  active_sessions: number;
  total_tokens: number;
  last_activity: string;
  disk_usage: number;
}

export const STATUS_CONFIG: Record<
  EffectiveAgentStatus,
  { labelKey: string; color: string; bg: string; dot: string }
> = {
  working: {
    labelKey: "common:status.working",
    color: "text-status-working",
    bg: "bg-status-working/10 border-status-working/20",
    dot: "bg-status-working",
  },
  waiting: {
    labelKey: "common:status.waiting",
    color: "text-status-waiting",
    bg: "bg-status-waiting/10 border-status-waiting/20",
    dot: "bg-status-waiting",
  },
  completed: {
    labelKey: "common:status.completed",
    color: "text-accent",
    bg: "bg-accent/10 border-accent/20",
    dot: "bg-accent",
  },
  error: {
    labelKey: "common:status.error",
    color: "text-status-error",
    bg: "bg-status-error/10 border-status-error/20",
    dot: "bg-status-error",
  },
};

export interface TranscriptContent {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  
  text?: string;
  
  name?: string;
  
  id?: string;
  

  input?: Record<string, unknown> | { _truncated: string };
  
  output?: string;
  
  is_error?: boolean;
}

export type TranscriptSender = "user" | "assistant" | "orchestrator" | "system" | "tool";

export interface TranscriptMessage {
  

  type: "user" | "assistant" | "session_event";
  
  sender?: TranscriptSender;
  
  timestamp: string | null;
  content: TranscriptContent[];
  
  model?: string;
  
  usage?: {
    input_tokens: number;
    output_tokens: number;
    
    cache_read_input_tokens?: number;
    
    cache_creation_input_tokens?: number;
  };
  

  event_kind?: "rename";
  
  title?: string;
}

export interface TranscriptResult {
  messages: TranscriptMessage[];
  

  total: number;
  
  has_more: boolean;
  

  last_line: number;
  
  first_line: number;
}

export interface TranscriptInfo {
  

  id: string;
  
  name: string;
  type: "main" | "subagent" | "compaction";
  subagent_type?: string | null;
  

  has_transcript: boolean;
  

  db_agent_id?: string | null;
}

export interface TranscriptListResult {
  transcripts: TranscriptInfo[];
}

export const SESSION_STATUS_CONFIG: Record<
  EffectiveSessionStatus,
  { labelKey: string; color: string; bg: string; dot: string }
> = {
  active: {
    labelKey: "common:status.active",
    color: "text-status-working",
    bg: "bg-status-working/10 border-status-working/20",
    dot: "bg-status-working",
  },
  waiting: {
    labelKey: "common:status.waiting",
    color: "text-status-waiting",
    bg: "bg-status-waiting/10 border-status-waiting/20",
    dot: "bg-status-waiting",
  },
  completed: {
    labelKey: "common:status.completed",
    color: "text-accent",
    bg: "bg-accent/10 border-accent/20",
    dot: "bg-accent",
  },
  error: {
    labelKey: "common:status.error",
    color: "text-status-error",
    bg: "bg-status-error/10 border-status-error/20",
    dot: "bg-status-error",
  },

};
