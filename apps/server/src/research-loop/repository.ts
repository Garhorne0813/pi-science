import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendJsonLineUnlocked, metadataRoot, withFileWriteLock } from "../persistence.js";
import { emitResearchEvent } from "./events.js";
import { listReducedLoops, reduceResearchRecords } from "./reducer.js";
import type { ResearchRecord, ResearchSnapshot } from "./types.js";

/** Parsed prefix of an append-only event log, validated by (size, mtimeMs, ino)
 *  plus the trailing bytes of the prefix itself. */
type RecordCache = { size: number; mtimeMs: number; ino: number; consumed: number; records: ResearchRecord[]; tail: ResearchRecord | null; anchor: Buffer };

const recordCaches = new Map<string, RecordCache>();
const ANCHOR_BYTES = 64;

export class ResearchRepository {
  constructor(readonly cwd: string) {}

  private path(): string { return join(metadataRoot(this.cwd), "research-records-v2.jsonl"); }

  records(): Promise<ResearchRecord[]> { return readResearchRecords(this.path()); }

  async loops() { return listReducedLoops(await this.records()); }

  async snapshot(loopId: string): Promise<ResearchSnapshot> {
    return reduceResearchRecords(await this.records(), loopId);
  }

  async locked<T>(operation: (records: ResearchRecord[]) => Promise<T>): Promise<T> {
    return withFileWriteLock(this.path(), async () => operation(await this.records()));
  }

  async appendUnlocked(
    recordType: string,
    payload: Record<string, unknown>,
    extra: Partial<ResearchRecord> = {},
  ): Promise<ResearchRecord> {
    const record: ResearchRecord = {
      schema_version: 2,
      record_id: `record-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      record_type: recordType,
      workspace_id: this.cwd,
      created_at: new Date().toISOString(),
      producer: "node-research-orchestrator",
      payload,
      ...extra,
    };
    await appendJsonLineUnlocked(this.path(), record);
    emitResearchEvent(this.cwd, { type: "research.record", loop_id: record.loop_id, record_type: recordType });
    return record;
  }

  async append(recordType: string, payload: Record<string, unknown>, extra: Partial<ResearchRecord> = {}) {
    return this.locked(() => this.appendUnlocked(recordType, payload, extra));
  }
}

/** Reads the event log incrementally: an unchanged (size, mtimeMs) pair reuses the
 *  parsed records, append-only growth parses only the new byte range, and anything
 *  else (truncation, a new inode, mtime moving backwards, a rewritten prefix)
 *  re-reads in full. The log stays the append-only source of truth — this batch
 *  adds no snapshot or compaction file. */
async function readResearchRecords(path: string): Promise<ResearchRecord[]> {
  const key = resolve(path);
  let info;
  try { info = await stat(key); } catch { recordCaches.delete(key); return []; }
  const cached = recordCaches.get(key);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return listOf(cached);
  const reusable = cached && info.size > cached.size && info.mtimeMs >= cached.mtimeMs && info.ino === cached.ino ? cached : null;
  // Re-read the anchor bytes that end the cached prefix: they prove the file was
  // appended to rather than rewritten to a coincidentally larger size.
  const anchor = reusable ? Math.min(ANCHOR_BYTES, reusable.consumed) : 0;
  const start = (reusable?.consumed ?? 0) - anchor;
  const raw = await readRange(key, start, info.size);
  if (reusable && !raw.subarray(0, anchor).equals(reusable.anchor)) { recordCaches.delete(key); return readResearchRecords(key); }
  const delta = raw.subarray(anchor);
  const records = reusable ? reusable.records : [];
  // Only whole lines are consumed; a torn tail stays unparsed until the writer
  // finishes it, exactly as a cold full-file read would treat it.
  const complete = delta.subarray(0, delta.lastIndexOf(10) + 1);
  for (const line of complete.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as ResearchRecord); } catch { /* tolerate a torn line */ }
  }
  // A final line without its newline is readable but not durable: report it like
  // a cold full read does, without consuming it into the cached prefix.
  const tailText = delta.subarray(complete.length).toString("utf8");
  let tail: ResearchRecord | null = null;
  if (tailText.trim()) { try { tail = JSON.parse(tailText) as ResearchRecord; } catch { /* tolerate a torn tail */ } }
  const consumed = start + anchor + complete.length;
  const entry: RecordCache = {
    size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, consumed, records, tail,
    anchor: Buffer.from(raw.subarray(Math.max(0, anchor + complete.length - ANCHOR_BYTES), anchor + complete.length)),
  };
  recordCaches.set(key, entry);
  return listOf(entry);
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const handle = await open(path, "r");
  try {
    for (let filled = 0; filled < buffer.length; ) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (!bytesRead) return buffer.subarray(0, filled);
      filled += bytesRead;
    }
  } finally { await handle.close(); }
  return buffer;
}

/** Callers get their own array so a later append cannot mutate a list they hold. */
function listOf(entry: RecordCache): ResearchRecord[] {
  const result = entry.records.slice();
  if (entry.tail) result.push(entry.tail);
  return result;
}
