import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionQueueRepository } from "./session-queue-repository.js";
import { SessionQueueDispatcher, type QueueDispatchSessions, type QueueSessionFacts } from "./session-queue-dispatcher.js";

const cleanup: string[] = [];
const original = process.env.PI_SCIENCE_HOME;
const sessionId = "session-a";
const first = "8fd824aa-51d3-4f63-839c-09e021b7970b";
let cwd: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-queue-dispatch-"));
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

function sessions(facts: QueueSessionFacts, commandResult: { success: boolean; code?: string } = { success: true }) {
  const command = vi.fn(async () => commandResult);
  const state = vi.fn(async () => facts);
  return { sessions: { state, command } as unknown as QueueDispatchSessions, command, state };
}

describe("SessionQueueDispatcher", () => {
  it("waits for the running turn before handing the next message to the agent", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "next" });
    const fake = sessions({ is_streaming: true });
    const dispatcher = new SessionQueueDispatcher(fake.sessions, queue, 5);
    expect(await dispatcher.tick(cwd, sessionId)).toBe("busy");
    expect(fake.command).not.toHaveBeenCalled();
    expect((await queue.read(cwd, sessionId)).entries[0]?.status).toBe("queued");
    dispatcher.stop();
  });

  it("dispatches the head of the queue once the turn settles, reusing the entry id", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "next" });
    const fake = sessions({ is_streaming: false, pending_message_count: 0 });
    const dispatcher = new SessionQueueDispatcher(fake.sessions, queue, 5);
    expect(await dispatcher.tick(cwd, sessionId)).toBe("dispatched");
    expect(fake.command).toHaveBeenCalledWith(sessionId, cwd, "prompt", { message: "next", client_message_id: first });
    expect((await queue.read(cwd, sessionId)).entries[0]?.status).toBe("dispatched");
    dispatcher.stop();
  });

  it("returns a message to the queue when the agent is still busy", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "next" });
    const fake = sessions({ is_streaming: false }, { success: false, code: "session_busy" });
    const dispatcher = new SessionQueueDispatcher(fake.sessions, queue, 5);
    expect(await dispatcher.tick(cwd, sessionId)).toBe("requeued");
    expect((await queue.read(cwd, sessionId)).entries[0]).toMatchObject({ status: "queued", error_code: "session_busy" });
    dispatcher.stop();
  });

  it("marks a rejected dispatch as failed with its error code", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "next" });
    const fake = sessions({ is_streaming: false }, { success: false, code: "invalid_model" });
    const dispatcher = new SessionQueueDispatcher(fake.sessions, queue, 5);
    expect(await dispatcher.tick(cwd, sessionId)).toBe("failed");
    expect((await queue.read(cwd, sessionId)).entries[0]).toMatchObject({ status: "failed", error_code: "invalid_model" });
    dispatcher.stop();
  });

  it("does nothing while the queue is paused after a stop", async () => {
    const queue = new SessionQueueRepository();
    await queue.enqueue(cwd, sessionId, { id: first, text: "next" });
    await queue.pauseAfterStop(cwd, sessionId);
    const fake = sessions({ is_streaming: false });
    const dispatcher = new SessionQueueDispatcher(fake.sessions, queue, 5);
    expect(await dispatcher.tick(cwd, sessionId)).toBe("paused");
    expect(fake.command).not.toHaveBeenCalled();
    dispatcher.stop();
  });
});
