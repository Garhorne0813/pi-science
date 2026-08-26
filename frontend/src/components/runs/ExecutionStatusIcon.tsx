import { AlertTriangle, Ban, Check, Circle, CircleDashed, Clock3, Loader2, X } from "lucide-react";
import type { ExecutionRecord } from "@pi-science/contracts";

export function ExecutionStatusIcon({ status, size = 14 }: { status: ExecutionRecord["status"]; size?: number }) {
  if (status === "succeeded") return <Check size={size} className="shrink-0 text-ok-text" aria-label={status} />;
  if (status === "running") return <Loader2 size={size} className="shrink-0 animate-spin text-accent" aria-label={status} />;
  if (status === "pending") return <CircleDashed size={size} className="shrink-0 text-muted" aria-label={status} />;
  if (status === "timed_out") return <Clock3 size={size} className="shrink-0 text-warn-text" aria-label={status} />;
  if (status === "cancelled") return <Ban size={size} className="shrink-0 text-muted" aria-label={status} />;
  if (status === "interrupted" || status === "lost") return <AlertTriangle size={size} className="shrink-0 text-warn-text" aria-label={status} />;
  if (status === "failed") return <X size={size} className="shrink-0 text-error-text" aria-label={status} />;
  return <Circle size={size} className="shrink-0 text-muted" aria-label={status} />;
}
