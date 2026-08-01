import { useTranslation } from "react-i18next";
import { STATUS_CONFIG, SESSION_STATUS_CONFIG } from "../lib/types";
import type { EffectiveAgentStatus, EffectiveSessionStatus } from "../lib/types";

interface AgentStatusBadgeProps {
  status: EffectiveAgentStatus;
  pulse?: boolean;
}

export function AgentStatusBadge({ status, pulse }: AgentStatusBadgeProps) {
  const { t } = useTranslation();
  const config = STATUS_CONFIG[status];
  
  
  const shouldPulse = pulse ?? (status === "working" || status === "waiting");

  return (
    <span className={`badge ${config.bg} ${config.color}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${config.dot} ${
          shouldPulse ? "animate-pulse-dot" : ""
        }`}
      />
      {t(config.labelKey)}
    </span>
  );
}

interface SessionStatusBadgeProps {
  status: EffectiveSessionStatus;
  pulse?: boolean;
}

export function SessionStatusBadge({ status, pulse }: SessionStatusBadgeProps) {
  const { t } = useTranslation();
  const config = SESSION_STATUS_CONFIG[status];
  const shouldPulse = pulse ?? (status === "active" || status === "waiting");
  return (
    <span className={`badge ${config.bg} ${config.color}`}>
      {shouldPulse && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${config.dot} animate-pulse-dot`}
          aria-hidden="true"
        />
      )}
      {t(config.labelKey)}
    </span>
  );
}
