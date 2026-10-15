import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type JsonlSessionRepo, type JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";

/** Use the filesystem's spelling, including Windows casing and directory aliases. */
export function workspaceIdentity(cwd: string): string {
  const path = resolve(cwd);
  try { return realpathSync.native(path); }
  catch { return path; }
}

/** Transcripts may retain the caller's original spelling from before canonicalization. */
export async function listWorkspaceSessions(repo: JsonlSessionRepo, cwd: string): Promise<JsonlSessionMetadata[]> {
  const identity = workspaceIdentity(cwd);
  for (let attempt = 0; ; attempt++) {
    try { return (await repo.list({}, BACKGROUND_CONTEXT)).filter((item) => workspaceIdentity(item.cwd) === identity); }
    catch (error) {
      // Core lists then lstats entries, including atomic-write temporary files.
      // Parallel child creation can rename one between those operations.
      if (attempt >= 3 || !(error instanceof Error) || !/ENOENT:.*lstat ['"].*\.jsonl\.tmp['"]/.test(error.message)) throw error;
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}
