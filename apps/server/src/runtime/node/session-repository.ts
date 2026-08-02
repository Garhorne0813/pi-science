import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readProject } from "../../project/project-registry.js";

export interface SessionInfoRecord {
  id: string;
  cwd: string;
  project_id: string | null;
  name: null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionMessageRecord {
  id: string;
  role: string;
  content: Array<Record<string, unknown>>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: string | null;
}

interface SessionFile {
  path: string;
  header: Record<string, unknown>;
  modified: Date;
}

interface CachedFile {
  path: string;
  header: Record<string, unknown>;
}

function sessionsRoot(cwd: string): string {
  return join(resolve(cwd), ".pi-science", "sessions");
}

// A candidate is every `.jsonl` file discovered while scanning, whether or not
// its header currently parses as a valid session. Tracking the invalid ones
// (with their mtime/size) lets us re-parse them later WITHOUT waiting for the
// directory mtime to change — which never happens when an existing file is
// overwritten in place (e.g. a partially-written session is completed).
interface CachedCandidate {
  path: string;
  mtimeMs: number;
  size: number;
  header: Record<string, unknown> | null; // null = not (yet) a valid session
}

interface DirCache {
  mtimeMs: number;
  candidates: CachedCandidate[];
}

interface CacheEntry {
  dirs: Record<string, DirCache>;
}

// Per-workspace cache generation. `invalidateSessionFileCache` bumps it so an
// in-flight scan that started before the invalidation cannot publish a stale
// result: the scan checks the generation when it finishes and skips caching.
const cacheGeneration = new Map<string, number>();
// In-flight full scans per workspace, so concurrent `list()` calls reuse a
// single scan (serialisation / promise dedup) instead of racing each other.
const scanInFlight = new Map<string, Promise<CacheEntry | null>>();

const sessionFileCache = new Map<string, CacheEntry>();

async function tryParseHeader(path: string): Promise<Record<string, unknown> | null> {
  try {
    const handle = await open(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
    } finally {
      await handle.close();
    }
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]?.trim();
    if (!firstLine) return null;
    const header = JSON.parse(firstLine) as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string") return null;
    return header;
  } catch {
    // A partially-written or corrupt session is not a valid candidate yet.
    return null;
  }
}

async function scanSessionFiles(root: string): Promise<Record<string, DirCache>> {
  const dirs: Record<string, DirCache> = {};

  async function visit(directory: string): Promise<void> {
    let dirStat;
    try {
      dirStat = await stat(directory);
    } catch {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      dirs[directory] = { mtimeMs: dirStat.mtimeMs, candidates: [] };
      return;
    }
    // Record the directory mtime BEFORE reading its entries. Any change that
    // lands after this stat shifts the mtime away from the captured value,
    // which the next validation detects and forces a re-scan.
    const candidates: CachedCandidate[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let meta;
      try {
        meta = await stat(path);
      } catch {
        continue;
      }
      const header = await tryParseHeader(path);
      candidates.push({ path, mtimeMs: meta.mtimeMs, size: meta.size, header });
    }
    dirs[directory] = { mtimeMs: dirStat.mtimeMs, candidates };
  }

  await visit(root);
  return dirs;
}

function filesFromDirs(dirs: Record<string, DirCache>): CachedFile[] {
  const files: CachedFile[] = [];
  for (const dirCache of Object.values(dirs)) {
    for (const candidate of dirCache.candidates) {
      if (
        candidate.header
        && candidate.header.type === "session"
        && typeof candidate.header.id === "string"
      ) {
        files.push({ path: candidate.path, header: candidate.header });
      }
    }
  }
  return files;
}

// Re-validate a cached entry against the current filesystem. Returns the valid
// session files, or `null` when something changed enough to require a full
// re-scan. Even when the directory mtime is stable, every candidate file is
// re-stated: overwriting an existing file changes its mtime/size but NOT the
// directory mtime, and we must re-parse candidates whose mtime/size changed.
async function revalidateCache(root: string, cached: CacheEntry): Promise<CachedFile[] | null> {
  const dirs: Record<string, DirCache> = {};
  let dirty = false;
  for (const [dir, dirCache] of Object.entries(cached.dirs)) {
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch {
      // A watched directory vanished — structural change, re-scan.
      return null;
    }
    if (dirStat.mtimeMs !== dirCache.mtimeMs) {
      // An entry was added/removed/renamed in this directory. Re-read it.
      return null;
    }
    const candidates: CachedCandidate[] = [];
    for (const candidate of dirCache.candidates) {
      let meta;
      try {
        meta = await stat(candidate.path);
      } catch {
        // The candidate file was removed.
        dirty = true;
        continue;
      }
      if (meta.mtimeMs !== candidate.mtimeMs || meta.size !== candidate.size) {
        const header = await tryParseHeader(candidate.path);
        candidates.push({ path: candidate.path, mtimeMs: meta.mtimeMs, size: meta.size, header });
        dirty = true;
      } else {
        candidates.push(candidate);
      }
    }
    dirs[dir] = { mtimeMs: dirCache.mtimeMs, candidates };
  }
  const entry: CacheEntry = { dirs };
  if (dirty) sessionFileCache.set(root, entry);
  return filesFromDirs(entry.dirs);
}

async function performScan(root: string): Promise<CacheEntry | null> {
  try {
    await stat(root);
  } catch {
    invalidateCache(root);
    return null;
  }
  const generationBefore = cacheGeneration.get(root) ?? 0;
  const dirs = await scanSessionFiles(root);
  const generationAfter = cacheGeneration.get(root) ?? 0;
  if (generationBefore !== generationAfter) {
    // Invalidated while we were scanning; do not publish a stale result.
    return { dirs };
  }
  const entry: CacheEntry = { dirs };
  sessionFileCache.set(root, entry);
  return entry;
}

async function sessionFiles(root: string): Promise<CachedFile[]> {
  try {
    await stat(root);
  } catch {
    invalidateCache(root);
    return [];
  }
  const cached = sessionFileCache.get(root);
  if (cached) {
    const revalidated = await revalidateCache(root, cached);
    if (revalidated !== null) return revalidated;
  }
  const inflight = scanInFlight.get(root);
  if (inflight) return filesFromDirs((await inflight)?.dirs ?? {});

  const scan = performScan(root).finally(() => {
    if (scanInFlight.get(root) === scan) scanInFlight.delete(root);
  });
  scanInFlight.set(root, scan);
  return filesFromDirs((await scan)?.dirs ?? {});
}

function invalidateCache(root: string): void {
  cacheGeneration.set(root, (cacheGeneration.get(root) ?? 0) + 1);
  sessionFileCache.delete(root);
}

/** Invalidate the cached session file list for a workspace.
 *  Call this after creating, deleting, or renaming a session file so the next
 *  read picks up the change without waiting for the directory mtime to change.
 *  Bumps the per-workspace generation and drops any in-flight scan so a scan
 *  that began before this call cannot overwrite the cache with a stale list. */
export function invalidateSessionFileCache(cwd: string): void {
  const root = sessionsRoot(cwd);
  cacheGeneration.set(root, (cacheGeneration.get(root) ?? 0) + 1);
  sessionFileCache.delete(root);
  scanInFlight.delete(root);
}

/** Refresh the cached file entries with fresh stat() calls for correct
 *  `modified` times. Returns results sorted newest-first. */
async function sessionFilesWithMtime(root: string): Promise<SessionFile[]> {
  const cached = await sessionFiles(root);
  const refreshed = await Promise.all(
    cached.map(async (file) => {
      try {
        const metadata = await stat(file.path);
        return { path: file.path, header: file.header, modified: metadata.mtime };
      } catch {
        return null;
      }
    }),
  );
  return refreshed
    .filter((item): item is SessionFile => item !== null)
    .sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

export class SessionRepository {
  async findPath(cwd: string, sessionId: string): Promise<string | null> {
    return (await sessionFiles(sessionsRoot(cwd))).find(({ header }) => header.id === sessionId)?.path ?? null;
  }

  async list(cwd: string): Promise<SessionInfoRecord[]> {
    const [files, project] = await Promise.all([
      sessionFilesWithMtime(sessionsRoot(cwd)),
      readProject(cwd),
    ]);
    return files.map(({ header, modified }) => ({
      id: String(header.id),
      cwd: typeof header.cwd === "string" ? header.cwd : resolve(cwd),
      project_id: project?.id ?? (typeof header.project_id === "string" ? header.project_id : null),
      name: null,
      created_at: typeof header.timestamp === "string" ? header.timestamp : null,
      updated_at: modified.toISOString(),
    }));
  }

  async messages(cwd: string, sessionId: string): Promise<SessionMessageRecord[]> {
    const file = (await sessionFiles(sessionsRoot(cwd))).find(({ header }) => header.id === sessionId);
    if (!file) return [];
    const rows: SessionMessageRecord[] = [];
    try {
      // Stream the JSONL file line-by-line instead of loading it all into
      // memory at once. This keeps the event loop responsive on long
      // conversations and caps peak memory at the readline buffer size rather
      // than the full file.
      const rl = createInterface({
        input: createReadStream(file.path, "utf8"),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
          const message = entry.message as Record<string, unknown>;
          rows.push({
            id: typeof entry.id === "string" ? entry.id : "",
            role: typeof message.role === "string" ? message.role : "",
            content: Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [],
            toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
            toolName: typeof message.toolName === "string" ? message.toolName : undefined,
            isError: typeof message.isError === "boolean" ? message.isError : false,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
          });
        } catch {
          continue;
        }
      }
    } catch {
      return [];
    }
    return rows;
  }
}

export const sessionRepository = new SessionRepository();
