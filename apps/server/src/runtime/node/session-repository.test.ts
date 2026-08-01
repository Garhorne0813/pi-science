import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invalidateSessionFileCache, SessionRepository } from "./session-repository.js";

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
