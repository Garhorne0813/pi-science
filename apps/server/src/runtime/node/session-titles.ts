import { readJsonLines, withFileWriteLock, workspaceFile } from "../../storage/persistence.js";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const TITLE_RENAME_RETRIES = 5;
const TITLE_RENAME_RETRY_MS = 20;

/** Persisted session display titles. Kept in
 *  `<workspace>/.pi-science/session-titles.jsonl` so the conversation list
 *  survives browser changes and cache clears (localStorage is only a
 *  transient fallback). A session id maps to at most one title (upsert). */

export interface SessionTitleRecord {
  session_id: string;
  title: string;
  updated_at: string;
  /** True when the title is a client-derived fallback (first user message)
   *  that an AI title may still replace; absent on legacy records, which are
   *  treated as final so existing stores keep their protection. */
  derived?: boolean;
}

export class SessionTitleRepository {
  private file(cwd: string): string {
    return workspaceFile(cwd, "session-titles.jsonl");
  }

  async getTitles(cwd: string): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    for (const [sessionId, record] of await this.getTitleRecords(cwd)) titles.set(sessionId, record.title);
    return titles;
  }

  /** Full records (including the derived-vs-final flag), last write wins
   *  (records are appended in write order). */
  async getTitleRecords(cwd: string): Promise<Map<string, SessionTitleRecord>> {
    const records = await readJsonLines<SessionTitleRecord>(this.file(cwd));
    const titles = new Map<string, SessionTitleRecord>();
    for (const record of records) {
      if (record && typeof record.session_id === "string" && typeof record.title === "string" && record.title) {
        titles.set(record.session_id, record);
      }
    }
    return titles;
  }

  /** Upsert a title for a session. Rewrites the file under a lock so a
   *  concurrent rename cannot be lost to an interleaved append. */
  async setTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    const file = this.file(cwd);
    await withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString() });
      await rewriteTitles(file, next);
    });
  }

  /** Store a generated (final) title only when no final title exists; a
   *  derived fallback is replaced. The check and write share one file lock so
   *  a concurrent explicit rename cannot be replaced by a late AI result.
   *  When `confirmExists` is provided it is evaluated under the same lock, so
   *  a session deleted while generation ran cannot leave an orphan record.
   *  Returns the title that remains authoritative, or null when the write was
   *  skipped because the session no longer exists. */
  async setTitleIfAbsent(
    cwd: string,
    sessionId: string,
    title: string,
    confirmExists?: () => Promise<boolean>,
  ): Promise<string | null> {
    const file = this.file(cwd);
    let authoritative: string | null = title;
    await withFileWriteLock(file, async () => {
      if (confirmExists && !(await confirmExists())) {
        authoritative = null;
        return;
      }
      const records = await readJsonLines<SessionTitleRecord>(file);
      const existing = records.find((record) => record?.session_id === sessionId && record.title && !record.derived);
      if (existing?.title) {
        authoritative = existing.title;
        return;
      }
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString() });
      await rewriteTitles(file, next);
    });
    return authoritative;
  }

  /** Store a client-derived fallback title without ever replacing a final
   *  (AI or explicit) title: a late derived write must not clobber the user's
   *  chosen name, but repeated derivations may refresh the fallback. */
  async setDerivedTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    const file = this.file(cwd);
    await withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const existing = records.find((record) => record?.session_id === sessionId && record.title && !record.derived);
      if (existing?.title) return;
      const next = records.filter((record) => record?.session_id !== sessionId);
      next.push({ session_id: sessionId, title, updated_at: new Date().toISOString(), derived: true });
      await rewriteTitles(file, next);
    });
  }

  /** Atomically carry a persisted title from a replaced session id to its
   *  replacement (runtime restarts issue new ids). Runs under the file lock so
   *  a concurrent conditional write cannot be lost. Idempotent: when the old id
   *  has no record (already moved or never titled) nothing changes. The
   *  derived/final distinction travels with the record so an AI title can
   *  still replace a moved fallback, and the same precedence as the other
   *  writers applies at the destination: a derived fallback never displaces
   *  anything, and a destination that already owns a final title keeps it. */
  async moveTitle(cwd: string, previousId: string, nextId: string): Promise<void> {
    if (!previousId || !nextId || previousId === nextId) return;
    const file = this.file(cwd);
    await withFileWriteLock(file, async () => {
      const records = await readJsonLines<SessionTitleRecord>(file);
      const previous = records.find((record) => record?.session_id === previousId && record.title);
      if (!previous) return;
      const withoutPrevious = records.filter((record) => record?.session_id !== previousId);
      const destination = records.find((record) => record?.session_id === nextId && record.title);
      if (destination && (!destination.derived || previous.derived === true)) {
        // The destination keeps its own title; the replaced session's stale
        // record is simply dropped.
        await rewriteTitles(file, withoutPrevious);
        return;
      }
      const next = withoutPrevious.filter((record) => record?.session_id !== nextId);
      next.push({
        session_id: nextId,
        title: previous.title,
        updated_at: previous.updated_at,
        ...(previous.derived ? { derived: true } : {}),
      });
      await rewriteTitles(file, next);
    });
  }

  async deleteTitle(cwd: string, sessionId: string): Promise<void> {
    const file = this.file(cwd);
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
