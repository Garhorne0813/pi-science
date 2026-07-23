import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { configRoot } from "./persistence.js";

export interface SseEventRecord {
  event: string | null;
  id: string | null;
  data: string;
  created_at: string;
}

const MAX_EVENT_FILE_BYTES = 20 * 1024 * 1024;
const RETAIN_EVENT_LINES = 5_000;

function eventPath(cwd: string, sessionId: string): string {
  const safeId = createHash("sha256").update(sessionId).digest("hex");
  return join(resolve(cwd), ".pi-science", "events", `${safeId}.jsonl`);
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

export class DurableEventStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    maxEventFileBytes?: number;
    compact?: (path: string, records: SseEventRecord[]) => Promise<void>;
  } = {}) {}

  append(cwd: string, sessionId: string, event: SseEventRecord): Promise<void> {
    const key = `${resolve(cwd)}\0${sessionId}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.appendOrdered(cwd, sessionId, event));
    this.writes.set(key, next);
    void next.then(() => {
      if (this.writes.get(key) === next) this.writes.delete(key);
    }, () => { if (this.writes.get(key) === next) this.writes.delete(key); });
    return next;
  }

  async readAfter(cwd: string, sessionId: string, lastEventId?: string | null): Promise<SseEventRecord[]> {
    const paths = [eventPath(cwd, sessionId), fallbackEventPath(cwd, sessionId)];
    const batches = await Promise.all(paths.map(async (path) => {
      try { return parseRecords(await readFile(path, "utf8")); } catch { return []; }
    }));
    const unique = new Map<string, SseEventRecord>();
    for (const record of batches.flat()) {
      const key = record.id ?? `${record.created_at}:${record.event}:${record.data}`;
      unique.set(key, record);
    }
    const events = [...unique.values()].sort((left, right) => {
      const leftId = String(left.id ?? "");
      const rightId = String(right.id ?? "");
      const leftSeparator = leftId.lastIndexOf(":");
      const rightSeparator = rightId.lastIndexOf(":");
      const leftEpoch = leftSeparator >= 0 ? leftId.slice(0, leftSeparator) : "";
      const rightEpoch = rightSeparator >= 0 ? rightId.slice(0, rightSeparator) : "";
      if (leftEpoch && leftEpoch === rightEpoch) {
        const sequence = Number(leftId.slice(leftSeparator + 1)) - Number(rightId.slice(rightSeparator + 1));
        if (sequence) return sequence;
      }
      const time = left.created_at.localeCompare(right.created_at);
      if (time) return time;
      return String(left.id ?? "").localeCompare(String(right.id ?? ""));
    });
    if (!lastEventId) return events;
    const index = events.findIndex((event) => event.id === lastEventId);
    if (index !== -1) return events.slice(index + 1);
    return [{
      event: "stream.gap",
      id: null,
      data: JSON.stringify({
        type: "stream.gap",
        sessionId,
        missingCursor: lastEventId,
        message: "The requested event cursor is no longer retained; reload the conversation snapshot before applying new deltas.",
      }),
      created_at: new Date().toISOString(),
    }];
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
    await this.compactIfNeeded(target).catch(() => undefined);
  }

  private async appendRecord(path: string, event: SseEventRecord): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async compactIfNeeded(path: string): Promise<void> {
    let size = 0;
    try { size = (await stat(path)).size; } catch { return; }
    if (size <= (this.options.maxEventFileBytes ?? MAX_EVENT_FILE_BYTES)) return;
    const records = parseRecords(await readFile(path, "utf8")).slice(-RETAIN_EVENT_LINES);
    if (this.options.compact) {
      await this.options.compact(path, records);
      return;
    }
    const temporary = `${path}.${process.pid}.compact.tmp`;
    await writeFile(temporary, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    await rename(temporary, path);
  }
}

export const durableEventStore = new DurableEventStore();
