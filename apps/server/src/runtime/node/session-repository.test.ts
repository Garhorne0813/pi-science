import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invalidateSessionFileCache, SessionRepository } from "./session-repository.js";
import { ensureProject } from "../../project/project-registry.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-session-repo-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, ".pi-science", "sessions"), { recursive: true });
  return cwd;
}

function sessionHeader(id: string, cwd: string, timestamp = "2026-07-25T00:00:00.000Z") {
  return `${JSON.stringify({ type: "session", id, cwd, timestamp })}\n`;
}

function messageLine(id: string, role: string, text: string, timestamp = "2026-07-25T00:00:01.000Z") {
  return `${JSON.stringify({ type: "message", id, timestamp, message: { role, content: [{ type: "text", text }] } })}\n`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("SessionRepository cache", () => {
  it("associates every listed session with the workspace project id", async () => {
    const cwd = await makeWorkspace();
    const project = await ensureProject(cwd);
    const repo = new SessionRepository();
    await writeFile(join(cwd, ".pi-science", "sessions", "project-session.jsonl"), sessionHeader("project-session", cwd), "utf8");

    await expect(repo.list(cwd)).resolves.toEqual([
      expect.objectContaining({ id: "project-session", project_id: project.id }),
    ]);
  });

  it("returns fresh results after explicit cache invalidation", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    await writeFile(join(cwd, ".pi-science", "sessions", "a.jsonl"), sessionHeader("a", cwd), "utf8");

    const first = await repo.list(cwd);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe("a");

    // Explicitly invalidate the cache, then add a new session.
    invalidateSessionFileCache(cwd);
    await writeFile(join(cwd, ".pi-science", "sessions", "b.jsonl"), sessionHeader("b", cwd), "utf8");

    const second = await repo.list(cwd);
    expect(second.map((s) => s.id)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(second).toHaveLength(2);
  });

  it("refreshes updated_at when a session file is appended to (mtime changes)", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    await writeFile(join(cwd, ".pi-science", "sessions", "x.jsonl"), sessionHeader("x", cwd), "utf8");

    const before = await repo.list(cwd);
    expect(before).toHaveLength(1);

    // Wait a moment so the mtime is measurably different.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Append a message to the existing session file. This updates the file's
    // mtime but does NOT change the directory mtime. The cache should still
    // return the correct (fresh) updated_at because list() re-stats each file.
    await appendFile(join(cwd, ".pi-science", "sessions", "x.jsonl"), messageLine("m1", "user", "new"), "utf8");

    const after = await repo.list(cwd);
    expect(after).toHaveLength(1);
    // The updated_at must be newer than the original listing.
    expect(after[0]!.updated_at).not.toBe(before[0]!.updated_at);
  });

  it("invalidates cache when a file is added (directory mtime changes)", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    await writeFile(join(cwd, ".pi-science", "sessions", "first.jsonl"), sessionHeader("first", cwd), "utf8");

    const before = await repo.list(cwd);
    expect(before).toHaveLength(1);

    // Adding a new file changes the directory mtime, which invalidates the cache.
    // Wait past the filesystem's mtime resolution so the directory mtime advances.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(join(cwd, ".pi-science", "sessions", "second.jsonl"), sessionHeader("second", cwd), "utf8");

    const after = await repo.list(cwd);
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.id)).toEqual(expect.arrayContaining(["first", "second"]));
  });

  it("detects a new session added inside a nested subdirectory", async () => {
    const cwd = await makeWorkspace();
    // Pre-create the nested subdirectory so the root 'sessions' mtime is stable
    // after this point. Only the *subdirectory's* mtime changes when we add a
    // file there, which the cache must also watch (it must not only watch the
    // top-level directory).
    await mkdir(join(cwd, ".pi-science", "sessions", "encoded"), { recursive: true });

    const repo = new SessionRepository();
    await writeFile(join(cwd, ".pi-science", "sessions", "top.jsonl"), sessionHeader("top", cwd), "utf8");
    const first = await repo.list(cwd);
    expect(first.map((s) => s.id)).toEqual(["top"]);

    // Add a brand-new session deep in the nested subdirectory. This updates the
    // subdirectory mtime but NOT the top-level 'sessions' directory mtime.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(
      join(cwd, ".pi-science", "sessions", "encoded", "nested.jsonl"),
      sessionHeader("nested", cwd),
      "utf8",
    );

    const second = await repo.list(cwd);
    expect(second.map((s) => s.id)).toEqual(expect.arrayContaining(["top", "nested"]));
    expect(second).toHaveLength(2);
  });

  it("hides pi-subagents child sessions while keeping user forks visible", async () => {
    const cwd = await makeWorkspace();
    const sessions = join(cwd, ".pi-science", "sessions");
    const repo = new SessionRepository();
    await writeFile(join(sessions, "parent.jsonl"), sessionHeader("parent", cwd), "utf8");

    // A forked user session remains a top-level conversation even when Pi
    // records its parent session in the header.
    await writeFile(
      join(sessions, "user-fork.jsonl"),
      `${JSON.stringify({ type: "session", id: "user-fork", cwd, timestamp: "2026-07-25T00:01:00.000Z", parentSession: join(sessions, "parent.jsonl") })}\n${JSON.stringify({ type: "session_info", id: "info", name: "My fork" })}\n`,
      "utf8",
    );

    // pi-subagents creates both a fork-context session and nested run
    // transcripts. Neither should appear in the user-facing list. The
    // fork-context check must remain correct even if nested run artifacts are
    // cleaned up before this repository is read.
    await writeFile(
      join(sessions, "subagent-fork.jsonl"),
      `${JSON.stringify({ type: "session", id: "subagent-fork", cwd, timestamp: "2026-07-25T00:02:00.000Z", parentSession: join(sessions, "parent.jsonl") })}\n`,
      "utf8",
    );
    await mkdir(join(sessions, "parent", "run-abc", "run-0"), { recursive: true });
    await writeFile(
      join(sessions, "parent", "run-abc", "run-0", "session.jsonl"),
      sessionHeader("subagent-nested", cwd),
      "utf8",
    );

    await rm(join(sessions, "parent"), { recursive: true });

    await expect(repo.list(cwd)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "user-fork" }),
      expect.objectContaining({ id: "parent" }),
    ]));
    await expect(repo.list(cwd)).resolves.toHaveLength(2);
  });

  it("re-discovers a session file that was completed in place after being corrupt", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();

    // A partially-written / corrupt session file: the first line is not a
    // valid session header, so it must be ignored (but still tracked) rather
    // than permanently dropped.
    await writeFile(
      join(cwd, ".pi-science", "sessions", "s.jsonl"),
      `${JSON.stringify({ type: "not-a-session", note: "partial" })}\n`,
      "utf8",
    );
    const first = await repo.list(cwd);
    expect(first.map((s) => s.id)).toEqual([]);

    // Wait past the filesystem's mtime resolution so the in-place overwrite is
    // observable, then complete the file with a valid session header.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(
      join(cwd, ".pi-science", "sessions", "s.jsonl"),
      sessionHeader("s", cwd),
      "utf8",
    );

    const second = await repo.list(cwd);
    expect(second.map((s) => s.id)).toEqual(["s"]);
  });

  it("re-scans after explicit invalidation even if the directory mtime is unchanged", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    await writeFile(join(cwd, ".pi-science", "sessions", "a.jsonl"), sessionHeader("a", cwd), "utf8");

    const first = await repo.list(cwd);
    expect(first.map((s) => s.id)).toEqual(["a"]);

    // Invalidate, then add a new session. We deliberately do NOT wait for the
    // filesystem mtime to advance: the generation bump from invalidation must
    // force a re-scan on its own, so the new session is still discovered even
    // when an in-flight scan from before the invalidation would otherwise have
    // re-published a stale index.
    invalidateSessionFileCache(cwd);
    await writeFile(join(cwd, ".pi-science", "sessions", "b.jsonl"), sessionHeader("b", cwd), "utf8");

    const second = await repo.list(cwd);
    expect(second.map((s) => s.id)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(second).toHaveLength(2);
  });
});

describe("SessionRepository messages streaming", () => {
  it("returns newest history pages with an opaque cursor", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    const lines = [
      sessionHeader("paged", cwd),
      messageLine("m1", "user", "one"),
      messageLine("m2", "assistant", "two"),
      messageLine("m3", "user", "three"),
      messageLine("m4", "assistant", "four"),
    ];
    await writeFile(join(cwd, ".pi-science", "sessions", "paged.jsonl"), lines.join(""), "utf8");

    const latest = await repo.messagesPage(cwd, "paged", { limit: 2 });
    expect(latest.messages.map((message) => message.id)).toEqual(["m3", "m4"]);
    expect(latest.has_more).toBe(true);
    expect(latest.next_cursor).toEqual(expect.any(String));
    expect(latest.snapshot_version).toContain(":");

    const older = await repo.messagesPage(cwd, "paged", { limit: 2, before: latest.next_cursor! });
    expect(older.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(older.has_more).toBe(false);
    expect(older.next_cursor).toBeNull();
  });

  it("indexes every user message and returns a cursor that includes the target", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    const lines = [
      sessionHeader("indexed", cwd),
      messageLine("m1", "user", "one"),
      messageLine("m2", "assistant", "two"),
      messageLine("m3", "user", "three"),
      messageLine("m4", "assistant", "four"),
    ];
    await writeFile(join(cwd, ".pi-science", "sessions", "indexed.jsonl"), lines.join(""), "utf8");

    const index = await repo.userMessageIndex(cwd, "indexed");
    expect(index.messages.map((message) => message.id)).toEqual(["m1", "m3"]);
    expect(index.messages.map((message) => message.text)).toEqual(["one", "three"]);

    const target = index.messages[1]!;
    const page = await repo.messagesPage(cwd, "indexed", { before: target.before, limit: 2 });
    expect(page.messages.map((message) => message.id)).toEqual(["m2", "m3"]);
  });

  it("rejects malformed history cursors and oversized pages", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    await writeFile(join(cwd, ".pi-science", "sessions", "limits.jsonl"), sessionHeader("limits", cwd), "utf8");

    await expect(repo.messagesPage(cwd, "limits", { limit: 101 })).rejects.toThrow("history limit");
    await expect(repo.messagesPage(cwd, "limits", { before: "not-a-cursor" })).rejects.toThrow("invalid history cursor");
  });

  it("reads messages from a multi-line JSONL file", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    const lines = [
      sessionHeader("msg-session", cwd),
      messageLine("m1", "user", "hello"),
      messageLine("m2", "assistant", "hi there"),
      messageLine("m3", "user", "bye"),
    ];
    await writeFile(join(cwd, ".pi-science", "sessions", "msg.jsonl"), lines.join(""), "utf8");

    const messages = await repo.messages(cwd, "msg-session");
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content[0]?.text).toBe("hello");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[2]!.role).toBe("user");
  });

  it("skips non-message lines and corrupt JSON without erroring", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    const lines = [
      sessionHeader("corrupt", cwd),
      messageLine("good", "user", "valid"),
      "not valid json\n",
      messageLine("also-good", "assistant", "still valid"),
    ];
    await writeFile(join(cwd, ".pi-science", "sessions", "corrupt.jsonl"), lines.join(""), "utf8");

    const messages = await repo.messages(cwd, "corrupt");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content[0]?.text).toBe("valid");
    expect(messages[1]!.content[0]?.text).toBe("still valid");
  });

  it("returns an empty array for a non-existent session", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    const messages = await repo.messages(cwd, "does-not-exist");
    expect(messages).toEqual([]);
  });

  it("streams large JSONL files line-by-line instead of loading the whole file into memory first", async () => {
    const cwd = await makeWorkspace();
    const repo = new SessionRepository();
    const parts: string[] = [sessionHeader("large", cwd)];
    // Write 5000 message lines (~500 KB).
    for (let i = 0; i < 5000; i++) {
      parts.push(messageLine(`msg-${i}`, "user", `message number ${i}`));
    }
    await writeFile(join(cwd, ".pi-science", "sessions", "large.jsonl"), parts.join(""), "utf8");

    const messages = await repo.messages(cwd, "large");
    expect(messages).toHaveLength(5000);
    expect(messages[4999]!.content[0]?.text).toBe("message number 4999");
  });
});
