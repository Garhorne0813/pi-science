import { cn } from "../../lib/ui";

export function MetricCard({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={cn("ui-card-flat rounded-card p-4", emphasis && "border-accent/40")}>
      <div className="font-mono text-2xl tabular-nums text-text">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}
