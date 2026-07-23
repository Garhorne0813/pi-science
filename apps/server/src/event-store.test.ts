import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableEventStore, parseSseBlock, type SseEventRecord } from "./event-store.js";
import { configRoot } from "./persistence.js";

const cleanup: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

beforeEach(async () => {
  const home = join(tmpdir(), `pi-science-event-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(home);
  await mkdir(home, { recursive: true });
  process.env.PI_SCIENCE_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-event-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science", "events"), { recursive: true });
  return cwd;
}

function record(id: string, createdAt: string, text: string): SseEventRecord {
  return { event: "text.updated", id, data: JSON.stringify({ text }), created_at: createdAt };
}

function paths(cwd: string, sessionId: string): { primary: string; fallback: string } {
  const safeId = createHash("sha256").update(sessionId).digest("hex");
  const workspaceKey = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24);
  return {
    primary: join(resolve(cwd), ".pi-science", "events", `${safeId}.jsonl`),
    fallback: join(configRoot(), "events", workspaceKey, `${safeId}.jsonl`),
  };
}

describe("durable conversation event replay", () => {
  it("parses CRLF framed SSE without retaining carriage returns", () => {
    expect(parseSseBlock("id: epoch:1\r\nevent: text.updated\r\ndata: first\r\ndata: second\r\n")).toMatchObject({
      id: "epoch:1",
      event: "text.updated",
      data: "first\nsecond",
    });
  });

  it("uses epoch-qualified cursors when sequence numbers restart", async () => {
    const cwd = await workspace();
    const store = new DurableEventStore();
    const sessionId = "session-epoch";
    await store.append(cwd, sessionId, record("epoch-a:1", "2026-07-23T00:00:00.000Z", "old"));
    await store.append(cwd, sessionId, record("epoch-b:1", "2026-07-23T00:00:01.000Z", "new"));
    await store.append(cwd, sessionId, record("epoch-b:2", "2026-07-23T00:00:02.000Z", "newer"));

    const replay = await store.readAfter(cwd, sessionId, "epoch-a:1");
    expect(replay.map((item) => item.id)).toEqual(["epoch-b:1", "epoch-b:2"]);
    expect(replay.map((item) => JSON.parse(item.data).text)).toEqual(["new", "newer"]);
  });

  it("merges primary and fallback logs in order and deduplicates identical event IDs", async () => {
    const cwd = await workspace();
    const store = new DurableEventStore();
    const sessionId = "session-split";
    const target = paths(cwd, sessionId);
    await mkdir(join(configRoot(), "events", createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24)), { recursive: true });

    const duplicate = record("epoch-x:2", "2026-07-23T00:00:02.000Z", "duplicate");
    await writeFile(target.primary, [
      JSON.stringify(record("epoch-x:1", "2026-07-23T00:00:01.000Z", "primary")),
      JSON.stringify(duplicate),
    ].join("\n") + "\n", "utf8");
    await writeFile(target.fallback, [
      JSON.stringify(duplicate),
      JSON.stringify(record("epoch-x:3", "2026-07-23T00:00:03.000Z", "fallback")),
    ].join("\n") + "\n", "utf8");

    const replay = await store.readAfter(cwd, sessionId);
    expect(replay.map((item) => item.id)).toEqual(["epoch-x:1", "epoch-x:2", "epoch-x:3"]);
  });

  it("orders sequence numbers within one epoch before wall-clock timestamps", async () => {
    const cwd = await workspace();
    const store = new DurableEventStore();
    await store.append(cwd, "session-clock", record("epoch-clock:2", "2026-07-23T00:00:00.000Z", "second"));
    await store.append(cwd, "session-clock", record("epoch-clock:1", "2026-07-23T00:00:10.000Z", "first"));
    expect((await store.readAfter(cwd, "session-clock")).map((item) => item.id)).toEqual(["epoch-clock:1", "epoch-clock:2"]);
  });

  it("emits a stream gap instead of blindly replaying deltas for a missing cursor", async () => {
    const cwd = await workspace();
    const store = new DurableEventStore();
    await store.append(cwd, "session-gap", record("epoch-gap:9", "2026-07-23T00:00:00.000Z", "unsafe delta"));
    const replay = await store.readAfter(cwd, "session-gap", "epoch-gap:1");
    expect(replay).toHaveLength(1);
    expect(replay[0]?.event).toBe("stream.gap");
    expect(JSON.parse(replay[0]!.data)).toMatchObject({ type: "stream.gap", missingCursor: "epoch-gap:1" });
    expect(replay[0]?.data).not.toContain("unsafe delta");
  });

  it("does not fallback-write an already appended event when compaction fails", async () => {
    const cwd = await workspace();
    const sessionId = "session-compaction";
    const target = paths(cwd, sessionId);
    const store = new DurableEventStore({
      maxEventFileBytes: 1,
      compact: async () => { throw new Error("forced compaction failure"); },
    });
    await store.append(cwd, sessionId, record("epoch-compact:1", "2026-07-23T00:00:00.000Z", "kept once"));
    const primary = (await readFile(target.primary, "utf8")).trim().split("\n");
    expect(primary).toHaveLength(1);
    await expect(readFile(target.fallback, "utf8")).rejects.toThrow();
  });
});
