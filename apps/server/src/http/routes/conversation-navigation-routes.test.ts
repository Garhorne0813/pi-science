import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app/app.js";
import type { ServerConfig } from "../../config/config.js";
import { invalidateSessionFileCache } from "../../runtime/node/session-repository.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  delete process.env.PI_SCIENCE_HOME;
  delete process.env.PI_SCIENCE_WORKSPACES;
});

function config(): ServerConfig {
  return { host: "127.0.0.1", port: 0, pythonOrigin: "http://127.0.0.1:1", corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100, nodeSessions: true, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
}

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `pi-science-nav-routes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(path);
  await mkdir(join(path, ".pi-science", "sessions"), { recursive: true });
  return path;
}

function sessionHeader(id: string, cwd: string) {
  return `${JSON.stringify({ type: "session", id, cwd, timestamp: "2026-07-25T00:00:00.000Z" })}\n`;
}

function messageLine(id: string, role: string, text: string) {
  return `${JSON.stringify({ type: "message", id, timestamp: "2026-07-25T00:00:01.000Z", message: { role, content: [{ type: "text", text }] } })}\n`;
}

async function writeSession(cwd: string, sessionId: string, lines: string[]): Promise<void> {
  await writeFile(join(cwd, ".pi-science", "sessions", `${sessionId}.jsonl`), [sessionHeader(sessionId, cwd), ...lines].join(""), "utf8");
  invalidateSessionFileCache(cwd);
}

describe("conversation navigation routes", () => {
  it("rejects an invalid workspace", async () => {
    const app = buildApp(config());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/bookmarks?cwd=${encodeURIComponent(join(tmpdir(), "missing-workspace"))}` });
    expect(response.statusCode).toBe(403);
  });

  it("creates, lists, updates and deletes bookmarks", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "question"), messageLine("m2", "assistant", "verified result")]);
    const app = buildApp(config());
    apps.push(app);

    const created = await app.inject({ method: "POST", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=s1`, payload: { message_id: "m2", label: "Key" } });
    expect(created.statusCode).toBe(200);
    const bookmark = created.json().bookmark as { bookmark_id: string; role: string; quote: string; status: string };
    expect(bookmark.role).toBe("assistant");
    expect(bookmark.quote).toBe("verified result");
    expect(bookmark.status).toBe("accepted");

    const listed = await app.inject({ method: "GET", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    expect(listed.json().bookmarks).toHaveLength(1);

    const updated = await app.inject({ method: "PATCH", url: `/api/bookmarks/${bookmark.bookmark_id}?cwd=${encodeURIComponent(cwd)}`, payload: { status: "rejected" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().bookmark.status).toBe("rejected");

    const deleted = await app.inject({ method: "DELETE", url: `/api/bookmarks/${bookmark.bookmark_id}?cwd=${encodeURIComponent(cwd)}` });
    expect(deleted.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}` })).json().bookmarks).toHaveLength(0);
  });

  it("rejects cross-session and dangling message anchors", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    const app = buildApp(config());
    apps.push(app);

    // Message belongs to a different session than the one in the query.
    const crossSession = await app.inject({ method: "POST", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=s1`, payload: { message_id: "m1" } });
    expect(crossSession.statusCode).toBe(200);

    // A message that does not exist at all.
    const dangling = await app.inject({ method: "POST", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=ghost`, payload: { message_id: "m1" } });
    expect(dangling.statusCode).toBe(404);

    const invalid = await app.inject({ method: "PUT", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { anchor_message_id: "not-in-s1" } });
    expect(invalid.statusCode).toBe(422);
  });

  it("rejects labels longer than the contract limit instead of truncating", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    const app = buildApp(config());
    apps.push(app);

    const accepted = await app.inject({ method: "POST", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=s1`, payload: { message_id: "m1", label: "x".repeat(160) } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().bookmark.label).toBe("x".repeat(160));

    const rejected = await app.inject({ method: "POST", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=s1`, payload: { message_id: "m1", label: "x".repeat(161) } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "invalid bookmark request" });
  });

  it("fails closed with a consistent {error} shape when navigation state is corrupt", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "hello")]);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(join(cwd, ".pi-science", "conversation-navigation.json"), "{ not json", "utf8");
    const app = buildApp(config());
    apps.push(app);

    const bookmarks = await app.inject({ method: "GET", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}` });
    expect(bookmarks.statusCode).toBe(500);
    expect(bookmarks.json()).toMatchObject({ error: expect.any(String) });

    const readState = await app.inject({ method: "GET", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}` });
    expect(readState.statusCode).toBe(500);
    expect(readState.json()).toMatchObject({ error: expect.any(String) });

    const attention = await app.inject({ method: "GET", url: `/api/attention?cwd=${encodeURIComponent(cwd)}` });
    expect(attention.statusCode).toBe(500);
    expect(attention.json()).toMatchObject({ error: expect.any(String) });
  });

  it("legacy query-only POST produces proposals, never accepted bookmarks", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "plain"), messageLine("m2", "assistant", "final result verified")]);
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { bookmarks: Array<{ status: string; origin: string }>; skipped: number };
    expect(body.bookmarks).toHaveLength(1);
    expect(body.bookmarks[0]!.status).toBe("proposed");
    expect(body.bookmarks[0]!.origin).toBe("agent_proposal");

    // A second call deduplicates (skipped) instead of stacking duplicates.
    const second = await app.inject({ method: "POST", url: `/api/bookmarks/propose?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    expect(second.json().bookmarks).toHaveLength(0);
    expect(second.json().skipped).toBe(1);
  });

  it("proposes CJK candidates via substring matching (ASCII word boundaries never fire between CJK chars)", async () => {
    const cwd = await workspace();
    // The keywords sit between other CJK characters, so a `\b`-wrapped regex
    // could never match them; substring matching must find them.
    await writeSession(cwd, "s1", [
      messageLine("m1", "user", "问题说明"),
      messageLine("m2", "assistant", "我们得出结论：方案可行"),
      messageLine("m3", "assistant", "最终结果如下"),
      messageLine("m4", "assistant", "补充说明"),
    ]);
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/bookmarks/propose?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { bookmarks: Array<{ message_id: string }>; skipped: number };
    // Deterministic: the last two matching messages win, in document order.
    expect(body.bookmarks.map((bookmark) => bookmark.message_id)).toEqual(["m2", "m3"]);
    expect(body.skipped).toBe(0);
  });

  it("keeps the English heuristic bounded to whole words", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [
      messageLine("m1", "assistant", "nothing resulted from this"),
      messageLine("m2", "assistant", "The final conclusion stands"),
      messageLine("m3", "assistant", "data saved twice"),
    ]);
    const app = buildApp(config());
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/bookmarks/propose?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    const body = response.json() as { bookmarks: Array<{ message_id: string }> };
    // "resulted" must NOT match `\bresult\b`; "conclusion" and "saved" do.
    expect(body.bookmarks.map((bookmark) => bookmark.message_id)).toEqual(["m2", "m3"]);
  });

  it("dismissing a proposal via DELETE durably suppresses re-proposal", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "assistant", "final result verified")]);
    const app = buildApp(config());
    apps.push(app);

    const first = await app.inject({ method: "POST", url: `/api/bookmarks/propose?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    const proposed = first.json().bookmarks[0] as { bookmark_id: string; status: string };
    expect(proposed.status).toBe("proposed");

    const deleted = await app.inject({ method: "DELETE", url: `/api/bookmarks/${proposed.bookmark_id}?cwd=${encodeURIComponent(cwd)}` });
    expect(deleted.statusCode).toBe(200);

    // The record is retained as rejected (not physically removed), so a later
    // heuristic run cannot immediately re-suggest the same message.
    const second = await app.inject({ method: "POST", url: `/api/bookmarks/propose?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    expect(second.json().bookmarks).toHaveLength(0);
    expect(second.json().skipped).toBe(1);

    const listed = await app.inject({ method: "GET", url: `/api/bookmarks?cwd=${encodeURIComponent(cwd)}&session_id=s1` });
    const record = listed.json().bookmarks[0] as { bookmark_id: string; status: string };
    expect(record.bookmark_id).toBe(proposed.bookmark_id);
    expect(record.status).toBe("rejected");
  });

  it("serves read state with a dynamic locator and marks the seen snapshot server-side", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one"), messageLine("m2", "assistant", "two")]);
    const app = buildApp(config());
    apps.push(app);

    const empty = await app.inject({ method: "GET", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ anchor_available: false, at_bottom: false, anchor_message_id: null });

    const anchored = await app.inject({ method: "PUT", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { anchor_message_id: "m1", at_bottom: false } });
    expect(anchored.statusCode).toBe(200);
    expect(anchored.json()).toMatchObject({ anchor_available: true, at_bottom: false });
    expect(anchored.json().before).toEqual(expect.any(String));

    const seen = await app.inject({ method: "PUT", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { at_bottom: true, mark_seen: true } });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ at_bottom: true });
    expect(seen.json().seen_snapshot_version).toContain(":");

    const afterSeen = await app.inject({ method: "GET", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}` });
    expect(afterSeen.json().anchor_available).toBe(true);
  });

  it("keeps anchor moves from clearing the seen snapshot", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one"), messageLine("m2", "assistant", "two")]);
    const app = buildApp(config());
    apps.push(app);
    await app.inject({ method: "PUT", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { at_bottom: true, mark_seen: true } });
    const anchored = await app.inject({ method: "PUT", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { anchor_message_id: "m1", at_bottom: false, mark_seen: true } });
    const seen = await app.inject({ method: "GET", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}` });
    expect(seen.json().seen_snapshot_version).toContain(":");
    // m2 is still the latest visible message and the snapshot is unchanged, so
    // the anchor move must not have cleared the seen version.
    expect(anchored.json().seen_snapshot_version).toBe(seen.json().seen_snapshot_version);
  });

  it("does not mark legacy sessions without read state as unread", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one"), messageLine("m2", "assistant", "two")]);
    const app = buildApp(config());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/attention?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([{ session_id: "s1", status: "idle", updated_at: expect.any(String) }]);
    expect(response.json().counts).toEqual({ needs_you: 0, running: 0, unread: 0, plan_ready: 0 });
  });

  it("marks a read session as unread when a new snapshot arrives", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one"), messageLine("m2", "assistant", "two")]);
    const app = buildApp(config());
    apps.push(app);
    await app.inject({ method: "PUT", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { at_bottom: true, mark_seen: true } });
    // Simulate a new assistant turn landing after the user read to bottom.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(cwd, ".pi-science", "sessions", "s1.jsonl"), messageLine("m3", "assistant", "new result"), "utf8");
    invalidateSessionFileCache(cwd);

    const response = await app.inject({ method: "GET", url: `/api/attention?cwd=${encodeURIComponent(cwd)}` });
    expect(response.json().items[0]).toMatchObject({ session_id: "s1", status: "unread" });
    expect(response.json().counts).toMatchObject({ unread: 1 });
  });

  it("does not mark unread when only a user message was appended", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one"), messageLine("m2", "assistant", "two")]);
    const app = buildApp(config());
    apps.push(app);
    await app.inject({ method: "PUT", url: `/api/sessions/s1/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { at_bottom: true, mark_seen: true } });
    // A new user message changes the snapshot but the latest visible message
    // is no longer an assistant reply — coarse snapshot semantics must not
    // flag the session as unread for that.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(cwd, ".pi-science", "sessions", "s1.jsonl"), messageLine("m3", "user", "follow-up"), "utf8");
    invalidateSessionFileCache(cwd);

    const response = await app.inject({ method: "GET", url: `/api/attention?cwd=${encodeURIComponent(cwd)}` });
    expect(response.json().items[0]).toMatchObject({ session_id: "s1", status: "idle" });
    expect(response.json().counts).toMatchObject({ unread: 0 });
  });

  it("applies needs_you > running > unread priority and honors limit", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "one")]);
    await writeSession(cwd, "s2", [messageLine("m1", "user", "one")]);
    await writeSession(cwd, "s3", [messageLine("m1", "user", "one")]);
    const app = buildApp(config());
    apps.push(app);
    // s3 has a read state + new snapshot → unread.
    await app.inject({ method: "PUT", url: `/api/sessions/s3/read-state?cwd=${encodeURIComponent(cwd)}`, payload: { at_bottom: true, mark_seen: true } });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(cwd, ".pi-science", "sessions", "s3.jsonl"), messageLine("m2", "assistant", "new"), "utf8");
    invalidateSessionFileCache(cwd);

    const limited = await app.inject({ method: "GET", url: `/api/attention?cwd=${encodeURIComponent(cwd)}&limit=1` });
    expect(limited.json().items).toHaveLength(1);
    expect(limited.json().items[0]!.status).toBe("unread");
    expect(limited.json().truncated).toBe(true);

    const full = await app.inject({ method: "GET", url: `/api/attention?cwd=${encodeURIComponent(cwd)}` });
    const statuses = full.json().items.map((item: { status: string }) => item.status);
    expect(statuses).toEqual(["unread", "idle", "idle"]);
  });

  it("marks the message index roles=all while keeping the default user-only", async () => {
    const cwd = await workspace();
    await writeSession(cwd, "s1", [messageLine("m1", "user", "q"), messageLine("m2", "assistant", "a"), messageLine("m3", "toolResult", "ignored")]);
    const app = buildApp(config());
    apps.push(app);

    const userOnly = await app.inject({ method: "GET", url: `/api/sessions/s1/messages/index?cwd=${encodeURIComponent(cwd)}` });
    expect(userOnly.json().messages.map((message: { id: string }) => message.id)).toEqual(["m1"]);

    const all = await app.inject({ method: "GET", url: `/api/sessions/s1/messages/index?cwd=${encodeURIComponent(cwd)}&roles=all` });
    expect(all.json().messages.map((message: { id: string; role: string }) => [message.id, message.role])).toEqual([["m1", "user"], ["m2", "assistant"]]);

    const badRoles = await app.inject({ method: "GET", url: `/api/sessions/s1/messages/index?cwd=${encodeURIComponent(cwd)}&roles=bogus` });
    expect(badRoles.statusCode).toBe(400);
  });
});
