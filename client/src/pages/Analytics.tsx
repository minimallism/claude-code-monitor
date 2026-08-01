import { useEffect, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  Clock,
  BarChart3,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { fmt, formatModelName, fmtSize } from "../lib/format";
import { Tip } from "../components/Tip";
import { Skeleton } from "../components/Skeleton";
import type { Analytics as AnalyticsData, ProjectSummary } from "../lib/types";

function ChartTooltip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  const nearRight = x > window.innerWidth - 200;
  return (
    <div
      className="fixed z-50 px-2 py-1.5 text-xs bg-surface-2 border border-border rounded shadow-xl text-slate-200 pointer-events-none whitespace-nowrap"
      style={{
        left: nearRight ? x - 14 : x + 14,
        top: y - 10,
        transform: nearRight ? "translateX(-100%)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function useTooltip() {
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    content: React.ReactNode;
  } | null>(null);

  const show = (e: React.MouseEvent, content: React.ReactNode) => {
    setTooltip({ x: e.clientX, y: e.clientY, content });
  };
  const move = (e: React.MouseEvent) => {
    setTooltip((tooltipState) => tooltipState && { ...tooltipState, x: e.clientX, y: e.clientY });
  };
  const hide = () => setTooltip(null);

  const node = tooltip ? (
    <ChartTooltip x={tooltip.x} y={tooltip.y}>
      {tooltip.content}
    </ChartTooltip>
  ) : null;

  return { show, move, hide, node };
}



function localDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function TokenTrend({ data }: { data: Array<{ date: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }> }) {
  const { show, move, hide, node } = useTooltip();
  const { t } = useTranslation(["analytics", "common"]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // pad to exactly 30 days in local timezone, fill missing days with zeros
  type TokenDay = { date: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
  const padded = useMemo(() => {
    const days: TokenDay[] = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const dateStr = localDateStr(date);
      const existing = data.find((day) => day.date === dateStr);
      days.push(existing ?? { date: dateStr, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
    }
    return days;
  }, [data]);

  const colors: Record<string, string> = {
    input: "#22d3ee",
    output: "#34d399",
    cacheRead: "#67e8f9",
    cacheWrite: "#fbbf24",
  };

  const stackKeys = ["input", "output", "cacheRead", "cacheWrite"] as const;

  // compute cumulative stacked values
  const stacked = padded.map((day) => {
    const vals = [day.input_tokens, day.output_tokens, day.cache_read_tokens, day.cache_write_tokens];
    const total = vals.reduce((sum, value) => sum + value, 0);
    const cum: number[] = [];
    let runningSum = 0;
    for (const value of vals) { cum.push(runningSum); runningSum += value; }
    return { ...day, total, cum };
  });

  const maxTotal = Math.max(...stacked.map((day) => day.total), 1);

  const width = 600;
  const height = 120;
  const padding = { top: 8, right: 10, bottom: 22, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const xScale = (i: number) => padding.left + (i / Math.max(padded.length - 1, 1)) * chartWidth;
  const yScale = (v: number) => padding.top + chartHeight - (v / maxTotal) * chartHeight;

  const barWidth = padded.length > 1 ? Math.max(3, (chartWidth / padded.length) * 0.5) : 20;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxTotal));

  // helper to get value by key
  const getVal = (day: typeof data[number], key: string) => {
    switch (key) {
      case "input": return day.input_tokens;
      case "output": return day.output_tokens;
      case "cacheRead": return day.cache_read_tokens;
      case "cacheWrite": return day.cache_write_tokens;
      default: return 0;
    }
  };

  // create mouse enter handler for each day
  const makeEnterHandler = (index: number, dayEntry: typeof stacked[number]) => (e: React.MouseEvent) => {
    setHoverIdx(index);
    show(
      e,
      <div className="space-y-1">
        <div className="text-slate-300 font-medium">{dayEntry.date}</div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: colors.input }} />
          <span className="text-slate-400 text-xs">{t("common:token.input")}:</span>
          <span className="text-accent font-mono text-xs">{dayEntry.input_tokens.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: colors.output }} />
          <span className="text-slate-400 text-xs">{t("common:token.output")}:</span>
          <span className="text-status-working font-mono text-xs">{dayEntry.output_tokens.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: colors.cacheRead }} />
          <span className="text-slate-400 text-xs">{t("common:token.cacheRead")}:</span>
          <span className="text-accent font-mono text-xs">{dayEntry.cache_read_tokens.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: colors.cacheWrite }} />
          <span className="text-slate-400 text-xs">{t("common:token.cacheWrite")}:</span>
          <span className="text-status-waiting font-mono text-xs">{dayEntry.cache_write_tokens.toLocaleString()}</span>
        </div>
        <div className="border-t border-border pt-1 mt-1">
          <span className="text-slate-400 text-xs">{t("common:total")}:</span>
          <span className="text-slate-100 font-mono text-xs ml-2">{dayEntry.total.toLocaleString()}</span>
        </div>
      </div>
    );
  };

  const makeLeaveHandler = () => {
    setHoverIdx(null);
    hide();
  };

  // dynamic label step based on available space: each label needs ~32px to fit cleanly
  const labelStep = Math.max(1, Math.ceil(32 / (chartWidth / padded.length)));

  return (
    <div className="relative">
      {node}
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              y1={yScale(tick)}
              x2={width - padding.right}
              y2={yScale(tick)}
              stroke="#272735"
              strokeDasharray="2,2"
            />
            <text
              x={padding.left - 5}
              y={yScale(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-slate-500"
              fontSize={8}
            >
              {tick >= 1000 ? `${(tick / 1000).toFixed(0)}K` : tick}
            </text>
          </g>
        ))}

        {/* vertical hover guide */}
        {hoverIdx !== null && (
          <line
            x1={xScale(hoverIdx)}
            y1={padding.top}
            x2={xScale(hoverIdx)}
            y2={height - padding.bottom}
            stroke="#64748b"
            strokeWidth={1}
            strokeDasharray="3,3"
          />
        )}

        {/* stacked bars */}
        {stacked.map((dayEntry, index) => {
          const barX = xScale(index) - barWidth / 2;
          return (
            <g key={dayEntry.date}>
              {stackKeys.map((key, idx) => {
                const val = getVal(dayEntry, key);
                if (val === 0) return null;
                const y0 = yScale(dayEntry.cum[idx]!);
                const y1 = yScale(dayEntry.cum[idx]! + val);
                return (
                  <rect
                    key={key}
                    x={barX}
                    y={y1}
                    width={barWidth}
                    height={y0 - y1}
                    fill={colors[key]}
                    opacity={0.85}
                    rx={1}
                  />
                );
              })}
            </g>
          );
        })}

        {/* hit areas */}
        {stacked.map((dayEntry, index) => {
          const prevX = index === 0 ? 0 : (xScale(index - 1) + xScale(index)) / 2;
          const nextX = index === padded.length - 1 ? width : (xScale(index) + xScale(index + 1)) / 2;
          const hitWidth = nextX - prevX;
          const hitX = prevX;
          return (
            <g
              key={dayEntry.date}
              onMouseEnter={makeEnterHandler(index, dayEntry)}
              onMouseMove={move}
              onMouseLeave={makeLeaveHandler}
            >
              <rect
                x={hitX}
                y={padding.top}
                width={hitWidth}
                height={chartHeight}
                fill="transparent"
                style={{ cursor: "pointer" }}
              />
            </g>
          );
        })}

        {/* x-axis labels */}
        {padded.filter((_, index) => index % labelStep === 0).map((day) => {
          const origIdx = padded.indexOf(day);
          return (
            <text
              key={day.date}
              x={xScale(origIdx)}
              y={height - 8}
              textAnchor="middle"
              className="fill-slate-500"
              fontSize={7}
            >
              {day.date.slice(5)}
            </text>
          );
        })}
      </svg>

      <div className="flex items-center justify-center gap-3 mt-1.5 text-[10px]">
        {[
          { label: t("common:token.input"), color: colors.input },
          { label: t("common:token.output"), color: colors.output },
          { label: t("common:token.cacheRead"), color: colors.cacheRead },
          { label: t("common:token.cacheWrite"), color: colors.cacheWrite },
        ].map(({ label, color }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
            <span className="text-slate-500">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionTrend({ data }: { data: Array<{ date: string; completed: number; active: number; error: number; total: number }> }) {
  const { show, move, hide, node } = useTooltip();
  const { t } = useTranslation(["analytics", "common"]);
  const [hoverPos, setHoverPos] = useState<{ row: number; col: number } | null>(null);

  const maxTotal = Math.max(...data.map(day => day.total), 1);

  // map 30 days to a calendar grid: 7 rows (Mon-Sun), N columns (weeks)
  const startDow = ((data[0]?.date ? new Date(data[0].date).getDay() : 1) + 6) % 7;
  const numCols = Math.ceil((startDow + data.length) / 7);

  const grid: (typeof data[number] | null)[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: numCols }, () => null)
  );
  for (let i = 0; i < data.length; i++) {
    const idx = startDow + i;
    const row = idx % 7;
    const col = Math.floor(idx / 7);
    grid[row]![col] = data[i]!;
  }

  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const cellSize = 13;
  const gap = 2;
  const pad = { top: 2, left: 24, right: 4, bottom: 2 };
  const gridW = numCols * cellSize + (numCols - 1) * gap;
  const gridH = 7 * cellSize + 6 * gap;
  const svgW = pad.left + gridW + pad.right;
  const svgH = pad.top + gridH + pad.bottom;

  const cx = (col: number) => pad.left + col * (cellSize + gap);
  const cy = (row: number) => pad.top + row * (cellSize + gap);

  const heatColor = (total: number) => {
    if (total === 0) return "#15151e";
    const intensity = Math.max(0.15, Math.min(1, total / maxTotal));
    // blend between dark and emerald
    const r = Math.round(16 + (16 - 16) * intensity);
    const g = Math.round(26 + (185 - 26) * intensity);
    const b = Math.round(46 + (129 - 46) * intensity);
    return `rgb(${r},${g},${b})`;
  };

  const makeEnterHandler = (dayEntry: typeof data[number], row: number, col: number) => (e: React.MouseEvent) => {
    setHoverPos({ row, col });
    show(
      e,
      <div className="space-y-1">
        <div className="text-slate-300 font-medium">{dayEntry.date}</div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: "#34d399" }} />
          <span className="text-slate-400 text-xs">{t("common:status.completed")}:</span>
          <span className="text-status-working font-mono text-xs">{dayEntry.completed}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: "#22d3ee" }} />
          <span className="text-slate-400 text-xs">{t("common:status.active")}:</span>
          <span className="text-accent font-mono text-xs">{dayEntry.active}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: "#f87171" }} />
          <span className="text-slate-400 text-xs">{t("common:status.error")}:</span>
          <span className="text-status-error font-mono text-xs">{dayEntry.error}</span>
        </div>
        <div className="border-t border-border pt-1 mt-1">
          <span className="text-slate-400 text-xs">{t("common:total")}:</span>
          <span className="text-slate-100 font-mono text-xs ml-2">{dayEntry.total}</span>
        </div>
      </div>
    );
  };

  const makeLeaveHandler = () => {
    setHoverPos(null);
    hide();
  };

  // compute date-range label e.g. "Jun 28 – Jul 27"
  const firstDate = data[0]?.date ?? "";
  const lastDate = data[data.length - 1]?.date ?? "";
  const rangeLabel = firstDate && lastDate
    ? `${firstDate.slice(5)} – ${lastDate.slice(5)}`
    : "";

  return (
    <div className="relative">
      {node}
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full max-w-[180px] mx-auto">
        {/* column week separators - subtle vertical line */}
        {Array.from({ length: numCols - 1 }, (_, i) => (
          <line
            key={`sep-${i}`}
            x1={cx(i + 1) - gap / 2}
            y1={pad.top}
            x2={cx(i + 1) - gap / 2}
            y2={pad.top + gridH}
            stroke="#272735"
            strokeWidth={0.5}
          />
        ))}

        {/* cells */}
        {grid.map((row, rowIndex) =>
          row.map((dayEntry, colIndex) => (
            <g key={`${rowIndex}-${colIndex}`}>
              <rect
                x={cx(colIndex)}
                y={cy(rowIndex)}
                width={cellSize}
                height={cellSize}
                rx={3}
                fill={dayEntry ? heatColor(dayEntry.total) : "transparent"}
                stroke={hoverPos?.row === rowIndex && hoverPos?.col === colIndex ? "#64748b" : "none"}
                strokeWidth={hoverPos?.row === rowIndex && hoverPos?.col === colIndex ? 1 : 0}
              />
              {/* hit area */}
              {dayEntry && (
                <rect
                  x={cx(colIndex)}
                  y={cy(rowIndex)}
                  width={cellSize}
                  height={cellSize}
                  fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={makeEnterHandler(dayEntry, rowIndex, colIndex)}
                  onMouseMove={move}
                  onMouseLeave={makeLeaveHandler}
                />
              )}
            </g>
          ))
        )}

        {/* row labels */}
        {dayLabels.map((label, ri) => (
          <text
            key={label}
            x={pad.left - 6}
            y={cy(ri) + cellSize / 2}
            textAnchor="end"
            dominantBaseline="central"
            className="fill-slate-500"
            fontSize={8}
          >
            {label}
          </text>
        ))}
      </svg>

      <div className="text-center text-[10px] text-slate-600">{rangeLabel}</div>
    </div>
  );
}

function ChartCardSkeleton({
  className = "",
  bodyH = "h-32",
}: {
  className?: string;
  bodyH?: string;
}) {
  return (
    <div className={`card p-5 space-y-4 ${className}`} aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className={`block w-full ${bodyH}`} rounded="lg" />
      <div className="space-y-2 pt-1">
        <Skeleton className="block h-3 w-2/3" />
        <Skeleton className="block h-3 w-1/2" />
      </div>
    </div>
  );
}

function AnalyticsChartsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading analytics charts">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <ChartCardSkeleton className="lg:col-span-2" bodyH="h-32" />
        <ChartCardSkeleton bodyH="h-32" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <ChartCardSkeleton bodyH="h-44" />
        <ChartCardSkeleton bodyH="h-44" />
        <ChartCardSkeleton bodyH="h-44" />
        <ChartCardSkeleton bodyH="h-44" />
        <ChartCardSkeleton bodyH="h-44" />
      </div>
    </div>
  );
}

export function Analytics() {
  const { t } = useTranslation("analytics");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const wsConnected = useSyncExternalStore(eventBus.onConnection, () => eventBus.connected);

  const load = useCallback(async () => {
    const [result, projRes] = await Promise.all([
      api.analytics.get(),
      api.projects.list(),
    ]);
    setData(result);
    setProjects(projRes.projects ?? []);
    setLastUpdate(new Date());
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    return eventBus.subscribe((msg) => {
      if (
        msg.type === "session_created" ||
        msg.type === "session_updated" ||
        msg.type === "new_event" ||
        msg.type === "agent_created"
      ) {
        load();
      }
    });
  }, [load]);

  const hasStatusData = (data?.daily_session_statuses?.length ?? 0) > 0;
  const statusMap: Record<string, { completed: number; error: number; active: number }> = {};
  if (hasStatusData) {
    for (const day of data!.daily_session_statuses!) {
      statusMap[day.date] = { completed: day.completed, error: day.error, active: day.active };
    }
  } else {
    
    for (const day of data?.daily_sessions ?? []) {
      statusMap[day.date] = { completed: day.count, error: 0, active: 0 };
    }
  }

  
  
  

  
  const today = new Date();
  today.setHours(12, 0, 0, 0); 

  const last30 = Array.from({ length: 30 }, (_, offset) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (29 - offset));
    const dateStr = localDateStr(date);
    const entry = statusMap[dateStr];
    const completed = entry?.completed ?? 0;
    const error = entry?.error ?? 0;
    const active = entry?.active ?? 0;
    return { date: dateStr, completed, error, active, total: completed + error + active };
  });

  const maxDay = last30.reduce((best, day) => day.total > (best?.total ?? 0) ? day : best, last30[0]);
  const total30 = last30.reduce((sum, day) => sum + day.total, 0);
  const avg30 = total30 / 30;
  const activeDays = last30.filter(day => day.total > 0).length;

  const totalTokens =
    (data?.tokens.total_input ?? 0) +
    (data?.tokens.total_output ?? 0) +
    (data?.tokens.total_cache_read ?? 0) +
    (data?.tokens.total_cache_write ?? 0);

  const maxToolCount = (data?.tool_usage ?? [])[0]?.count ?? 1;

  const activeProjects = projects.filter((p) => p.active_sessions > 0);
  const totalProjectSessions = projects.reduce((sum, project) => sum + project.session_count, 0);
  const totalDiskUsage = projects.reduce((sum, project) => sum + (project.disk_usage ?? 0), 0);
  const totalProjectTokens = projects.reduce((sum, project) => sum + (project.total_tokens ?? 0), 0);

  const modelTokenRows = (data?.tokens_by_model ?? [])
    .sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens))
    .slice(0, 6);
  const displayedModelTotal = modelTokenRows.reduce((sum, model) => sum + model.input_tokens + model.output_tokens, 0);

  const sessionOutcomeSegments = [
    {
      label: t("common:status.completed"),
      value: data?.sessions_by_status?.completed ?? 0,
      color: "#22d3ee",
    },
    {
      label: t("common:status.active"),
      value: data?.sessions_by_status?.active ?? 0,
      color: "#34d399",
    },
    {
      label: t("common:status.error"),
      value: data?.sessions_by_status?.error ?? 0,
      color: "#f87171",
    },
  ].filter((s) => s.value > 0);

  const agentStatusSegments = [
    {
      label: t("common:status.completed"),
      value: data?.agents_by_status?.completed ?? 0,
      color: "#22d3ee",
    },
    {
      label: t("common:status.working"),
      value: data?.agents_by_status?.working ?? 0,
      color: "#34d399",
    },
    {
      label: t("common:status.waiting"),
      value: data?.agents_by_status?.waiting ?? 0,
      color: "#fbbf24",
    },
    {
      label: t("common:status.error"),
      value: data?.agents_by_status?.error ?? 0,
      color: "#f87171",
    },
  ].filter((s) => s.value > 0);

  return (
    <div className="animate-fade-in space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
              <BarChart3 className="w-4.5 h-4.5 text-accent" />
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
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 bg-surface-2 border border-border px-2 py-0.5 rounded-md font-mono ml-2">
                  <Clock className="w-3 h-3" />
                  {lastUpdate.toLocaleTimeString()}
                </span>
              </p>
            </div>
          </div>
        </div>

      </div>

      {!data ? (
        <AnalyticsChartsSkeleton />
      ) : (
        <>
          <div className="card p-5">
            <h3 className="text-sm font-medium text-slate-300 mb-4">{t("tokenTrend")}</h3>
            <TokenTrend data={data.daily_tokens ?? []} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="card p-5 lg:col-span-2">
              <h3 className="text-sm font-medium text-slate-300 mb-5">{t("modelTokenUsage")}</h3>
              {modelTokenRows.length === 0 ? (
                <p className="text-sm text-slate-500">{t("common:noData")}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[11px] text-slate-500 uppercase tracking-wider">{t("tokenUsage")}</span>
                    <span className="text-[10px] font-mono text-slate-500">
                      {t("kTotal", { value: (displayedModelTotal / 1000).toFixed(1) })}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {modelTokenRows.map((modelEntry, index) => {
                      const pct = displayedModelTotal > 0 ? Math.round(((modelEntry.input_tokens + modelEntry.output_tokens) / displayedModelTotal) * 100) : 0;
                      const colors = [
                        "bg-accent",
                        "bg-status-working",
                        "bg-status-waiting",
                        "bg-status-error",
                        "bg-status-completed",
                        "bg-accent",
                      ];
                      return (
                        <Tip
                          block
                          key={index}
                          raw={`${formatModelName(modelEntry.model) ?? modelEntry.model}\nInput: ${modelEntry.input_tokens.toLocaleString()}\nOutput: ${modelEntry.output_tokens.toLocaleString()}\nCache Read: ${modelEntry.cache_read_tokens.toLocaleString()}\nShare: ${pct.toFixed(1)}%`}
                        >
                          <div className="flex items-center gap-3 cursor-default">
                            <span
                              className="text-xs text-slate-400 w-28 truncate flex-shrink-0"
                              title={formatModelName(modelEntry.model) ?? modelEntry.model}
                            >
                              {formatModelName(modelEntry.model) ?? modelEntry.model}
                            </span>
                            <div className="flex-1 bg-surface-3 rounded-full h-2">
                              <div
                                className={`${colors[index % colors.length]} h-2 rounded-full transition-all duration-700`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-slate-500 w-12 text-right flex-shrink-0 font-mono">
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        </Tip>
                      );
                    })}
                  </div>

                  {/* compact token composition summary */}
                  {totalTokens > 0 && (
                    <div className="mt-5 pt-4 border-t border-border">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[11px] text-slate-500 uppercase tracking-wider">{t("tokenMix")}</span>
                        <span className="text-sm font-mono font-medium text-slate-100">
                          {totalTokens.toLocaleString()}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          [
                            { label: t("common:token.input"), value: data?.tokens.total_input ?? 0, color: "bg-accent" },
                            { label: t("common:token.output"), value: data?.tokens.total_output ?? 0, color: "bg-status-working" },
                          ],
                          [
                            { label: t("common:token.cacheRead"), value: data?.tokens.total_cache_read ?? 0, color: "bg-accent" },
                            { label: t("common:token.cacheWrite"), value: data?.tokens.total_cache_write ?? 0, color: "bg-status-waiting" },
                          ],
                        ].map((pair, rowIdx) => (
                          <div key={rowIdx} className="col-span-2 grid grid-cols-2 gap-3">
                            {pair.map(({ label, value, color }) => {
                              const pct = totalTokens > 0 ? Math.round((value / totalTokens) * 100) : 0;
                              return (
                                <Tip key={label} raw={`${label}\n${value.toLocaleString()}\n${pct}%`}>
                                  <div className="flex items-center gap-2 cursor-default">
                                    <span className={`w-2 h-2 rounded-full ${color} flex-shrink-0`} />
                                    <span className="text-[10px] text-slate-400 w-auto flex-shrink-0">{label}</span>
                                    <div className="flex-1 bg-surface-3 rounded-full h-2 overflow-hidden min-w-[40px]">
                                      <div className={`${color} h-2 rounded-full`} style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="text-[10px] text-slate-500 text-right flex-shrink-0 font-mono">{pct}% · {fmt(value)}</span>
                                  </div>
                                </Tip>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 项目维度数据 */}
            <div className="card p-5">
              <div className="flex items-start justify-between mb-4">
                <h3 className="text-sm font-medium text-slate-300">{t("projectsOverview")}</h3>
                {projects.length > 0 && (() => {
                  const active = activeProjects.length;
                  const total = projects.length;
                  const idle = total - active;
                  const activePct = active / total;
                  const r = 25;
                  const circ = 2 * Math.PI * r;
                  const offset = circ * (1 - activePct);
                  return (
                    <Tip
                      block
                      raw={`${t("common:status.active")} ${active} / ${t("common:idle")} ${idle}`}
                    >
                      <svg width={66} height={66} viewBox="0 0 66 66" className="flex-shrink-0">
                        <rect width={66} height={66} fill="transparent" />
                        <circle cx={33} cy={33} r={r} fill="none" stroke="#272735" strokeWidth={5} />
                        <circle
                          cx={33} cy={33} r={r}
                          fill="none" stroke="#34d399"
                          strokeWidth={5}
                          strokeDasharray={circ}
                          strokeDashoffset={offset}
                          transform="rotate(-90 33 33)"
                          strokeLinecap="round"
                        />
                      </svg>
                    </Tip>
                  );
                })()}
              </div>
              {projects.length === 0 ? (
                <p className="text-sm text-slate-500">{t("common:noData")}</p>
              ) : (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">{t("common:total_lower")}</span>
                    <span className="text-slate-300 font-mono">{projects.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">{t("common:status.active")}</span>
                    <span className="text-status-working font-mono">{activeProjects.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">{t("common:idle")}</span>
                    <span className="text-slate-400 font-mono">{projects.length - activeProjects.length}</span>
                  </div>
                  <div className="pt-2 border-t border-border space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t("common:sessionLabel")}</span>
                      <span className="text-slate-300 font-mono">{fmt(totalProjectSessions)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t("tokenUsage")}</span>
                      <span className="text-slate-300 font-mono">{fmt(totalProjectTokens)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t("common:diskUsage")}</span>
                      <span className="text-slate-300 font-mono">{fmtSize(totalDiskUsage)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 工具使用 - 撑满一行，放在各模型 Token 用量下方 */}
            <div className="card p-5 lg:col-span-3">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-sm font-medium text-slate-300">{t("toolUsage")}</h3>
                <span className="text-[11px] text-slate-500 font-mono">
                  {t("toolTypesCount", { count: (data?.tool_usage ?? []).length })}
                </span>
              </div>
              {(data?.tool_usage ?? []).length === 0 ? (
                <p className="text-sm text-slate-500">{t("noToolData")}</p>
              ) : (
                <div className="space-y-2">
                  {(data?.tool_usage ?? []).map((tool, i) => {
                    const pct = maxToolCount > 0 ? Math.round((tool.count / maxToolCount) * 100) : 0;
                    const successRate = tool.count > 0 ? Math.round(((tool.count - tool.failures) / tool.count) * 100) : 100;
                    const avgDuration = tool.avg_duration_ms != null
                      ? (tool.avg_duration_ms >= 1000 ? `${(tool.avg_duration_ms / 1000).toFixed(1)}s` : `${Math.round(tool.avg_duration_ms)}ms`)
                      : null;
                    const colors = [
                      "bg-status-waiting",
                      "bg-accent",
                      "bg-status-working",
                      "bg-status-error",
                      "bg-status-completed",
                      "bg-accent",
                      "bg-status-error",
                      "bg-accent",
                    ];
                    return (
                      <Tip
                        block
                        key={i}
                        raw={`${tool.tool_name}\n${t("calls")}: ${tool.count.toLocaleString()}\n${t("failures")}: ${tool.failures.toLocaleString()}\n${t("successRate")}: ${successRate}%${avgDuration ? `\n${t("avgDuration")}: ${avgDuration}` : ''}`}
                      >
                        <div className="flex items-center gap-2 cursor-default">
                          <span
                            className="text-xs text-slate-400 w-24 truncate flex-shrink-0"
                            title={tool.tool_name}
                          >
                            {tool.tool_name}
                          </span>
                          <div className="flex-1 bg-surface-3 rounded-full h-2">
                            <div
                              className={`${colors[i % colors.length]} h-2 rounded-full transition-all duration-500`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-400 w-36 text-right flex-shrink-0 font-mono">
                            {tool.count > 999 ? `${(tool.count / 1000).toFixed(1)}K` : tool.count}
                            {" · "}
                            {successRate}%
                            {avgDuration ? ` · ${avgDuration}` : ""}
                          </span>
                        </div>
                      </Tip>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-5">{t("sessionOutcomes")}</h3>
              {(data?.overview.total_sessions ?? 0) > 0 ? (
                <>
                  <div className="space-y-3.5">
                    {(() => {
                      const total = data!.overview.total_sessions;
                      return sessionOutcomeSegments.map((s) => {
                        const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
                        return (
                          <div key={s.label}>
                            <div className="flex items-center justify-between text-xs mb-1.5">
                              <span className="flex items-center gap-1.5 text-slate-500">
                                <span
                                  className="w-2 h-2 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: s.color }}
                                />
                                {s.label}
                              </span>
                              <span className="flex items-center gap-2">
                                <span className="text-slate-400 font-mono">{fmt(s.value)}</span>
                                <span className="text-slate-600 font-mono w-8 text-right">{pct}%</span>
                              </span>
                            </div>
                            <div className="bg-surface-3 rounded-full h-2 overflow-hidden">
                              <div
                                className="h-full rounded-full cursor-default transition-all hover:opacity-80"
                                style={{ width: `${pct}%`, backgroundColor: s.color }}
                              />
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                  <div className="mt-4 pt-3 border-t border-border space-y-2">
                    {(() => {
                      const o = data?.overview;
                      const avgDuration = o?.avg_session_duration_seconds ?? 0;
                      const mins = Math.floor(avgDuration / 60);
                      const secs = Math.round(avgDuration % 60);
                      const durationStr = mins > 0
                        ? `${mins}m ${secs}s`
                        : `${secs}s`;
                      const totalSessions = o?.total_sessions ?? 0;
                      const tokensPerSession = totalSessions > 0 && data?.tokens
                        ? Math.round(
                            (data.tokens.total_input + data.tokens.total_output +
                             data.tokens.total_cache_read + data.tokens.total_cache_write) /
                            totalSessions
                          )
                        : 0;
                      return (
                        <>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-500">{t("totalSessionsLabel")}</span>
                            <span className="text-slate-300 font-mono font-medium">
                              {fmt(totalSessions)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-500">{t("avgDuration")}</span>
                            <span className="text-slate-400 font-mono">{durationStr}</span>
                          </div>
                          {tokensPerSession > 0 && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-slate-500">{t("tokensPerSession")}</span>
                              <span className="text-slate-400 font-mono">{fmt(tokensPerSession)}</span>
                            </div>
                          )}
                          {data?.sessions_today != null && data.sessions_today > 0 && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-slate-500">{t("sessionsToday")}</span>
                              <span className="text-slate-400 font-mono">{data.sessions_today}</span>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-500">{t("common:noData")}</p>
              )}
            </div>

            <div className="card p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-4">{t("agentStatus")}</h3>

              {/* 水平堆叠条 */}
              {(() => {
                const segs = agentStatusSegments;
                const total = segs.reduce((s, g) => s + g.value, 0);
                if (total === 0) return <p className="text-xs text-slate-500">{t("common:noData")}</p>;
                return (
                  <>
                    <div
                      className="h-2 rounded-full overflow-hidden bg-surface-3"
                      style={{ display: 'grid', gridTemplateColumns: segs.map(s => `${s.value}fr`).join(' ') }}
                    >
                      {segs.map((s) => {
                        return s.value > 0 ? (
                          <Tip key={s.label} raw={`${s.label}\n${s.value.toLocaleString()} (${Math.round((s.value / total) * 100)}%)`}>
                            <div
                              className="h-full transition-all hover:brightness-110 cursor-default"
                              style={{ backgroundColor: s.color, minWidth: 4 }}
                            />
                          </Tip>
                        ) : null;
                      })}
                    </div>
                    {/* 内联图例 */}
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                      <span className="text-xs text-slate-300 font-mono">{fmt(total)} {t("common:total_lower")}</span>
                      {segs.map((s) => {
                        const pct = Math.round((s.value / total) * 100);
                        return pct > 0 ? (
                          <span key={s.label} className="inline-flex items-center gap-1 text-[11px] text-slate-500 font-mono">
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                            {s.label}
                            <span className="text-slate-400">{fmt(s.value)}</span>
                            <span className="text-slate-600">({pct}%)</span>
                          </span>
                        ) : null;
                      })}
                    </div>
                  </>
                );
              })()}

              {/* Agent类型分布 */}
              <div className="mt-4 pt-4 border-t border-border">
                {(() => {
                  const mainCount = data?.agent_types?.main ?? 0;
                  const subCount = data?.agent_types?.subagent ?? 0;
                  if (mainCount + subCount === 0) return null;
                  return (
                    <div>
                      <span className="text-[11px] text-slate-500">{t("agentTypes")}</span>
                      <div className="mt-1 space-y-0.5">
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span className="w-2 h-2 rounded-full bg-accent flex-shrink-0" />
                            <span className="flex-1">{t("mainAgent")}</span>
                            <span className="text-slate-300 font-mono">{fmt(mainCount)}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <span className="w-2 h-2 rounded-full bg-accent flex-shrink-0" />
                            <span className="flex-1">{t("subAgent")}</span>
                            <span className="text-slate-300 font-mono">{fmt(subCount)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
              </div>

              {/* Subagent类型分布 */}
              {(data?.subagent_types ?? []).length > 0 && (
                <div className="mt-4 pt-4 border-t border-border space-y-2">
                  <span className="text-[11px] text-slate-500">{t("subagentTypes")}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {(data?.subagent_types ?? []).slice(0, 6).map((st) => (
                      <Tip key={st.subagent_type} raw={`${st.subagent_type}\n${st.count} agents`}>
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 bg-surface-3 border border-border px-2 py-0.5 rounded-full font-mono cursor-default">
                          {st.subagent_type ?? "unknown"}
                          <span className="text-slate-600">{st.count}</span>
                        </span>
                      </Tip>
                    ))}
                    {(data?.subagent_types ?? []).length > 6 && (
                      <span className="text-[11px] text-slate-600 font-mono">
                        +{(data?.subagent_types ?? []).length - 6}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="card p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-3">{t("last30Days")}</h3>
              
              <SessionTrend data={last30} />
              <div className="mt-4 pt-4 border-t border-border space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">{t("peakDay")}</span>
                  <span className="text-slate-300 font-mono">
                    <Tip raw={`${maxDay?.date}\ncompleted: ${maxDay?.completed}\nerror: ${maxDay?.error}\nactive: ${maxDay?.active}`}>
                      <span>{maxDay?.date?.slice(5)} ({fmt(maxDay?.total ?? 0)})</span>
                    </Tip>
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">{t("total30d")}</span>
                  <span className="text-slate-300 font-mono">
                    <Tip raw={total30.toLocaleString()}>
                      {fmt(total30)}
                    </Tip> {t("common:sessions")}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">{t("avgPerDay")}</span>
                  <span className="text-slate-300 font-mono">{avg30.toFixed(1)} {t("common:sessions")}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">{t("activeDays")}</span>
                  <span className="text-slate-300 font-mono">{activeDays}/30</span>
                </div>
              </div>
            </div>
          </div>

        </>
      )}
    </div>
  );
}
