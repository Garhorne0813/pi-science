import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationNavigationRepository, NavigationError } from "./repository.js";
import { SessionRepository, invalidateSessionFileCache } from "../runtime/node/session-repository.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nav-repo-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, ".pi-science", "sessions"), { recursive: true });
  return cwd;
}

function sessionHeader(id: string, cwd: string) {
  return `${JSON.stringify({ type: "session", id, cwd, timestamp: "2026-07-25T00:00:00.000Z" })}\n`;
}

function messageLine(id: string, role: string, text: string) {
  return `${JSON.stringify({ type: "message", id, timestamp: "2026-07-25T00:00:01.000Z", message: { role, content: [{ type: "text", text }] } })}\n`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function writeSession(cwd: string, sessionId: string, lines: string[]): Promise<void> {
  await writeFile(join(cwd, ".pi-science", "sessions", `${sessionId}.jsonl`), [sessionHeader(sessionId, cwd), ...lines].join(""), "utf8");
  invalidateSessionFileCache(cwd);
}

function makeRepository(cwd: string): ConversationNavigationRepository {
  const sessionRepository = new SessionRepository();
  void cwd;
  return new ConversationNavigationRepository(sessionRepository);
}

describe("ConversationNavigationRepository", () => {
  it("creates a user bookmark with the Node-resolved quote and role", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "first"), messageLine("m2", "assistant", "key result")]);

    const bookmark = await repo.createBookmark(cwd, { session_id: "s1", message_id: "m2", label: "Result" });
    expect(bookmark.role).toBe("assistant");
    expect(bookmark.quote).toBe("key result");
    expect(bookmark.origin).toBe("user");
    expect(bookmark.status).toBe("accepted");
    expect(bookmark.label).toBe("Result");

    const list = await repo.bookmarks(cwd, "s1");
    expect(list.bookmarks).toHaveLength(1);
    expect(list.legacy_skipped).toBe(0);
  });

  it("rejects bookmarks for unknown sessions and dangling message ids", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);

    await expect(repo.createBookmark(cwd, { session_id: "s1", message_id: "missing" })).rejects.toMatchObject({ code: "invalid_anchor" });
    await expect(repo.createBookmark(cwd, { session_id: "ghost", message_id: "m1" })).rejects.toMatchObject({ code: "invalid_anchor" });
  });

  it("never auto-accepts proposals and deduplicates by session+message", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "a"), messageLine("m2", "assistant", "b"), messageLine("m3", "assistant", "c")]);

    const first = await repo.proposeBookmarks(cwd, "s1", ["m2", "m3"]);
    expect(first.bookmarks.map((b) => b.status)).toEqual(["proposed", "proposed"]);
    expect(first.bookmarks.map((b) => b.origin)).toEqual(["agent_proposal", "agent_proposal"]);
    expect(first.skipped).toBe(0);

    const second = await repo.proposeBookmarks(cwd, "s1", ["m2", "ghost"]);
    expect(second.bookmarks).toHaveLength(0);
    expect(second.skipped).toBe(2);
  });

  it("accepts, rejects and deletes bookmarks durably", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);

    const bookmark = await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    const accepted = await repo.updateBookmarkStatus(cwd, bookmark.bookmark_id, "rejected");
    expect(accepted.status).toBe("rejected");
    // A rejected bookmark is still listed but can be deleted.
    await repo.deleteBookmark(cwd, bookmark.bookmark_id);
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(0);
    await expect(repo.deleteBookmark(cwd, bookmark.bookmark_id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("deduplicates manual bookmarks for the same session+message and revives rejected ones", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);

    const first = await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    const second = await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1", label: "retry" });
    expect(second.bookmark_id).toBe(first.bookmark_id);
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(1);

    // A rejected bookmark is revived to accepted instead of stacking a duplicate.
    await repo.updateBookmarkStatus(cwd, first.bookmark_id, "rejected");
    const revived = await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    expect(revived.bookmark_id).toBe(first.bookmark_id);
    expect(revived.status).toBe("accepted");
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(1);
  });

  it("caps bookmarks per session", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", Array.from({ length: 501 }, (_, i) => messageLine(`m${i}`, "user", `text ${i}`)));
    for (let i = 0; i < 500; i += 1) {
      await repo.createBookmark(cwd, { session_id: "s1", message_id: `m${i}` });
    }
    await expect(repo.createBookmark(cwd, { session_id: "s1", message_id: "m500" })).rejects.toMatchObject({ code: "limit" });
  });

  it("fails closed on future schema versions and corrupt state", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    const statePath = join(cwd, ".pi-science", "conversation-navigation.json");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });

    await writeFile(statePath, JSON.stringify({ schema_version: 99, bookmarks: [], read_states: {} }), "utf8");
    await expect(repo.bookmarks(cwd)).rejects.toMatchObject({ code: "unsupported" });

    await writeFile(statePath, "{ not json", "utf8");
    await expect(repo.bookmarks(cwd)).rejects.toMatchObject({ code: "corrupt" });

    // A corrupt file must also refuse writes (no silent reset).
    await expect(repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" })).rejects.toMatchObject({ code: "corrupt" });

    // A malformed tombstone list is corrupt too, not silently reset.
    await writeFile(statePath, JSON.stringify({ schema_version: 1, bookmarks: [], read_states: {}, legacy_deleted_ids: [42] }), "utf8");
    await expect(repo.bookmarks(cwd)).rejects.toMatchObject({ code: "corrupt" });
    await expect(repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("reads v1 state files without the tombstone field and adds it on write", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    const statePath = join(cwd, ".pi-science", "conversation-navigation.json");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    // A state file written before tombstones existed: no legacy_deleted_ids.
    await writeFile(statePath, JSON.stringify({ schema_version: 1, bookmarks: [], read_states: {} }), "utf8");

    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(0);
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    const state = JSON.parse(await readFile(statePath, "utf8")) as { legacy_deleted_ids?: unknown };
    expect(state.legacy_deleted_ids).toEqual([]);
  });

  it("folds legacy bookmarks.jsonl into proposals without rewriting the legacy file", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello"), messageLine("m2", "assistant", "world")]);
    const legacyPath = join(cwd, ".pi-science", "bookmarks.jsonl");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify({ session_id: "s1", created_at: 1, bookmarks: [{ session_id: "s1", message_id: "m2", quote: "world" }] })}\n`, "utf8");
    const legacyBefore = await readFile(legacyPath, "utf8");

    const list = await repo.bookmarks(cwd, "s1");
    expect(list.bookmarks).toHaveLength(1);
    expect(list.bookmarks[0]!.origin).toBe("legacy_auto");
    expect(list.bookmarks[0]!.status).toBe("proposed");
    expect(list.legacy_skipped).toBe(0);

    // A write materializes the legacy entry into the JSON state…
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    const state = JSON.parse(await readFile(join(cwd, ".pi-science", "conversation-navigation.json"), "utf8")) as { bookmarks: Array<{ bookmark_id: string }> };
    expect(state.bookmarks).toHaveLength(2);
    // …but the legacy file is never deleted or rewritten.
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBefore);
  });

  it("skips legacy bookmarks whose message no longer exists and reports the count", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(join(cwd, ".pi-science", "bookmarks.jsonl"), `${JSON.stringify({ session_id: "s1", created_at: 1, bookmarks: [{ session_id: "s1", message_id: "gone", quote: "x" }, { session_id: "s1", message_id: "m1", quote: "hello" }] })}\n`, "utf8");

    const list = await repo.bookmarks(cwd, "s1");
    expect(list.bookmarks).toHaveLength(1);
    expect(list.bookmarks[0]!.message_id).toBe("m1");
    expect(list.legacy_skipped).toBe(1);
  });

  it("imports legacy bookmarks deterministically (no duplicates across reads)", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const legacy = `${JSON.stringify({ session_id: "s1", created_at: 1, bookmarks: [{ session_id: "s1", message_id: "m1", quote: "hello" }] })}\n`;
    await writeFile(join(cwd, ".pi-science", "bookmarks.jsonl"), legacy, "utf8");

    const first = await repo.bookmarks(cwd, "s1");
    const second = await repo.bookmarks(cwd, "s1");
    expect(first.bookmarks).toHaveLength(1);
    expect(second.bookmarks).toHaveLength(1);
    expect(first.bookmarks[0]!.bookmark_id).toBe(second.bookmarks[0]!.bookmark_id);
  });

  it("preserves legacy created_at timestamps and never jitters across reads", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "epoch"), messageLine("m2", "assistant", "iso"), messageLine("m3", "user", "absent")]);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const rows = [
      // Epoch seconds (the legacy writer's `Date.now() / 1000` shape).
      { session_id: "s1", created_at: 1_700_000_000, bookmarks: [{ session_id: "s1", message_id: "m1", quote: "epoch" }] },
      // ISO string.
      { session_id: "s1", created_at: "2025-03-01T08:30:00.000Z", bookmarks: [{ session_id: "s1", message_id: "m2", quote: "iso" }] },
      // Absent created_at → deterministic fallback, identical across reads.
      { session_id: "s1", bookmarks: [{ session_id: "s1", message_id: "m3", quote: "absent" }] },
    ];
    await writeFile(join(cwd, ".pi-science", "bookmarks.jsonl"), rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");

    const first = await repo.bookmarks(cwd, "s1");
    expect(first.bookmarks.find((bookmark) => bookmark.message_id === "m1")!.created_at).toBe("2023-11-14T22:13:20.000Z");
    expect(first.bookmarks.find((bookmark) => bookmark.message_id === "m2")!.created_at).toBe("2025-03-01T08:30:00.000Z");
    const fallbackFirst = first.bookmarks.find((bookmark) => bookmark.message_id === "m3")!.created_at;
    expect(fallbackFirst).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A second read must produce byte-identical timestamps (no jitter).
    const second = await repo.bookmarks(cwd, "s1");
    expect(second.bookmarks.find((bookmark) => bookmark.message_id === "m1")!.created_at).toBe(first.bookmarks.find((bookmark) => bookmark.message_id === "m1")!.created_at);
    expect(second.bookmarks.find((bookmark) => bookmark.message_id === "m2")!.created_at).toBe(first.bookmarks.find((bookmark) => bookmark.message_id === "m2")!.created_at);
    expect(second.bookmarks.find((bookmark) => bookmark.message_id === "m3")!.created_at).toBe(fallbackFirst);
    // The absent-timestamp fallback stays stable after materialization too.
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    const materialized = await repo.bookmarks(cwd, "s1");
    expect(materialized.bookmarks.find((bookmark) => bookmark.message_id === "m3")!.created_at).toBe(fallbackFirst);
  });

  it("tombstones a deleted legacy bookmark so it never resurrects from bookmarks.jsonl", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello"), messageLine("m2", "assistant", "world")]);
    const legacyPath = join(cwd, ".pi-science", "bookmarks.jsonl");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const legacy = `${JSON.stringify({ session_id: "s1", created_at: 1, bookmarks: [{ session_id: "s1", message_id: "m2", quote: "world" }] })}\n`;
    await writeFile(legacyPath, legacy, "utf8");

    // Delete BEFORE any write materialized the legacy row into the JSON state
    // (the pure read path never materializes).
    const before = await repo.bookmarks(cwd, "s1");
    expect(before.bookmarks).toHaveLength(1);
    await repo.deleteBookmark(cwd, before.bookmarks[0]!.bookmark_id);

    // The legacy file is untouched for rollback…
    expect(await readFile(legacyPath, "utf8")).toBe(legacy);
    // …but repeated reads and writes never re-import the deleted row.
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(0);
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(1);
    expect((await repo.bookmarks(cwd, "s1")).bookmarks[0]!.message_id).toBe("m1");

    // The tombstone is durable in the JSON state and skips the legacy row.
    const state = JSON.parse(await readFile(join(cwd, ".pi-science", "conversation-navigation.json"), "utf8")) as { legacy_deleted_ids: string[] };
    expect(state.legacy_deleted_ids).toEqual([before.bookmarks[0]!.bookmark_id]);

    // A fresh repository instance reads the same tombstone (durability across restarts).
    const reopened = makeRepository(cwd);
    expect((await reopened.bookmarks(cwd, "s1")).bookmarks.map((bookmark) => bookmark.message_id)).toEqual(["m1"]);
  });

  it("keeps an accepted legacy bookmark deleted after acceptance (no resurrection)", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    const legacyPath = join(cwd, ".pi-science", "bookmarks.jsonl");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify({ session_id: "s1", created_at: 1, bookmarks: [{ session_id: "s1", message_id: "m1", quote: "hello" }] })}\n`, "utf8");

    const before = await repo.bookmarks(cwd, "s1");
    const legacyId = before.bookmarks[0]!.bookmark_id;
    // Accepting materializes the legacy row into the JSON state (still legacy origin).
    await repo.updateBookmarkStatus(cwd, legacyId, "accepted");
    expect((await repo.bookmarks(cwd, "s1")).bookmarks[0]!.status).toBe("accepted");

    // Deleting after acceptance must also tombstone (the legacy file still has the row).
    await repo.deleteBookmark(cwd, legacyId);
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(0);
    const state = JSON.parse(await readFile(join(cwd, ".pi-science", "conversation-navigation.json"), "utf8")) as { legacy_deleted_ids: string[] };
    expect(state.legacy_deleted_ids).toContain(legacyId);
    // The tombstone survives further writes and repeated reads.
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    expect((await repo.bookmarks(cwd, "s1")).bookmarks.map((bookmark) => bookmark.message_id)).toEqual(["m1"]);
  });

  it("does not tombstone non-legacy bookmarks", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello"), messageLine("m2", "assistant", "world")]);
    const legacyPath = join(cwd, ".pi-science", "bookmarks.jsonl");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify({ session_id: "s1", created_at: 1, bookmarks: [{ session_id: "s1", message_id: "m2", quote: "world" }] })}\n`, "utf8");

    const userBookmark = await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    await repo.deleteBookmark(cwd, userBookmark.bookmark_id);

    // Only the legacy deletion would add a tombstone; a user bookmark delete
    // must not, and the still-present legacy row keeps importing.
    const state = JSON.parse(await readFile(join(cwd, ".pi-science", "conversation-navigation.json"), "utf8")) as { legacy_deleted_ids: string[] };
    expect(state.legacy_deleted_ids).toEqual([]);
    const list = await repo.bookmarks(cwd, "s1");
    expect(list.bookmarks.map((bookmark) => bookmark.message_id)).toEqual(["m2"]);
    expect(list.bookmarks[0]!.origin).toBe("legacy_auto");
  });

  it("tolerates tombstones during session cleanup", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    await writeSession(cwd, "s2", [messageLine("m1", "user", "other")]);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(join(cwd, ".pi-science", "bookmarks.jsonl"), `${JSON.stringify({ session_id: "s1", created_at: 1, bookmarks: [{ session_id: "s1", message_id: "m1", quote: "hello" }] })}\n`, "utf8");

    const before = await repo.bookmarks(cwd, "s1");
    await repo.deleteBookmark(cwd, before.bookmarks[0]!.bookmark_id);
    await repo.cleanupSession(cwd, "s1");

    // Cleanup removed the session's bookmarks/read state and tolerates the
    // stale tombstone; other sessions stay untouched.
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(0);
    expect(await repo.readState(cwd, "s1")).toBeNull();
    const state = JSON.parse(await readFile(join(cwd, ".pi-science", "conversation-navigation.json"), "utf8")) as { legacy_deleted_ids: string[] };
    expect(state.legacy_deleted_ids).toContain(before.bookmarks[0]!.bookmark_id);
    // A later write still succeeds with the tombstone present.
    await repo.createBookmark(cwd, { session_id: "s2", message_id: "m1" });
    expect((await repo.bookmarks(cwd, "s2")).bookmarks).toHaveLength(1);
  });

  it("updates read state without letting anchor moves clear the seen snapshot", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one"), messageLine("m2", "assistant", "two")]);

    const seen = await repo.updateReadState(cwd, "s1", { at_bottom: true, mark_seen: true });
    expect(seen.at_bottom).toBe(true);
    expect(seen.seen_snapshot_version).toContain(":");

    // Scrolling back into history moves the anchor but keeps the seen version.
    const anchored = await repo.updateReadState(cwd, "s1", { anchor_message_id: "m1", at_bottom: false, mark_seen: true });
    expect(anchored.anchor_message_id).toBe("m1");
    expect(anchored.at_bottom).toBe(false);
    expect(anchored.seen_snapshot_version).toBe(seen.seen_snapshot_version);

    // At-bottom without mark_seen keeps the seen version too.
    const bottom = await repo.updateReadState(cwd, "s1", { at_bottom: true });
    expect(bottom.at_bottom).toBe(true);
    expect(bottom.seen_snapshot_version).toBe(seen.seen_snapshot_version);

    // Invalid anchors are rejected; null anchors are allowed.
    await expect(repo.updateReadState(cwd, "s1", { anchor_message_id: "ghost" })).rejects.toMatchObject({ code: "invalid_anchor" });
    const cleared = await repo.updateReadState(cwd, "s1", { anchor_message_id: null });
    expect(cleared.anchor_message_id).toBeNull();
  });

  it("cleans up only the requested session", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one")]);
    await writeSession(cwd, "s2", [messageLine("m1", "user", "two")]);
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    await repo.createBookmark(cwd, { session_id: "s2", message_id: "m1" });
    await repo.updateReadState(cwd, "s1", { at_bottom: true, mark_seen: true });

    await repo.cleanupSession(cwd, "s1");
    expect((await repo.bookmarks(cwd, "s1")).bookmarks).toHaveLength(0);
    expect((await repo.bookmarks(cwd, "s2")).bookmarks).toHaveLength(1);
    expect(await repo.readState(cwd, "s1")).toBeNull();
  });

  it("persists read state across repository instances (durable JSON)", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one")]);
    await repo.updateReadState(cwd, "s1", { anchor_message_id: "m1", at_bottom: false });
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });

    const reopened = makeRepository(cwd);
    const read = await reopened.readState(cwd, "s1");
    expect(read?.anchor_message_id).toBe("m1");
    expect((await reopened.bookmarks(cwd, "s1")).bookmarks).toHaveLength(1);
  });

  it("does not persist absolute paths or transcript copies beyond the quote", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", [messageLine("m1", "user", "x".repeat(1200))]);
    await repo.createBookmark(cwd, { session_id: "s1", message_id: "m1" });
    const text = await readFile(join(cwd, ".pi-science", "conversation-navigation.json"), "utf8");
    expect(text).not.toContain(cwd);
    const state = JSON.parse(text) as { bookmarks: Array<{ quote: string }> };
    expect(state.bookmarks[0]!.quote.length).toBe(500);
  });
});

describe("ConversationNavigationRepository concurrency", () => {
  it("serializes concurrent writers without losing updates", async () => {
    const cwd = await makeWorkspace();
    const repo = makeRepository(cwd);
    await writeSession(cwd, "s1", Array.from({ length: 20 }, (_, i) => messageLine(`m${i}`, "user", `t${i}`)));
    await Promise.all(Array.from({ length: 20 }, (_, i) => repo.createBookmark(cwd, { session_id: "s1", message_id: `m${i}` })));
    const list = await repo.bookmarks(cwd, "s1");
    expect(list.bookmarks).toHaveLength(20);
  });
});
