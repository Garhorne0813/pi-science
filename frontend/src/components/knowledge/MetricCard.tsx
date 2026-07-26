import { cn } from "../../lib/cn";

export function MetricCard({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={cn("rounded-card border bg-surface p-4 shadow-card", emphasis ? "border-accent/40" : "border-border")}>
      <div className="font-mono text-2xl tabular-nums text-text">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}
