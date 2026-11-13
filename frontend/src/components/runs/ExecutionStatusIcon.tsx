import { AlertTriangle, Ban, Check, Circle, CircleDashed, Clock3, Loader2, X } from "lucide-react";
import type { ExecutionRecord } from "@pi-science/contracts";

/** Decorative status glyph. The localized status text lives at the call site
 *  (`runs.status.*`), so the icon must not add an enum name to the a11y tree. */
export function ExecutionStatusIcon({ status, size = 14 }: { status: ExecutionRecord["status"]; size?: number }) {
  const props = { size, "aria-hidden": true } as const;
  if (status === "succeeded") return <Check {...props} className="shrink-0 text-ok-text" />;
  if (status === "running") return <Loader2 {...props} className="shrink-0 animate-spin text-accent" />;
  if (status === "pending") return <CircleDashed {...props} className="shrink-0 text-muted" />;
  if (status === "timed_out") return <Clock3 {...props} className="shrink-0 text-warn-text" />;
  if (status === "cancelled") return <Ban {...props} className="shrink-0 text-muted" />;
  if (status === "interrupted" || status === "lost") return <AlertTriangle {...props} className="shrink-0 text-warn-text" />;
  if (status === "failed") return <X {...props} className="shrink-0 text-error-text" />;
  return <Circle {...props} className="shrink-0 text-muted" />;
}
