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
}

export class SessionTitleRepository {
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
