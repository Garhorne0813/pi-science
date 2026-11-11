/** Structured progress for one running tool call.
 *
 *  A percentage is a claim about a measurement, so this module is the only
 *  place that decides one can be shown. Producers describe their work scope and
 *  either a count or a count with a fixed total. Everything else, including an
 *  external party asserting a percentage, degrades to a count or to no number
 *  at all. Nothing here reads output text, elapsed time or model prose. */

export const TOOL_PROGRESS_LIMITS = {
  scopeId: 64,
  scopeLabel: 100,
  phase: 64,
  label: 160,
  unit: 24,
} as const;

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
  /** A share the producer published in its own output together with a
   *  denominator it did not print, such as a transfer reading `45%`. Accepted
   *  only inside 0-100: an out-of-range share rejects the whole payload rather
   *  than being clamped, because a clamped number is a number nobody made. */
  percent?: number;
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
  | { mode: "percent"; value: number; scopeLabel: string; phase?: string }
  | {
      mode: "estimated";
      current: number;
      total: number;
      percent: number;
      scopeLabel: string;
      unit?: string;
      phase?: string;
    }
  | {
      mode: "determinate";
      current: number;
      total: number;
      percent: number;
      scopeLabel: string;
      unit?: string;
      phase?: string;
    };

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

/** A scope identity is compared with another identity, so it is never
 *  shortened. Two different ids that share a prefix would become one scope and
 *  merge two measurements into one. A visible label may be truncated; an
 *  identity may only be accepted as written or rejected. */
function identity(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= limit ? trimmed : undefined;
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

/** One rule decides whether a number is a measurement, for a parsed value and
 *  for a merged one alike, so the two paths cannot disagree. */
function determined(value: Omit<ToolProgressV1, "determinate">): ToolProgressV1 {
  const { current, total } = value;
  return {
    ...value,
    determinate:
      value.indeterminate !== true &&
      value.totalKind === "fixed" &&
      current !== undefined &&
      total !== undefined &&
      total > 0 &&
      current <= total,
  };
}

/** Parse progress arriving from a tool, an MCP server or a kernel. An
 *  out-of-range or missing number is dropped rather than repaired, and a
 *  missing scope identity rejects the whole payload because a bare number with
 *  no named scope cannot be described honestly. */
export function normalizeToolProgress(raw: unknown): ToolProgressV1 | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return undefined;
  const scopeId = identity(value.scopeId, TOOL_PROGRESS_LIMITS.scopeId);
  const scopeLabel = boundedText(value.scopeLabel, TOOL_PROGRESS_LIMITS.scopeLabel);
  if (!scopeId || !scopeLabel) return undefined;
  const current = count(value.current);
  const total = count(value.total);
  const percent = count(value.percent);
  if (value.percent !== undefined && (percent === undefined || percent > 100)) return undefined;
  const kind = totalKind(value.totalKind);
  const indeterminate = value.indeterminate === true;
  const phase = boundedText(value.phase, TOOL_PROGRESS_LIMITS.phase);
  const label = boundedText(value.label, TOOL_PROGRESS_LIMITS.label);
  const unit = boundedText(value.unit, TOOL_PROGRESS_LIMITS.unit);
  const origin = source(value.source);
  return determined({
    version: 1,
    scopeId,
    scopeLabel,
    totalKind: kind,
    ...(current === undefined ? {} : { current }),
    ...(total === undefined ? {} : { total }),
    ...(percent === undefined ? {} : { percent }),
    ...(phase ? { phase } : {}),
    ...(label ? { label } : {}),
    ...(unit ? { unit } : {}),
    ...(indeterminate ? { indeterminate } : {}),
    ...(origin ? { source: origin } : {}),
  });
}

/** Fold one update into the value already on screen. A missing update keeps the
 *  current value, so an output-only message cannot clear the progress layer. An
 *  update inside one scope that repeats no number is a wording change: the
 *  measurement and the unit it counts stay, because a producer that reports only
 *  a phase has not measured zero. A lower count inside one scope is a stale or
 *  replayed event: the measured value stays and only the newer wording is taken.
 *  A new scope is the only thing that resets the numbers. */
export function mergeToolProgress(
  previous: ToolProgressV1 | undefined,
  next: ToolProgressV1 | undefined,
): ToolProgressV1 | undefined {
  if (!next) return previous;
  if (!previous || previous.scopeId !== next.scopeId) return next;
  if (next.current === undefined && next.total === undefined)
    return inheritMeasurement(previous, next);
  if (
    previous.current !== undefined &&
    next.current !== undefined &&
    next.current < previous.current
  ) {
    return determined({
      ...previous,
      ...(next.phase ? { phase: next.phase } : {}),
      ...(next.label ? { label: next.label } : {}),
    });
  }
  return next.current === undefined && previous.current !== undefined
    ? determined({ ...next, current: previous.current })
    : next;
}

/** A wording-only update keeps the measurement it does not repeat. */
function inheritMeasurement(previous: ToolProgressV1, next: ToolProgressV1): ToolProgressV1 {
  return determined({
    ...next,
    totalKind: previous.totalKind,
    ...(next.current === undefined && previous.current !== undefined
      ? { current: previous.current }
      : {}),
    ...(next.total === undefined && previous.total !== undefined ? { total: previous.total } : {}),
    ...(next.percent === undefined && previous.percent !== undefined
      ? { percent: previous.percent }
      : {}),
    ...(next.unit === undefined && previous.unit !== undefined ? { unit: previous.unit } : {}),
  });
}

/** The display tiers. A running row without a measurement yet is
 *  indeterminate; a settled row keeps the producer's last measurement, because
 *  the layer reports what was measured rather than what state the row is in —
 *  the row's own marker carries the state, so a frozen bar must never read as
 *  success. A fixed total is a measurement, a revisable total is still drawn
 *  but only the text calls it an estimate, and a producer's own percentage has
 *  no denominator to divide, so it keeps the producer's number instead of
 *  inventing a total. */
export function selectToolProgressDisplay(
  status: ToolProgressStatus,
  progress: ToolProgressV1 | undefined,
): ToolProgressDisplay {
  if (!progress) return status === "running" ? { mode: "indeterminate" } : { mode: "hidden" };
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
  if (
    progress.totalKind === "reestimated" &&
    progress.current !== undefined &&
    progress.total !== undefined &&
    progress.total > 0 &&
    progress.current <= progress.total
  ) {
    return {
      mode: "estimated",
      current: progress.current,
      total: progress.total,
      percent: Math.min(100, (progress.current / progress.total) * 100),
      scopeLabel: progress.scopeLabel,
      ...(unit ? { unit } : {}),
      ...(phase ? { phase } : {}),
    };
  }
  if (progress.percent !== undefined && progress.total === undefined) {
    return {
      mode: "percent",
      value: progress.percent,
      scopeLabel: progress.scopeLabel,
      ...(phase ? { phase } : {}),
    };
  }
  if (progress.current !== undefined) {
    return {
      mode: "count",
      value: progress.current,
      scopeLabel: progress.scopeLabel,
      ...(unit ? { unit } : {}),
      ...(phase ? { phase } : {}),
    };
  }
  return { mode: "indeterminate", ...(progress.label ? { label: progress.label } : {}) };
}
