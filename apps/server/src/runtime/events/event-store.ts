import { appendFile, mkdir, readFile, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { configRoot, metadataRoot } from "../../storage/persistence.js";

export interface SseEventRecord {
  event: string | null;
  id: string | null;
  data: string;
  created_at: string;
}

export type EventPublishGuard = () => boolean;

export const MAX_EVENT_FILE_BYTES = 20 * 1024 * 1024;
export const TARGET_EVENT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_RECORDS = 5_000;
export const MAX_EVENT_RECORD_BYTES = 256 * 1024;

class ConditionalAppendRollbackError extends Error {
  constructor() {
    super("conditional event append could not be rolled back safely");
    this.name = "ConditionalAppendRollbackError";
  }
}

// Bounded LRU cache of parsed event logs. A file-count cap is unsafe because
// each file may be close to the compaction threshold. Use the on-disk byte
// size as a conservative memory budget and evict one old file at a time.
const MAX_EVENT_CACHE_BYTES = 64 * 1024 * 1024;
type EventCacheEntry = { mtimeMs: number; size: number; records: SseEventRecord[] };
const eventFileCache = new Map<string, EventCacheEntry>();
let eventFileCacheBytes = 0;

function removeCachedEvents(path: string): void {
  const previous = eventFileCache.get(path);
  if (!previous) return;
  eventFileCache.delete(path);
  eventFileCacheBytes -= previous.size;
}

function cacheParsedEvents(path: string, entry: EventCacheEntry): void {
  removeCachedEvents(path);
  if (entry.size > MAX_EVENT_CACHE_BYTES) return;
  while (eventFileCacheBytes + entry.size > MAX_EVENT_CACHE_BYTES) {
    const oldest = eventFileCache.keys().next().value as string | undefined;
    if (!oldest) break;
    removeCachedEvents(oldest);
  }
  eventFileCache.set(path, entry);
  eventFileCacheBytes += entry.size;
}

async function readParsedEvents(path: string): Promise<SseEventRecord[]> {
  let meta;
  try {
    meta = await stat(path);
  } catch {
    return [];
  }
  const cached = eventFileCache.get(path);
  if (cached && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size) {
    // Map insertion order is the LRU order.
    eventFileCache.delete(path);
    eventFileCache.set(path, cached);
    return cached.records;
  }
  const records = parseRecords(await readFile(path, "utf8"));
  cacheParsedEvents(path, { mtimeMs: meta.mtimeMs, size: meta.size, records });
  return records;
}

function eventPath(cwd: string, sessionId: string): string {
  const safeId = createHash("sha256").update(sessionId).digest("hex");
  return join(metadataRoot(cwd), "events", `${safeId}.jsonl`);
}

function fallbackEventPath(cwd: string, sessionId: string): string {
  const workspaceKey = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24);
  const safeId = createHash("sha256").update(sessionId).digest("hex");
  return join(configRoot(), "events", workspaceKey, `${safeId}.jsonl`);
}

export function parseSseBlock(block: string): SseEventRecord | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (!event && !id && data.length === 0) return null;
  return { event, id, data: data.join("\n"), created_at: new Date().toISOString() };
}

function parseRecords(text: string): SseEventRecord[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as SseEventRecord;
      return parsed && typeof parsed.data === "string" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

export interface ParsedStreamCursor {
  epoch: string;
  sequence: number;
  legacy: boolean;
}

/** Parse both the new opaque `<epoch>:<seq>` cursor and the legacy numeric
 * cursor. Epoch strings are intentionally treated as opaque; callers should
 * never infer ordering from them. */
export function parseStreamCursor(id: string | null): ParsedStreamCursor | null {
  if (!id) return null;
  const separator = id.lastIndexOf(":");
  const value = separator >= 0 ? id.slice(separator + 1) : id;
  if (!/^\d+$/.test(value)) return null;
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) return null;
  if (separator >= 0 && !id.slice(0, separator)) return null;
  return {
    epoch: separator >= 0 ? id.slice(0, separator) : "legacy",
    sequence,
    legacy: separator < 0,
  };
}

function sequenceFromCursor(id: string | null): number | null {
  return parseStreamCursor(id)?.sequence ?? null;
}

function compareEventRecords(left: SseEventRecord, right: SseEventRecord): number {
  const leftId = String(left.id ?? "");
  const rightId = String(right.id ?? "");
  const leftSeparator = leftId.lastIndexOf(":");
  const rightSeparator = rightId.lastIndexOf(":");
  const leftEpoch = leftSeparator >= 0 ? leftId.slice(0, leftSeparator) : "";
  const rightEpoch = rightSeparator >= 0 ? rightId.slice(0, rightSeparator) : "";
  const leftSequence = sequenceFromCursor(left.id);
  const rightSequence = sequenceFromCursor(right.id);
  if (leftSequence !== null && rightSequence !== null && leftEpoch === rightEpoch) {
    const sequence = leftSequence - rightSequence;
    if (sequence) return sequence;
  }
  const time = left.created_at.localeCompare(right.created_at);
  if (time) return time;
  // Different epochs can share a millisecond. Keep their durable append
  // order instead of sorting unrelated UUIDs lexicographically.
  return 0;
}

export class DurableEventStore {
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly options: {
    maxEventFileBytes?: number;
    targetEventFileBytes?: number;
    maxEventRecords?: number;
    maxEventRecordBytes?: number;
    compact?: (path: string, records: SseEventRecord[]) => Promise<void>;
    onCompaction?: (details: {
      path: string;
      beforeBytes: number;
      afterBytes: number;
      retainedRecords: number;
    }) => void;
  } = {}) {}

  append(cwd: string, sessionId: string, event: SseEventRecord): Promise<void> {
    const key = `${resolve(cwd)}\0${sessionId}`;
    return this.enqueueWrite(key, () => this.appendOrdered(cwd, sessionId, event)).then(() => undefined);
  }

  /**
   * Appends an event only while the caller's generation is current. The
   * append is rolled back when the guard changes while the filesystem write
   * is in flight, so a cancelled conditional publication is not replayed.
   */
  appendConditional(cwd: string, sessionId: string, event: SseEventRecord, guard: EventPublishGuard): Promise<boolean> {
    const key = `${resolve(cwd)}\0${sessionId}`;
    return this.enqueueWrite(key, () => this.appendConditionalOrdered(cwd, sessionId, event, guard));
  }

  private enqueueWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writes.set(key, next);
    void next.then(() => {
      if (this.writes.get(key) === next) this.writes.delete(key);
    }, () => { if (this.writes.get(key) === next) this.writes.delete(key); });
    return next;
  }

  async nextSequence(cwd: string, sessionId: string): Promise<number> {
    const records = await this.readAfter(cwd, sessionId);
    return records.reduce((maximum, record) => Math.max(maximum, sequenceFromCursor(record.id) ?? 0), 0);
  }

  async readAfter(cwd: string, sessionId: string, lastEventId?: string | null): Promise<SseEventRecord[]> {
    const paths = [eventPath(cwd, sessionId), fallbackEventPath(cwd, sessionId)];
    const batches = await Promise.all(paths.map((path) => readParsedEvents(path)));
    const unique = new Map<string, SseEventRecord>();
    for (const record of batches.flat()) {
      const key = record.id ?? `${record.created_at}:${record.event}:${record.data}`;
      unique.set(key, record);
    }
    const events = [...unique.values()].sort(compareEventRecords);
    if (!lastEventId) return events.map((event) => ({ ...event }));
    const requestedCursor = parseStreamCursor(lastEventId);
    if (!requestedCursor) return [streamGap(sessionId, "invalid_cursor", { requestedCursor: lastEventId })];
    const index = events.findIndex((event) => event.id === lastEventId);
    if (index === -1) return [streamGap(sessionId, "cursor_missing", { requestedCursor: lastEventId })];

    // Validate the whole replay tail before returning any ordinary event. A
    // client must never apply a suffix after the server has discovered that a
    // durable hole or epoch boundary exists later in the same replay.
    let previous = requestedCursor;
    for (let position = index + 1; position < events.length; position += 1) {
      const current = parseStreamCursor(events[position]?.id ?? null);
      if (!current) {
        return [streamGap(sessionId, "invalid_cursor", {
          requestedCursor: lastEventId,
          expectedSeq: previous.sequence + 1,
          observedSeq: undefined,
        })];
      }
      if (current.epoch !== previous.epoch) {
        return [streamGap(sessionId, "epoch_changed", {
          requestedCursor: lastEventId,
          expectedSeq: previous.sequence + 1,
          observedSeq: current.sequence,
          observedEpoch: current.epoch,
        })];
      }
      if (current.sequence !== previous.sequence + 1) {
        return [streamGap(sessionId, "sequence_hole", {
          requestedCursor: lastEventId,
          expectedSeq: previous.sequence + 1,
          observedSeq: current.sequence,
          observedEpoch: current.epoch,
        })];
      }
      previous = current;
    }
    return events.slice(index + 1).map((event) => ({ ...event }));
  }

  private async appendOrdered(cwd: string, sessionId: string, event: SseEventRecord): Promise<void> {
    const primary = eventPath(cwd, sessionId);
    let target = primary;
    try {
      await this.appendRecord(primary, event);
    } catch {
      target = fallbackEventPath(cwd, sessionId);
      await this.appendRecord(target, event);
    }
    // The file's size/mtime changed, so any cached parse is stale.
    removeCachedEvents(target);
    await this.compactIfNeeded(target).catch(() => undefined);
  }

  private async appendConditionalOrdered(cwd: string, sessionId: string, event: SseEventRecord, guard: EventPublishGuard): Promise<boolean> {
    if (!guard()) return false;
    const primary = eventPath(cwd, sessionId);
    let target = primary;
    let appended: boolean;
    try {
      appended = await this.appendRecordConditional(primary, event, guard);
    } catch (error) {
      if (error instanceof ConditionalAppendRollbackError) throw error;
      if (!guard()) return false;
      target = fallbackEventPath(cwd, sessionId);
      appended = await this.appendRecordConditional(target, event, guard);
    }
    if (!appended) return false;
    // Compaction is still required for guarded publications: normal runtime
    // events use this path, so skipping it would let a busy turn grow past the
    // journal bound indefinitely. A guard change after the append only
    // suppresses live delivery; the durable record remains replayable from its
    // contiguous cursor and may safely be compacted here.
    removeCachedEvents(target);
    await this.compactIfNeeded(target).catch(() => undefined);
    return true;
  }

  private async appendRecord(path: string, event: SseEventRecord): Promise<void> {
    this.assertRecordSize(event);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async appendRecordConditional(path: string, event: SseEventRecord, guard: EventPublishGuard): Promise<boolean> {
    this.assertRecordSize(event);
    if (!guard()) return false;
    await mkdir(dirname(path), { recursive: true });
    let existed = true;
    let originalSize = 0;
    try { originalSize = (await stat(path)).size; }
    catch { existed = false; }
    if (!guard()) return false;
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
    if (guard()) return true;
    let rollbackFailed = false;
    try {
      await truncate(path, originalSize);
      if (!existed && originalSize === 0) await unlink(path);
    } catch { rollbackFailed = true; }
    removeCachedEvents(path);
    if (rollbackFailed) throw new ConditionalAppendRollbackError();
    return false;
  }

  private async compactIfNeeded(path: string): Promise<void> {
    let size = 0;
    try { size = (await stat(path)).size; } catch { return; }
    if (size <= (this.options.maxEventFileBytes ?? MAX_EVENT_FILE_BYTES)) return;
    const targetBytes = Math.min(
      this.options.targetEventFileBytes ?? TARGET_EVENT_FILE_BYTES,
      this.options.maxEventFileBytes ?? MAX_EVENT_FILE_BYTES,
    );
    const maxRecords = this.options.maxEventRecords ?? MAX_EVENT_RECORDS;
    const records = parseRecords(await readFile(path, "utf8"));
    const retained: SseEventRecord[] = [];
    let retainedBytes = 0;
    for (let index = records.length - 1; index >= 0 && retained.length < maxRecords; index -= 1) {
      const record = records[index]!;
      const recordBytes = serializedRecordBytes(record);
      // Always retain the newest record, even if a test configuration makes
      // the target smaller than one valid record. The single-record bound is
      // enforced before this point, so the headroom remains finite.
      if (retained.length > 0 && retainedBytes + recordBytes > targetBytes) break;
      retained.unshift(record);
      retainedBytes += recordBytes;
    }
    if (this.options.compact) {
      await this.options.compact(path, retained);
      this.reportCompaction(path, size, retained.length);
      return;
    }
    const temporary = `${path}.${process.pid}.compact.tmp`;
    try {
      await writeFile(temporary, retained.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      await rename(temporary, path);
      const afterBytes = await stat(path).then((metadata) => metadata.size).catch(() => 0);
      this.options.onCompaction?.({ path, beforeBytes: size, afterBytes, retainedRecords: retained.length });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private assertRecordSize(event: SseEventRecord): void {
    const bytes = serializedRecordBytes(event);
    const limit = this.options.maxEventRecordBytes ?? MAX_EVENT_RECORD_BYTES;
    if (bytes > limit) throw new Error(`event record exceeds ${limit} serialized bytes`);
  }

  private reportCompaction(path: string, beforeBytes: number, retainedRecords: number): void {
    // Custom compaction hooks own the write. Read the resulting size only for
    // diagnostics and never let a logging callback break event delivery.
    void stat(path).then((metadata) => {
      try { this.options.onCompaction?.({ path, beforeBytes, afterBytes: metadata.size, retainedRecords }); }
      catch { /* diagnostics are best effort */ }
    }).catch(() => undefined);
  }
}

function serializedRecordBytes(record: SseEventRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
}

function streamGap(
  sessionId: string,
  reason: "cursor_missing" | "sequence_hole" | "epoch_changed" | "invalid_cursor",
  details: { requestedCursor?: string; expectedSeq?: number; observedSeq?: number; observedEpoch?: string },
): SseEventRecord {
  return {
    event: "stream.gap",
    id: null,
    data: JSON.stringify({
      type: "stream.gap",
      sessionId,
      reason,
      requestedCursor: details.requestedCursor,
      // Keep the old field during the compatibility window.
      missingCursor: details.requestedCursor,
      expectedSeq: details.expectedSeq,
      observedSeq: details.observedSeq,
      observedEpoch: details.observedEpoch,
      message: "The requested event cursor cannot be replayed continuously; reload the conversation snapshot before applying new deltas.",
    }),
    created_at: new Date().toISOString(),
  };
}

export const durableEventStore = new DurableEventStore();
