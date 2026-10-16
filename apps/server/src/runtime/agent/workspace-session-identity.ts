import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type JsonlSessionRepo, type JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";

/** Use the filesystem's spelling, including Windows casing and directory aliases. */
export function workspaceIdentity(cwd: string): string {
  const path = resolve(cwd);
  try { return realpathSync.native(path); }
  catch { return path; }
}

/** Core lists then lstats entries before session creation too. A vanished
 * atomic-write temporary file is safe to retry; other failures propagate. */
export async function retrySessionDirectory<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !/Failed to list sessions directory.*ENOENT:.*lstat ['"].*\.jsonl\.tmp['"]/.test(error.message)) throw error;
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}

/** Transcripts may retain the caller's original spelling from before canonicalization. */
export async function listWorkspaceSessions(repo: JsonlSessionRepo, cwd: string): Promise<JsonlSessionMetadata[]> {
  const identity = workspaceIdentity(cwd);
  return (await retrySessionDirectory(() => repo.list({}, BACKGROUND_CONTEXT))).filter((item) => workspaceIdentity(item.cwd) === identity);
}
