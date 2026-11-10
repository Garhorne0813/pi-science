/** Structured progress for one running tool call.
 *
 *  A percentage is a claim about a measurement, so this module is the only
 *  place that decides one can be shown. Producers describe their work scope and
 *  either a count or a count with a fixed total. Everything else, including an
 *  external party asserting a percentage, degrades to a count or to no number
 *  at all. Nothing here reads output text, elapsed time or model prose. */

export const TOOL_PROGRESS_LIMITS = { scopeId: 64, scopeLabel: 100, phase: 64, label: 160, unit: 24 } as const;

export type ToolProgressTotalKind = "fixed" | "reestimated" | "unknown";
export type ToolProgressSource = "builtin" | "mcp" | "kernel";
export type ToolProgressStatus = "running" | "done" | "error" | "waiting-approval" | "unknown";

export interface ToolProgressV1 {
  version: 1;
  /** Comparable only inside one attempt of one call. A new scope starts at zero
   *  and brings its own label. */
  scopeId: string;
  /** Plain text shown to the user. Names the work the number counts. */
  scopeLabel: string;
  phase?: string;
  label?: string;
  /** Completed work items. Finite and non-negative, or absent. */
  current?: number;
  /** Size of the scope. Absent when the producer does not know it. */
  total?: number;
  unit?: string;
  totalKind: ToolProgressTotalKind;
  indeterminate?: boolean;
  /** Decided here, never accepted from a producer. */
  determinate: boolean;
  source?: ToolProgressSource;
}

/** What the activity row renders. A union so an impossible combination, such
 *  as a bar without a total, cannot be expressed. */
export type ToolProgressDisplay =
  | { mode: "hidden" }
  | { mode: "indeterminate"; label?: string }
  | { mode: "count"; value: number; scopeLabel: string; unit?: string; phase?: string }
  | { mode: "determinate"; current: number; total: number; percent: number; scopeLabel: string; unit?: string; phase?: string };

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function totalKind(value: unknown): ToolProgressTotalKind {
  return value === "fixed" || value === "reestimated" ? value : "unknown";
}

function source(value: unknown): ToolProgressSource | undefined {
  return value === "builtin" || value === "mcp" || value === "kernel" ? value : undefined;
}

/** Parse progress arriving from a tool, an MCP server or a kernel. An
 *  out-of-range or missing number is dropped rather than repaired, and a
 *  missing scope identity rejects the whole payload because a bare number with
 *  no named scope cannot be described honestly. */
export function normalizeToolProgress(raw: unknown): ToolProgressV1 | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return undefined;
  const scopeId = boundedText(value.scopeId, TOOL_PROGRESS_LIMITS.scopeId);
  const scopeLabel = boundedText(value.scopeLabel, TOOL_PROGRESS_LIMITS.scopeLabel);
  if (!scopeId || !scopeLabel) return undefined;
  const current = count(value.current);
  const total = count(value.total);
  const kind = totalKind(value.totalKind);
  const indeterminate = value.indeterminate === true;
  const phase = boundedText(value.phase, TOOL_PROGRESS_LIMITS.phase);
  const label = boundedText(value.label, TOOL_PROGRESS_LIMITS.label);
  const unit = boundedText(value.unit, TOOL_PROGRESS_LIMITS.unit);
  const origin = source(value.source);
  return {
    version: 1,
    scopeId,
    scopeLabel,
    totalKind: kind,
    determinate: !indeterminate && kind === "fixed" && current !== undefined && total !== undefined && total > 0 && current <= total,
    ...(current === undefined ? {} : { current }),
    ...(total === undefined ? {} : { total }),
    ...(phase ? { phase } : {}),
    ...(label ? { label } : {}),
    ...(unit ? { unit } : {}),
    ...(indeterminate ? { indeterminate } : {}),
    ...(origin ? { source: origin } : {}),
  };
}

/** Fold one update into the value already on screen. A missing update keeps the
 *  current value, so an output-only message cannot clear the progress layer. A
 *  lower count inside one scope is a stale or replayed event: the measured
 *  value stays and only the newer wording is taken. */
export function mergeToolProgress(previous: ToolProgressV1 | undefined, next: ToolProgressV1 | undefined): ToolProgressV1 | undefined {
  if (!next) return previous;
  if (!previous || previous.scopeId !== next.scopeId) return next;
  if (previous.current === undefined || next.current === undefined || next.current >= previous.current) return next;
  return { ...previous, ...(next.phase ? { phase: next.phase } : {}), ...(next.label ? { label: next.label } : {}) };
}

/** The four display tiers. A terminal, queued or waiting row never shows a
 *  percentage, because the tool is not doing the measured work. */
export function selectToolProgressDisplay(status: ToolProgressStatus, progress: ToolProgressV1 | undefined): ToolProgressDisplay {
  if (status !== "running") return { mode: "hidden" };
  if (!progress) return { mode: "indeterminate" };
  const phase = progress.phase;
  const unit = progress.unit;
  if (progress.determinate && progress.current !== undefined && progress.total !== undefined) {
    return {
      mode: "determinate",
      current: progress.current,
      total: progress.total,
      percent: Math.min(100, (progress.current / progress.total) * 100),
      scopeLabel: progress.scopeLabel,
      ...(unit ? { unit } : {}),
      ...(phase ? { phase } : {}),
    };
  }
  if (progress.current !== undefined) {
    return { mode: "count", value: progress.current, scopeLabel: progress.scopeLabel, ...(unit ? { unit } : {}), ...(phase ? { phase } : {}) };
  }
  return { mode: "indeterminate", ...(progress.label ? { label: progress.label } : {}) };
}
