import type { CSSProperties } from "react";

interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
  
  rounded?: "sm" | "md" | "lg" | "full";
  
  label?: string;
}

const ROUNDED_CLASS = {
  sm: "rounded",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
} as const;

export function Skeleton({
  className = "",
  style,
  rounded = "md",
  label = "Loading",
}: SkeletonProps) {
  return (
    <span
      role="status"
      aria-label={label}
      aria-busy="true"
      className={`inline-block bg-surface-3/70 animate-pulse ${ROUNDED_CLASS[rounded]} ${className}`}
      style={style}
    />
  );
}

export function StatValueSkeleton({ className = "" }: { className?: string }) {
  return <Skeleton className={`h-7 w-20 align-middle ${className}`} />;
}

export function TableRowSkeleton({ columns, widths }: { columns: number; widths?: string[] }) {
  return (
    <tr className="border-b border-border/40">
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="px-5 py-4">
          <Skeleton className={`h-4 ${widths?.[i] ?? "w-24"}`} />
        </td>
      ))}
    </tr>
  );
}


