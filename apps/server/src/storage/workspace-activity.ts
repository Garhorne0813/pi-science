import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

// Runtime bookkeeping and dependency/cache trees are not research activity.
// Session activity is read separately, including relocated session storage.
const ignoredDirectories = new Set([".pi-science", ".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"]);
const defaults = { ttlMs: 60_000, maxEntries: 1_000, timeoutMs: 250, maxCached: 256, maxQueued: 32 };
type CacheEntry = { latest: number; refreshedAt: number | null; pending: boolean };
type ScanRequest = { root: string; entry: CacheEntry };

/** Best-effort file activity, refreshed off the HTTP request path. Cold/stale
 * reads immediately return directory mtime plus any previously observed activity.
 * One scanner per server, a bounded queue/LRU cache and streaming directory reads
 * prevent large datasets or concurrent list requests from causing an I/O fan-out. */
export class WorkspaceActivityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly queue: ScanRequest[] = [];
  private readonly limits: typeof defaults;
  private scheduled: NodeJS.Immediate | null = null;
  private running = false;
  private closed = false;

  constructor(private readonly diagnostic: (root: string, error: unknown) => void, limits: Partial<typeof defaults> = {}) {
    this.limits = { ...defaults, ...limits };
  }

  get(root: string, rootModified: number): number {
    if (this.closed) return rootModified;
    let entry = this.entries.get(root);
    if (!entry) {
      if (this.entries.size >= this.limits.maxCached) this.entries.delete(this.entries.keys().next().value!);
      entry = { latest: rootModified, refreshedAt: null, pending: false };
    }
    // Touch LRU order and retain root changes even during a background refresh.
    this.entries.delete(root);
    this.entries.set(root, entry);
    entry.latest = Math.max(entry.latest, rootModified);
    if (!entry.pending && (entry.refreshedAt === null || Date.now() - entry.refreshedAt >= this.limits.ttlMs) && this.queue.length < this.limits.maxQueued) {
      entry.pending = true;
      this.queue.push({ root, entry });
      if (!this.running && !this.scheduled) {
        this.scheduled = setImmediate(() => { this.scheduled = null; void this.refresh(); });
        this.scheduled.unref();
      }
    }
    return entry.latest;
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = null;
    this.queue.length = 0;
    this.entries.clear();
  }

  private async refresh(): Promise<void> {
    this.running = true;
    try {
      while (!this.closed && this.queue.length) {
        const { root, entry } = this.queue.shift()!;
        if (this.entries.get(root) !== entry) continue;
        try { entry.latest = Math.max(entry.latest, await this.scan(root, entry.latest)); }
        catch (error) { this.diagnostic(root, error); } // Keep cached/root mtime on any scan failure.
        finally { entry.refreshedAt = Date.now(); entry.pending = false; }
      }
    } finally { this.running = false; }
  }

  private async scan(root: string, latest: number): Promise<number> {
    const deadline = Date.now() + this.limits.timeoutMs;
    let expired = false;
    const timer = setTimeout(() => { expired = true; }, this.limits.timeoutMs);
    timer.unref();
    let visited = 0;
    const directories = [root];
    // Native filesystem calls cannot be cancelled; on a slow call, retain the
    // single scanner slot and stop issuing further I/O when that call returns.
    const stopped = () => this.closed || expired || Date.now() >= deadline || visited >= this.limits.maxEntries;
    try {
      while (directories.length) {
        if (stopped()) break;
        const directory = directories.pop()!;
        try {
          const handle = await opendir(directory);
          for await (const entry of handle) { // Iterator closes the handle on break/error.
            if (stopped()) break;
            visited++;
            if (entry.isSymbolicLink() || (entry.isDirectory() && ignoredDirectories.has(entry.name))) continue;
            const path = join(directory, entry.name);
            try {
              const info = await lstat(path);
              if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
              latest = Math.max(latest, info.mtimeMs);
              if (info.isDirectory()) directories.push(path);
            } catch (error) {
              if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            }
          }
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      if (!this.closed && stopped()) this.diagnostic(root, new Error("Workspace activity scan reached its entry or time budget; using observed activity"));
      return latest;
    } finally { clearTimeout(timer); }
  }
}
