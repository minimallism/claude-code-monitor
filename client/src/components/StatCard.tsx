import type { LucideIcon } from "lucide-react";
import { Tip } from "./Tip";
import { StatValueSkeleton } from "./Skeleton";

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  trend?: string;
  trendRaw?: string;
  accentColor?: string;
  raw?: string;
  loading?: boolean;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  trendRaw,
  accentColor = "text-accent",
  raw,
  loading = false,
}: StatCardProps) {
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">
          {label}
        </span>
        <Icon className={`w-4 h-4 flex-shrink-0 ${accentColor}`} />
      </div>
      <div className="flex items-end gap-2 min-w-0">
        {loading ? (
          <StatValueSkeleton />
        ) : (
          <Tip raw={raw}>
            <span className="text-xl font-semibold text-slate-100 truncate">{value}</span>
          </Tip>
        )}
        {!loading && trend && (
          <Tip raw={trendRaw}>
            <span className="text-[11px] text-slate-500 mb-0.5 flex-shrink-0">{trend}</span>
          </Tip>
        )}
      </div>
    </div>
  );
}
