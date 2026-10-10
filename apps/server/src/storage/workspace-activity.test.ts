import type { Dir, Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceActivityCache } from "./workspace-activity.js";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), opendir: vi.fn() }));
const caches: WorkspaceActivityCache[] = [];
const closed = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function directory(names = ["notes.md"], isDirectory = false): Dir {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (const name of names) yield { name, isDirectory: () => isDirectory, isSymbolicLink: () => false };
      } finally { closed(); }
    },
  } as unknown as Dir;
}
function info(modified = 2_000): Stats {
  return { mtimeMs: modified, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as Stats;
}
function cache(limits: ConstructorParameters<typeof WorkspaceActivityCache>[1] = {}) {
  const diagnostic = vi.fn();
  const value = new WorkspaceActivityCache(diagnostic, limits);
  caches.push(value);
  return { value, diagnostic };
}

beforeEach(() => {
  vi.mocked(opendir).mockImplementation(async () => directory());
  vi.mocked(lstat).mockResolvedValue(info());
});
afterEach(() => { caches.splice(0).forEach(value => value.close()); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("bounded background workspace activity", () => {
  it("returns immediately, deduplicates refreshes and serializes workspaces while I/O is blocked", async () => {
    const pending = deferred<Dir>();
    vi.mocked(opendir).mockReturnValueOnce(pending.promise);
    const { value } = cache();
    expect(value.get("/a", 1_000)).toBe(1_000);
    expect(opendir).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(opendir).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i++) expect(value.get("/a", 1_000)).toBe(1_000);
    expect(value.get("/b", 1_000)).toBe(1_000);
    expect(opendir).toHaveBeenCalledTimes(1);
    pending.resolve(directory());
    await vi.waitFor(() => expect(value.get("/b", 1_000)).toBe(2_000));
    expect(value.get("/a", 1_000)).toBe(2_000);
    expect(opendir).toHaveBeenCalledTimes(2);
  });

  it("uses cached activity until TTL expires, then refreshes without delaying the read", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { value } = cache({ ttlMs: 100 });
    value.get("/a", 1_000);
    await vi.waitFor(() => expect(value.get("/a", 1_000)).toBe(2_000));
    expect(opendir).toHaveBeenCalledTimes(1);
    now += 101;
    vi.mocked(lstat).mockResolvedValue(info(3_000));
    expect(value.get("/a", 1_000)).toBe(2_000);
    await vi.waitFor(() => expect(value.get("/a", 1_000)).toBe(3_000));
    expect(opendir).toHaveBeenCalledTimes(2);
  });

  it("streams a large directory only up to the entry budget and closes its handle", async () => {
    vi.mocked(opendir).mockImplementation(async () => directory(Array.from({ length: 100 }, (_, i) => `${i}.csv`)));
    const { value, diagnostic } = cache({ maxEntries: 3 });
    value.get("/dataset", 1_000);
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledTimes(1));
    expect(lstat).toHaveBeenCalledTimes(3);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(value.get("/dataset", 1_000)).toBe(2_000);
  });

  it("stops further I/O after the deadline without freeing a still-blocked scanner slot", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const pending = deferred<Stats>();
    vi.mocked(opendir).mockImplementation(async () => directory(["first.csv", "second.csv"]));
    vi.mocked(lstat).mockReturnValueOnce(pending.promise);
    const { value, diagnostic } = cache({ timeoutMs: 10 });
    value.get("/slow", 1_000);
    await vi.waitFor(() => expect(lstat).toHaveBeenCalledTimes(1));
    now += 11; // Expire the scan while its native filesystem call is still pending.
    expect(value.get("/other", 1_000)).toBe(1_000);
    expect(opendir).toHaveBeenCalledTimes(1);
    pending.resolve(info());
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith("/slow", expect.any(Error)));
    expect(lstat).not.toHaveBeenCalledWith("/slow/second.csv");
    expect(closed).toHaveBeenCalled();
  });

  it.each(["opendir", "lstat"] as const)("logs %s I/O failure, backs off and still scans other workspaces", async (operation) => {
    const error = Object.assign(new Error("Disk unavailable"), { code: "EIO" });
    vi.mocked(operation === "opendir" ? opendir : lstat).mockRejectedValueOnce(error);
    const { value, diagnostic } = cache();
    expect(value.get("/broken", 1_000)).toBe(1_000);
    value.get("/healthy", 1_000);
    await vi.waitFor(() => expect(value.get("/healthy", 1_000)).toBe(2_000));
    expect(diagnostic).toHaveBeenCalledWith("/broken", error);
    expect(value.get("/broken", 1_000)).toBe(1_000);
    expect(opendir).toHaveBeenCalledTimes(2);
  });

  it("preserves previously observed activity when a later refresh fails", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { value, diagnostic } = cache({ ttlMs: 100 });
    value.get("/a", 1_000);
    await vi.waitFor(() => expect(value.get("/a", 1_000)).toBe(2_000));
    now += 101;
    vi.mocked(opendir).mockRejectedValueOnce(new Error("EIO"));
    expect(value.get("/a", 1_000)).toBe(2_000);
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledTimes(1));
    expect(value.get("/a", 1_000)).toBe(2_000);
  });

  it("bounds queued work and retries skipped work on a later read", async () => {
    const { value } = cache({ maxQueued: 2 });
    value.get("/a", 1_000);
    value.get("/b", 1_000);
    value.get("/c", 1_000);
    await vi.waitFor(() => expect(value.get("/b", 1_000)).toBe(2_000));
    expect(opendir).toHaveBeenCalledTimes(2);
    expect(value.get("/c", 1_000)).toBe(1_000);
    await vi.waitFor(() => expect(value.get("/c", 1_000)).toBe(2_000));
  });

  it("evicts old cached workspaces and cancels queued work on shutdown", async () => {
    const { value } = cache({ maxCached: 1 });
    value.get("/a", 1_000);
    await vi.waitFor(() => expect(value.get("/a", 1_000)).toBe(2_000));
    value.get("/b", 1_000);
    expect(value.get("/a", 1_000)).toBe(1_000);
    value.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(opendir).toHaveBeenCalledTimes(1);
    expect(value.get("/a", 1_000)).toBe(1_000);
  });
});
