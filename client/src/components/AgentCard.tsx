import { useTranslation } from "react-i18next";
import { Bot, GitBranch, Clock, Wrench, Cpu } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AgentStatusBadge } from "./StatusBadge";
import { effectiveAgentStatus, isAgentAwaitingInput } from "../lib/types";
import type { Agent, Session } from "../lib/types";
import { formatDuration, timeAgo, formatModelName, pathBasename } from "../lib/format";

/**
 * 拼接主 agent 的显示名称。
 * agent.name 通常是 "Main Agent - xxx" 形式；如果 session 已经有真实名称，
 * 则保留 "Main Agent" 前缀并替换后面的描述，避免重复显示 "Main Agent - Session xxx"。
 */
function mainAgentDisplayName(agentName: string, realSessionName: string): string {
  if (!realSessionName) return agentName;
  const sep = agentName.indexOf(" - ");
  return sep >= 0 ? `${agentName.slice(0, sep)} - ${realSessionName}` : agentName;
}

/**
 * AgentCard 组件属性。
 */
interface AgentCardProps {
  agent: Agent;
  session?: Session;
  label?: string;
  onClick?: () => void;
}

/**
 * Agent 卡片组件。
 *
 * 用于首页、会话详情页等位置展示单个 agent 的状态、模型、工具、运行时长等关键信息。
 * 主 agent 会显示会话名称与轮次数，子 agent 显示类型/标签。
 */
export function AgentCard({ agent, session, label, onClick }: AgentCardProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  // waiting 状态既要检查 status 字段，也要检查 awaiting_input_since（后者兼容旧数据）。
  const isWaiting = agent.status === "waiting" || isAgentAwaitingInput(agent);
  // effectiveAgentStatus 会把 awaiting_input 映射为 waiting，保证 UI 状态统一。
  const status = effectiveAgentStatus(agent);
  const isActive = agent.status === "working";
  const isMain = agent.type === "main";

  // 主 agent 显示会话模型；子 agent 优先从自身 metadata 里读模型。
  const model = formatModelName(session?.model);
  const cwdBase = pathBasename(session?.cwd);

  // 如果 session.name 还是自动生成的 "Session xxxxxx"，就当成没有真实名称，
  // 这样主 agent 名称不会变成 "Main Agent - Session xxxxxx"。
  const sessionName = session?.name?.trim() || "";
  const realSessionName = /^Session [0-9a-f]{8}$/i.test(sessionName) ? "" : sessionName;

  // 子 agent 的 metadata 可能包含其运行时使用的模型信息。
  let subagentModel: string | null = null;
  if (!isMain && agent.metadata) {
    try {
      const parsed = JSON.parse(agent.metadata) as { model?: string };
      subagentModel = parsed?.model ? formatModelName(parsed.model) : null;
    } catch {
      subagentModel = null;
    }
  }

  // 决定卡片上显示的模型：主 agent 用会话模型，子 agent 用自己的模型。
  const displayModel = isMain ? model : subagentModel;

  // session.agent_count 是后端聚合的总 agent 数，减去 main agent 得到子 agent 数量。
  const agentCount = typeof session?.agent_count === "number" ? session.agent_count : 0;

  // 轮次数存在 session.metadata 里，只有主 agent 卡片才展示。
  const subagentCount = Math.max(0, agentCount - 1);
  let sessionTurns = 0;
  if (isMain && session?.metadata) {
    try {
      const parsedMetadata = JSON.parse(session.metadata) as { turn_count?: number };
      if (typeof parsedMetadata?.turn_count === "number") sessionTurns = parsedMetadata.turn_count;
    } catch {
      sessionTurns = 0;
    }
  }

  // 主 agent 副标题：cwd + 子 agent 数量 + 轮次数；子 agent 副标题：类型/标签 + cwd。
  const subtitle = isMain
    ? [
        cwdBase,
        subagentCount > 0 ? t("subagentSummary", { count: subagentCount }) : null,
        sessionTurns > 0 ? t("turnSummary", { count: sessionTurns }) : null,
      ]
        .filter(Boolean)
        .join(" · ") || null
    : [label || agent.subagent_type, cwdBase].filter(Boolean).join(" · ") || null;

  function handleClick() {
    if (onClick) {
      onClick();
    } else {
      navigate(`/sessions/${agent.session_id}`);
    }
  }

  return (
    // 用左侧边框颜色区分状态：waiting（黄）、working（绿/青）、其他无。
    <div
      onClick={handleClick}
      className={`card-hover p-4 cursor-pointer overflow-hidden ${
        isWaiting
          ? "border-l-2 border-l-status-waiting/60"
          : isActive
            ? "border-l-2 border-l-status-working/50"
            : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-3 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0 overflow-hidden">
          <div
            className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${
              isMain ? "bg-accent/15 text-accent" : "bg-accent/15 text-accent"
            }`}
          >
            {isMain ? <Bot className="w-3.5 h-3.5" /> : <GitBranch className="w-3.5 h-3.5" />}
          </div>
          <div className="min-w-0 overflow-hidden">
            <p className="text-sm font-medium text-slate-200 truncate">
              {isMain ? mainAgentDisplayName(agent.name, realSessionName) : agent.name}
            </p>
            {subtitle && <p className="text-[11px] text-slate-500 truncate">{subtitle}</p>}
          </div>
        </div>
        <AgentStatusBadge status={status} />
      </div>

      {agent.task && (
        <p className="text-xs text-slate-400 mb-3 line-clamp-2 leading-relaxed">{agent.task}</p>
      )}

      {/* 底部元信息行：优先显示当前工具；没有工具时显示模型；最后显示运行/更新时间。 */}
      <div className="flex items-center gap-3 text-[11px] text-slate-500 min-w-0 overflow-hidden flex-wrap">
        {agent.current_tool && (
          <span className="flex items-center gap-1 flex-shrink-0">
            <Wrench className="w-3 h-3" />
            {agent.current_tool}
          </span>
        )}
        {displayModel && !agent.current_tool && (
          <span className="flex items-center gap-1 flex-shrink-0">
            <Cpu className="w-3 h-3" />
            {displayModel}
          </span>
        )}
        {agent.ended_at ? (
          <>
            <span className="flex items-center gap-1 flex-shrink-0">
              <Clock className="w-3 h-3" />
              {t("ran")}
              {formatDuration(agent.started_at, agent.ended_at)}
            </span>
            <span className="text-slate-600 flex-shrink-0">{timeAgo(agent.ended_at)}</span>
          </>
        ) : (
          <span className="flex items-center gap-1 flex-shrink-0">
            <Clock className="w-3 h-3" />
            {timeAgo(agent.updated_at || agent.started_at)}
          </span>
        )}
      </div>
    </div>
  );
}
