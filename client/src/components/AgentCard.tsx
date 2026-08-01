import { useTranslation } from "react-i18next";
import { Bot, GitBranch, Clock, Wrench, Cpu } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AgentStatusBadge } from "./StatusBadge";
import { effectiveAgentStatus, isAgentAwaitingInput } from "../lib/types";
import type { Agent, Session } from "../lib/types";
import { formatDuration, timeAgo, formatModelName, pathBasename } from "../lib/format";

function mainAgentDisplayName(agentName: string, realSessionName: string): string {
  if (!realSessionName) return agentName;
  const sep = agentName.indexOf(" - ");
  return sep >= 0 ? `${agentName.slice(0, sep)} - ${realSessionName}` : agentName;
}

interface AgentCardProps {
  agent: Agent;
  

  session?: Session;
  label?: string;
  onClick?: () => void;
}

export function AgentCard({ agent, session, label, onClick }: AgentCardProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isWaiting = agent.status === "waiting" || isAgentAwaitingInput(agent);
  const status = effectiveAgentStatus(agent);
  const isActive = agent.status === "working";
  const isMain = agent.type === "main";

  
  
  
  
  const model = formatModelName(session?.model);
  const cwdBase = pathBasename(session?.cwd);
  
  
  
  
  
  
  const sessionName = session?.name?.trim() || "";
  const realSessionName = /^Session [0-9a-f]{8}$/i.test(sessionName) ? "" : sessionName;
  
  
  
  
  let subagentModel: string | null = null;
  if (!isMain && agent.metadata) {
    try {
      const parsed = JSON.parse(agent.metadata) as { model?: string };
      subagentModel = parsed?.model ? formatModelName(parsed.model) : null;
    } catch {
      subagentModel = null;
    }
  }
  
  
  const displayModel = isMain ? model : subagentModel;
  
  
  
  
  
  const agentCount = typeof session?.agent_count === "number" ? session.agent_count : 0;
  
  
  
  
  
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
              {

}
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
