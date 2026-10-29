import { readJsonLines, withFileWriteLock, workspaceFile } from "../../storage/persistence.js";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const TITLE_RENAME_RETRIES = 5;
const TITLE_RENAME_RETRY_MS = 20;

/** Persisted session display titles. Kept in the workspace's private state
 *  root so the conversation list
 *  survives browser changes and cache clears (localStorage is only a
 *  transient fallback). A session id maps to at most one title (upsert). */

export interface SessionTitleRecord {
  session_id: string;
  title: string;
  updated_at: string;
  revision: number;
}

/** Records written before revisions existed count as 0 so an upgrade keeps
 *  compare-and-set working against titles the user already had. */
function revisionOf(record: SessionTitleRecord | undefined): number {
  return record && typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0;
}

function latestRecord(records: SessionTitleRecord[], sessionId: string): SessionTitleRecord | undefined {
  let latest: SessionTitleRecord | undefined;
  for (const record of records) if (record && record.session_id === sessionId) latest = record;
  return latest;
}

/** Who asked for a title. A manual request is the user asking for one, so it
 *  outranks an automatic request that started earlier. */
export type TitleSource = "automatic" | "manual";

/** One generation's place in the session's start order. */
export interface TitleClaim {
  seq: number;
  source: TitleSource;
}

/** True when `claim` may replace a title that `other` wrote: a manual request
 *  always beats an automatic one, and between equals the later start wins. */
function outranks(claim: TitleClaim, other: TitleClaim): boolean {
  return claim.source === other.source ? claim.seq > other.seq : claim.source === "manual";
}

function titleKey(cwd: string, sessionId: string): string {
  return `${cwd}\u0000${sessionId}`;
}

export class SessionTitleRepository {
  /** Start order of title generations. Kept in memory because a generation lives
   *  only for one request: the stored revision says who wrote last, not who
   *  asked last. */
  private nextSeq = new Map<string, number>();
  private newestStart = new Map<string, Record<TitleSource, number>>();

  private file(cwd: string): string {
    return workspaceFile(cwd, "session-titles.jsonl");
  }

  async getTitles(cwd: string): Promise<Map<string, string>> {
    const records = await readJsonLines<SessionTitleRecord>(this.file(cwd));
    const titles = new Map<string, string>();
    for (const record of records) {
      if (record && typeof record.session_id === "string" && typeof record.title === "string" && record.title) {
        // Last write wins (records are appended in write order).
        titles.set(record.session_id, record.title);
      }
    }
    return titles;
  }

  /** Current title and revision, or null when the session has no record.
   *  A record whose title is unusable still reports its revision: a caller that
   *  read 0 there could never win the compare-and-set and the session's title
   *  would stop being regenerable. */
  async getTitleEntry(cwd: string, sessionId: string): Promise<{ title: string; revision: number } | null> {
    const record = latestRecord(await readJsonLines<SessionTitleRecord>(this.file(cwd)), sessionId);
    if (!record) return null;
    return { title: typeof record.title === "string" ? record.title : "", revision: revisionOf(record) };
  }

  /** Upsert a title for a session. Rewrites the file under a lock so a
   *  concurrent rename cannot be lost to an interleaved append. */
  async setTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    const file = this.file(cwd);
    await withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString(), revision: revisionOf(latestRecord(records, sessionId)) + 1 });
      await rewriteTitles(file, next);
    });
  }

  /** Store a derived title only when the session has none, and report what is
   *  stored afterwards. The caller's local name cache belongs to one browser, so
   *  "no local name" cannot prove the session is unnamed: a second browser
   *  backfilling history must not replace a title typed somewhere else. */
  async createTitle(cwd: string, sessionId: string, title: string): Promise<{ applied: boolean; title: string }> {
    const file = this.file(cwd);
    return withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const current = latestRecord(records, sessionId);
      if (current && typeof current.title === "string" && current.title) return { applied: false, title: current.title };
      const revision = revisionOf(current) + 1;
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString(), revision });
      await rewriteTitles(file, next);
      return { applied: true, title };
    });
  }

  /** Claim a place in the session's generation order before the model runs, so
   *  a manual request that starts second still wins when it finishes first. */
  beginGeneration(cwd: string, sessionId: string, source: TitleSource): TitleClaim {
    const key = titleKey(cwd, sessionId);
    const seq = (this.nextSeq.get(key) ?? 0) + 1;
    this.nextSeq.set(key, seq);
    const started = this.newestStart.get(key) ?? { automatic: 0, manual: 0 };
    this.newestStart.set(key, { ...started, [source]: seq });
    return { seq, source };
  }

  /** True when a request that started after this claim beats it. */
  private outranked(key: string, claim: TitleClaim): boolean {
    const started = this.newestStart.get(key);
    if (!started) return false;
    return (started.manual > claim.seq && outranks({ seq: started.manual, source: "manual" }, claim))
      || (started.automatic > claim.seq && outranks({ seq: started.automatic, source: "automatic" }, claim));
  }

  /** Write a generated title. Arbitration, the compare-and-set and the write run
   *  under one lock. A generation commits only while nothing that started later
   *  outranks it and nobody wrote since it started, so the user's newest request
   *  wins whichever finishes first and a title written by hand during the
   *  generation stands. `guard` covers state `deleteTitle` also rewrites: a delete
   *  that lands during generation wins, so the record cannot outlive its session. */
  async commitGeneratedTitle(
    cwd: string,
    sessionId: string,
    title: string,
    claim: TitleClaim,
    expected: number,
    guard?: () => Promise<boolean>,
  ): Promise<{ applied: boolean; revision: number; reason?: "stale" | "gone" }> {
    const key = titleKey(cwd, sessionId);
    const file = this.file(cwd);
    return withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const current = revisionOf(latestRecord(records, sessionId));
      // A request the session already outranks must not touch the file at all:
      // its result is not the one the user asked for last.
      if (this.outranked(key, claim)) return { applied: false, revision: current, reason: "stale" as const };
      // Someone else wrote while this generation ran, so its input is stale.
      if (current !== expected) return { applied: false, revision: current, reason: "stale" as const };
      if (guard && !(await guard())) return { applied: false, revision: current, reason: "gone" as const };
      const revision = current + 1;
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString(), revision });
      await rewriteTitles(file, next);
      return { applied: true, revision };
    });
  }

  async deleteTitle(cwd: string, sessionId: string): Promise<void> {
    const file = this.file(cwd);
    const key = titleKey(cwd, sessionId);
    this.nextSeq.delete(key);
    this.newestStart.delete(key);
    await withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const next = records.filter((record) => record?.session_id !== sessionId);
      if (next.length !== records.length) await rewriteTitles(file, next);
    });
  }
}

async function rewriteTitles(file: string, records: SessionTitleRecord[]): Promise<void> {
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  const content = lines ? `${lines}\n` : "";
  // Atomic replace: write a same-directory temp file, then rename over the
  // target so a crash mid-write cannot truncate the whole title store.
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, content, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EEXIST") throw error;
        if (attempt >= TITLE_RENAME_RETRIES - 1) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, TITLE_RENAME_RETRY_MS * (attempt + 1)));
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export const sessionTitleRepository = new SessionTitleRepository();
