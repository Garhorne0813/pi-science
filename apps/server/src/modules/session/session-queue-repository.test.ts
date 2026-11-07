import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionQueueRepository } from "./session-queue-repository.js";

const cleanup: string[] = [];
const original = process.env.PI_SCIENCE_HOME;
const sessionId = "session-a";
const otherSessionId = "session-b";
const first = "8fd824aa-51d3-4f63-839c-09e021b7970b";
const second = "91d824aa-51d3-4f63-839c-09e021b7970b";
let cwd: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-queue-"));
  cleanup.push(root);
  process.env.PI_SCIENCE_HOME = join(root, "data");
  cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  if (original === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = original;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionQueueRepository", () => {
  it("keeps queue order and answers a replayed request with the stored entry", async () => {
    const queue = new SessionQueueRepository();
    const created = await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    await queue.enqueue(cwd, sessionId, { id: second, text: "second" });
    const replay = await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    const snapshot = await queue.read(cwd, sessionId);
    expect(created).toMatchObject({ ok: true, created: true });
    expect(replay).toMatchObject({
      ok: true,
      created: false,
      entry: { id: first, status: "queued" },
    });
    expect(snapshot.entries.map((entry) => [entry.id, entry.text, entry.status])).toEqual([
      [first, "first", "queued"],
      [second, "second", "queued"],
    ]);
  });

  it("rejects a reused request id with different content", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    expect(await queue.enqueue(cwd, sessionId, { id: first, text: "changed" })).toEqual({
      ok: false,
      code: "conflict",
    });
  });

  it("edits a queued entry and refuses one that already left the queue", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    expect(await queue.edit(cwd, sessionId, first, "edited")).toMatchObject({
      ok: true,
      entry: { text: "edited", status: "queued" },
    });
    await queue.claimNext(cwd, sessionId);
    expect(await queue.edit(cwd, sessionId, first, "too late")).toEqual({
      ok: false,
      code: "not_editable",
    });
  });

  it("cancels queued entries and never pretends a dispatched entry can be retracted", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    await queue.enqueue(cwd, sessionId, { id: second, text: "second" });
    expect(await queue.cancel(cwd, sessionId, first)).toMatchObject({
      ok: true,
      entry: { status: "cancelled" },
    });
    expect(await queue.cancel(cwd, sessionId, first)).toMatchObject({
      ok: true,
      entry: { status: "cancelled" },
    });
    const claimed = await queue.claimNext(cwd, sessionId);
    expect(claimed?.id).toBe(second);
    expect(await queue.cancel(cwd, sessionId, second)).toEqual({ ok: false, code: "not_editable" });
  });

  it("records dispatch outcomes and is durable across repository instances", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    const claimed = await queue.claimNext(cwd, sessionId);
    expect(claimed).toMatchObject({ id: first, status: "dispatching" });
    await queue.settle(cwd, sessionId, first, {
      status: "dispatched",
      delivered_message_id: "message-1",
    });
    const reopened = await new SessionQueueRepository().read(cwd, sessionId);
    expect(reopened.entries[0]).toMatchObject({
      status: "dispatched",
      delivered_message_id: "message-1",
    });
  });

  it("returns a failed entry to the head of the queue with its error kept", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    await queue.claimNext(cwd, sessionId);
    await queue.settle(cwd, sessionId, first, { status: "queued", error_code: "session_busy" });
    const snapshot = await queue.read(cwd, sessionId);
    expect(snapshot.entries[0]).toMatchObject({ status: "queued", error_code: "session_busy" });
  });

  it("stops dispatching after a stop until the user resumes", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    expect(await queue.pauseAfterStop(cwd, sessionId)).toMatchObject({
      paused: true,
      paused_reason: "stop",
    });
    expect(await queue.claimNext(cwd, sessionId)).toBeNull();
    expect(await queue.resume(cwd, sessionId)).toMatchObject({ paused: false });
    expect(await queue.claimNext(cwd, sessionId)).toMatchObject({
      id: first,
      status: "dispatching",
    });
  });

  it("leaves the queue running when a stop happens with nothing queued", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "first" });
    await queue.cancel(cwd, sessionId, first);
    expect(await queue.pauseAfterStop(cwd, sessionId)).toBeNull();
    expect((await queue.read(cwd, sessionId)).paused).toBe(false);
  });

  it("keeps sessions apart", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "for a" });
    await queue.enqueue(cwd, otherSessionId, { id: second, text: "for b" });
    expect((await queue.read(cwd, sessionId)).entries.map((entry) => entry.text)).toEqual([
      "for a",
    ]);
    expect((await queue.read(cwd, otherSessionId)).entries.map((entry) => entry.text)).toEqual([
      "for b",
    ]);
  });
});
