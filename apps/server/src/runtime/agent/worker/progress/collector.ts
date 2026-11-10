import {
  mergeToolProgress,
  normalizeToolProgress,
  TOOL_PROGRESS_LIMITS,
  type ToolProgressV1,
} from "@pi-science/contracts";
import { controlLines } from "./control-lines.js";
import type { ProgressAdapter, ProgressObservation } from "./types.js";

/** Fast enough that a bar moves while the work runs, slow enough that a tool
 *  writing ten thousand updates a second costs ten thousand renders and not
 *  more. The harness publishes output no faster than every 100 ms, so in
 *  practice only the burst case is dropped. */
export const PROGRESS_PUBLISH_INTERVAL_MS = 150;

export interface ToolProgressCollectorOptions {
  /** The command text, so a tool-specific adapter can decide whether it
   *  applies. */
  command: string;
  adapters: readonly ProgressAdapter[];
  intervalMs?: number;
  now?: () => number;
}

export interface ToolProgressReading {
  /** Output text with the control records removed. */
  text: string;
  /** Present only when this update should carry a new progress value. Every
   *  update carries the text, so a throttled reading still renders output. */
  progress?: ToolProgressV1;
}

/** Turns the output of one running tool call into at most one progress value at
 *  a time.
 *
 *  One instance belongs to one attempt of one tool call, so identity cannot
 *  leak between calls. Inside that attempt the collector owns the questions the
 *  contract does not answer: which adapter's scope is on screen, when a count
 *  that went backwards is a restart rather than a replay, and how often a
 *  refreshed value reaches the UI.
 *
 *  Nothing here reads a percentage from prose. A determinate value exists only
 *  where an adapter reported a real current and a real total. */
export class ToolProgressCollector {
  readonly #adapters: readonly ProgressAdapter[];
  readonly #intervalMs: number;
  readonly #now: () => number;
  #current: ToolProgressV1 | undefined;
  #published: ToolProgressV1 | undefined;
  #pending: ToolProgressV1 | undefined;
  #lastPublishedAt = Number.NEGATIVE_INFINITY;
  #closed = false;

  constructor(options: ToolProgressCollectorOptions) {
    this.#adapters = options.adapters.filter(
      (adapter) => adapter.matches?.(options.command) ?? true,
    );
    this.#intervalMs = options.intervalMs ?? PROGRESS_PUBLISH_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The value the collector would hand out right now. Exposed for tests and
   *  for the pre-invocation snapshot. */
  get current(): ToolProgressV1 | undefined {
    return this.#current;
  }

  /** Read one accumulated output snapshot.
   *
   *  Reading the whole text rather than a delta means a split chunk, a repeated
   *  snapshot and a truncated tail all resolve to the same state. */
  observe(raw: string): ToolProgressReading {
    if (this.#closed) return { text: controlLines(raw).visible };
    const { visible } = controlLines(raw);
    const next = this.#read(raw, visible);
    if (next) this.#adopt(next);
    const due = this.#flushIfDue();
    return { text: visible, ...(due ? { progress: due } : {}) };
  }

  /** Final reading. The last value always reaches the UI, whatever the throttle
   *  decided about the value before it. */
  finish(raw?: string): ToolProgressReading {
    const text = raw === undefined ? "" : controlLines(raw).visible;
    if (this.#closed) return { text };
    if (raw !== undefined) {
      const next = this.#read(raw, text);
      if (next) this.#adopt(next);
    }
    this.#closed = true;
    this.#pending = undefined;
    if (this.#current === undefined || sameValue(this.#current, this.#published)) return { text };
    this.#published = this.#current;
    return { text, progress: this.#current };
  }

  /** The visible scope comes from the first registered adapter that reports
   *  anything, and inside that adapter from its newest observation. Ordering is
   *  by registry, so an explicit protocol beats a text guess and two adapters
   *  cannot argue about one row. A second concurrent scope is deliberately not
   *  shown: one `ToolProgressV1` describes one scope, and adding them together
   *  would invent a number neither producer made. */
  #read(raw: string, visible: string): ToolProgressV1 | undefined {
    for (const adapter of this.#adapters) {
      let observations: readonly ProgressObservation[];
      try {
        observations = adapter.read(adapter.readsControlLines ? raw : visible);
      } catch {
        continue;
      }
      const last = observations.at(-1);
      if (!last) continue;
      const value = toProgress(adapter.id, last);
      if (value) return value;
    }
    return undefined;
  }

  #adopt(next: ToolProgressV1): void {
    const current = this.#current;
    if (!current || current.scopeId !== next.scopeId) {
      this.#current = next;
      this.#pending = next;
      return;
    }
    // A count that went backwards inside one scope is normally a replayed
    // event, and the measured value stays. Once the scope has reported its
    // total, a lower count is the next cycle of the same named work, so it
    // resets instead. Without the reset a loop that runs a named bar twice
    // would freeze at its first total.
    const finished =
      current.current !== undefined &&
      current.total !== undefined &&
      current.current >= current.total;
    const restarted =
      finished &&
      next.current !== undefined &&
      current.current !== undefined &&
      next.current < current.current;
    const merged = restarted ? next : mergeToolProgress(current, next);
    if (!merged) return;
    this.#current = merged;
    if (!sameValue(merged, this.#published)) this.#pending = merged;
  }

  #flushIfDue(): ToolProgressV1 | undefined {
    const pending = this.#pending;
    if (!pending) return undefined;
    const now = this.#now();
    if (now - this.#lastPublishedAt < this.#intervalMs) return undefined;
    this.#pending = undefined;
    this.#published = pending;
    this.#lastPublishedAt = now;
    return pending;
  }
}

/** A namespaced scope id longer than the contract allows is dropped rather than
 *  truncated, because two ids that share a prefix would become one scope. */
function toProgress(
  adapterId: string,
  observation: ProgressObservation,
): ToolProgressV1 | undefined {
  const scopeId = `${adapterId}:${observation.scopeId}`;
  if (scopeId.length > TOOL_PROGRESS_LIMITS.scopeId) return undefined;
  return normalizeToolProgress({
    version: 1,
    scopeId,
    scopeLabel: observation.scopeLabel,
    totalKind: observation.totalKind ?? "unknown",
    source: "builtin",
    ...(observation.current === undefined ? {} : { current: observation.current }),
    ...(observation.total === undefined ? {} : { total: observation.total }),
    ...(observation.percent === undefined ? {} : { percent: observation.percent }),
    ...(observation.unit === undefined ? {} : { unit: observation.unit }),
    ...(observation.phase === undefined ? {} : { phase: observation.phase }),
    ...(observation.label === undefined ? {} : { label: observation.label }),
    ...(observation.indeterminate === true ? { indeterminate: true } : {}),
  });
}

function sameValue(left: ToolProgressV1 | undefined, right: ToolProgressV1 | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return key(left) === key(right);
}

function key(value: ToolProgressV1): string {
  return [
    value.scopeId,
    value.scopeLabel,
    value.current ?? "",
    value.total ?? "",
    value.percent ?? "",
    value.totalKind,
    value.unit ?? "",
    value.phase ?? "",
    value.label ?? "",
    value.indeterminate === true ? "1" : "",
  ].join("\u001f");
}
