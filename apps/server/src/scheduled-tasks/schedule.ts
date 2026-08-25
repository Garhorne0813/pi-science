// Pure scheduling math for scheduled tasks (docs §5). Every time computation
// takes the current instant as an injected millisecond value — no implicit
// `new Date()` except as an explicit parameter default (cronPreview.fromMs).
import { CronExpressionParser, type CronExpression } from "cron-parser";
import {
  scheduledTaskScheduleSchema,
  type MisfirePolicy,
  type ScheduledCronSchedule,
  type ScheduledTaskSchedule,
} from "@pi-science/contracts";
import { invalidSchedule, invalidTimezone, policyViolation } from "./errors.js";

/** docs §5.7: fixed misfire grace window; callers may inject for tests. */
export const MISFIRE_GRACE_MS = 60_000;
/** docs §5.3/§5.4: first-version minimum frequency is 300 seconds. */
export const MIN_INTERVAL_SECONDS = 300;
/** Upper bound for cron misfire scans so a pathological backlog cannot hang recovery (docs Phase 2 note). */
const MAX_MISFIRE_SCAN = 100_000;
/** Upper bound for defensive next() loops that must strictly advance past a start point. */
const MAX_STRICT_ADVANCE_STEPS = 1_000;

const businessDateFormatters = new Map<string, Intl.DateTimeFormat>();
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

let supportedTimezonesCache: Set<string> | null | undefined;

/** Platform zone list (docs §13.2); null on engines without supportedValuesOf. */
function supportedTimezones(): Set<string> | null {
  if (supportedTimezonesCache === undefined) {
    try {
      supportedTimezonesCache = new Set(Intl.supportedValuesOf("timeZone"));
    } catch {
      supportedTimezonesCache = null;
    }
  }
  return supportedTimezonesCache;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return false;
  }
  // The ICU probe alone also accepts fixed-offset strings like "+08:00";
  // when the platform exposes the IANA zone list it is authoritative, with
  // "UTC" always allowed because V8 omits it from that list.
  const supported = supportedTimezones();
  return supported ? supported.has(timezone) || timezone === "UTC" : true;
}

function assertTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) throw invalidTimezone(timezone);
}

/**
 * Single cron parser wrapper shared by firstOccurrence, misfire scanning and
 * cronPreview (docs §5.4: preview and scheduler must use the same wrapper).
 * Rejects anything but exactly 5 whitespace-separated fields before handing the
 * expression to cron-parser, so 6-field seconds forms and @predefined names are
 * INVALID_SCHEDULE.
 */
function parseCron(expression: string, timezone: string, afterMs?: number): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw invalidSchedule(`cron expression must have exactly 5 fields, got ${fields.length}`, { expression });
  }
  try {
    return CronExpressionParser.parse(expression.trim(), {
      tz: timezone,
      currentDate: afterMs === undefined ? undefined : new Date(afterMs),
    });
  } catch (error) {
    throw invalidSchedule(`invalid cron expression: ${error instanceof Error ? error.message : String(error)}`, { expression });
  }
}

/** Parse + semantically validate a schedule value (IANA probe, real instants, parser acceptance). */
export function validateSchedule(schedule: unknown): ScheduledTaskSchedule {
  let parsed: ScheduledTaskSchedule;
  try {
    parsed = scheduledTaskScheduleSchema.parse(schedule);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidSchedule(`invalid schedule: ${message}`);
  }
  assertTimezone(parsed.timezone);
  if (parsed.type === "once" && Number.isNaN(Date.parse(parsed.at))) {
    throw invalidSchedule("once.at is not a real calendar instant", { at: parsed.at });
  }
  if (parsed.type === "interval" && Number.isNaN(Date.parse(parsed.anchor_at))) {
    throw invalidSchedule("interval.anchor_at is not a real UTC instant", { anchor_at: parsed.anchor_at });
  }
  if (parsed.type === "cron") parseCron(parsed.expression, parsed.timezone);
  return parsed;
}

/**
 * First occurrence strictly greater than afterMs, or null when none exists
 * (only `once` can end). Interval occurrences sit on the fixed anchor grid
 * occurrence(n) = anchor_at + n * every_seconds, n >= 1 (docs §5.3) — computed
 * in closed form so executor runtime can never drift the grid.
 */
export function firstOccurrence(schedule: ScheduledTaskSchedule, afterMs: number): number | null {
  switch (schedule.type) {
    case "once": {
      const at = Date.parse(schedule.at);
      return Number.isNaN(at) || at <= afterMs ? null : at;
    }
    case "interval": {
      const anchorMs = Date.parse(schedule.anchor_at);
      const stepMs = schedule.every_seconds * 1000;
      let n = Math.floor((afterMs - anchorMs) / stepMs) + 1;
      if (!Number.isSafeInteger(n) || n < 1) n = 1;
      const occurrence = anchorMs + n * stepMs;
      return occurrence > afterMs ? occurrence : null;
    }
    case "cron": {
      const expression = parseCron(schedule.expression, schedule.timezone, afterMs + 1);
      for (let steps = 0; steps < MAX_STRICT_ADVANCE_STEPS; steps++) {
        const candidate = expression.next().getTime();
        if (candidate > afterMs) return candidate;
      }
      throw policyViolation("cron iteration did not advance past the requested instant", { expression: schedule.expression });
    }
  }
}

interface MisfireWindow {
  /** First missed occurrence (= the persisted next_run_at that went stale). */
  from: number;
  /** Most recent missed occurrence ≤ nowMs; coalesce runs land here. */
  through: number;
}

export interface AdvanceNextRunAtResult {
  next_run_at: number | null;
  missed: MisfireWindow | null;
  action: "none" | "due" | "coalesce" | "skip";
}

/**
 * docs §5.7 misfire semantics against the persisted next_run_at chain.
 * - currentNextMs > nowMs → "none".
 * - overdue within graceMs → "due" (scheduled_for = currentNextMs).
 * - overdue beyond grace → policy decides: coalesce_latest → one reconcile run
 *   at the latest missed point; skip → terminal skipped run. Both advance
 *   next_run_at to the first future occurrence without replaying each missed
 *   point. scheduled_for is derived by the caller: due → currentNextMs,
 *   coalesce/skip → missed.through.
 * `once` never returns a future next_run_at; the caller completes the task on
 * claim (docs §4.1).
 */
export function advanceNextRunAt(
  schedule: ScheduledTaskSchedule,
  currentNextMs: number,
  nowMs: number,
  misfirePolicy: MisfirePolicy,
  graceMs: number = MISFIRE_GRACE_MS,
): AdvanceNextRunAtResult {
  if (currentNextMs > nowMs) return { next_run_at: currentNextMs, missed: null, action: "none" };
  // Advance past the later of the stale point and now so the persisted chain
  // never lands back inside the already-elapsed window.
  const nextRunAt = firstOccurrence(schedule, Math.max(currentNextMs, nowMs));
  if (nowMs - currentNextMs <= graceMs) return { next_run_at: nextRunAt, missed: null, action: "due" };
  const missed: MisfireWindow = { from: currentNextMs, through: lastMissedOccurrenceMs(schedule, currentNextMs, nowMs) };
  return { next_run_at: nextRunAt, missed, action: misfirePolicy === "coalesce_latest" ? "coalesce" : "skip" };
}

/** Latest missed occurrence ≤ nowMs without materializing the whole window. */
function lastMissedOccurrenceMs(schedule: ScheduledTaskSchedule, currentNextMs: number, nowMs: number): number {
  switch (schedule.type) {
    case "once":
      return currentNextMs;
    case "interval": {
      // Closed form: both endpoints sit on the anchor grid, no iteration.
      const anchorMs = Date.parse(schedule.anchor_at);
      const stepMs = schedule.every_seconds * 1000;
      const currentIndex = Math.round((currentNextMs - anchorMs) / stepMs);
      const lastIndex = Math.floor((nowMs - anchorMs) / stepMs);
      return anchorMs + Math.max(currentIndex, lastIndex) * stepMs;
    }
    case "cron": {
      // Walk the shared parser iterator forward, keeping only the most recent
      // missed point; bounded so years-long outages stay cheap.
      const expression = parseCron(schedule.expression, schedule.timezone, currentNextMs);
      let latest = currentNextMs;
      for (let scanned = 0; scanned < MAX_MISFIRE_SCAN; scanned++) {
        const candidate = expression.next().getTime();
        if (candidate <= currentNextMs) continue;
        if (candidate > nowMs) break;
        latest = candidate;
      }
      return latest;
    }
  }
}

/** YYYY-MM-DD of an instant inside the task timezone (docs §5.6), e.g. en-CA → "2026-03-08". */
export function businessDateFor(scheduledForMs: number, timezone: string): string {
  let formatter = businessDateFormatters.get(timezone);
  if (!formatter) {
    assertTimezone(timezone);
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    businessDateFormatters.set(timezone, formatter);
  }
  return formatter.format(scheduledForMs);
}

export interface CronPreviewEntry {
  timestamp_ms: number;
  /** UTC ISO 8601 instant. */
  utc: string;
  /** Local wall clock "YYYY-MM-DD HH:mm" in the schedule timezone (docs §13.2 preview layout). */
  local: string;
}

function localWallClock(timestampMs: number, timezone: string): string {
  let formatter = wallClockFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    wallClockFormatters.set(timezone, formatter);
  }
  // en-CA yields "2026-03-08, 03:30"; normalize to the space-separated doc form.
  return formatter.format(timestampMs).replace(", ", " ");
}

/**
 * Server-authoritative preview of the next `count` cron occurrences after
 * fromMs, pairing each UTC instant with its local wall clock in the schedule
 * timezone. Uses the same parser wrapper as the scheduler (docs §5.4).
 */
export function cronPreview(
  schedule: ScheduledCronSchedule,
  count: number = 3,
  fromMs: number = Date.now(),
): CronPreviewEntry[] {
  assertTimezone(schedule.timezone);
  const expression = parseCron(schedule.expression, schedule.timezone, fromMs);
  const entries: CronPreviewEntry[] = [];
  for (let i = 0; i < count; i++) {
    const timestampMs = expression.next().getTime();
    if (timestampMs <= fromMs) continue;
    entries.push({ timestamp_ms: timestampMs, utc: new Date(timestampMs).toISOString(), local: localWallClock(timestampMs, schedule.timezone) });
  }
  return entries;
}
